/**
 * Boat image retention (SLNT-787) against the fake Boat, with the worker's clock injected: the
 * saved images no workspace can use any more are removed once nothing has used them for the
 * bound, and the account's snapshot count (what the key report reads) falls. What a workspace
 * still needs is kept: a running one's, a stopped one's that can still be started, a standby's,
 * a build's in flight, a quarantine reopened for its next build. Another install's images,
 * another stored account's and a full check's snapshot in the same Boat account are not touched.
 * A lost reply to the delete and a crash between recording and issuing it both end with Core and
 * Boat agreeing, and an account being removed is left to its removal.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NativePublicationRepo,
  NativePublicationRepoLive,
  SealantDB,
  createSealantDB,
  schema,
  type DB,
  type NativePublicationRepoService,
} from "@sealant/db";
import { expireNativeClaim } from "@sealant/db/testing/native-publications";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import {
  boatLaunchSupport,
  newWorkspaceSchema,
  nativeArtifactConsumerSchema,
  type NativeArtifactConsumer,
  type NativePublicationKey,
  type NewWorkspace,
} from "@sealant/validators";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { FakeBoat } from "../../../boat-harness/fake-boat.js";
import { BOAT_REFUSALS } from "../../../boat-harness/refusals.js";
import { createWorkspaceBuildSpec } from "../../buildkit/docker-parity.fixture.js";
import { HttpBoatApi, type BoatApi } from "../../runtime/boat/api.js";
import { BoatSecret } from "../../runtime/boat/config.js";
import { observeBoatKey } from "../../runtime/boat/key-check.js";
import { reopenBoatQuarantine } from "../../runtime/boat/key-refresh.js";
import { nativeBuilderProbe } from "./builder.fixture.js";
import { BoatSnapshotBuilder, type IBoatSnapshotBuilder } from "./builder.js";
import {
  BoatNativeCatalog,
  NativeCatalogError,
  boatNativeCatalogLayer,
  type BoatNativeCatalogService,
} from "./catalog.js";
import { createNativeRecipe } from "./recipe.js";
import { NativeBuildError, VerifiedRuntimeBundle } from "./runtime-bundle.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
const bundleDirectory = process.env.SEALANT_BOAT_RUNTIME_BUNDLE;
const KEY = "boat_live_fixture_retention_key_07";
const DAY = 86_400_000;
/** The worker's default bounds: a stopped workspace's image for 14 days, any image for a day. */
const RESUME_DAYS = 14;
const MIN_AGE_HOURS = 24;

/** No guest runs here: the fake's VMs are records, and every docker call it makes succeeds. */
const docker = async (args: readonly string[]) => ({
  code: 0,
  stdout: args[0] === "inspect" ? "192.0.10.5\n" : "running\n",
  stderr: "",
  timedOut: false,
});

const loadBundle = async (directory: string) => {
  const bundle = VerifiedRuntimeBundle.parse({
    sourceIndex: await readFile(join(directory, "source-index.json")),
    platformManifest: await readFile(join(directory, "platform-manifest.json")),
    sealantd: await readFile(join(directory, "sealantd")),
    sealantctl: await readFile(join(directory, "sealantctl")),
  });
  if (!bundle.ok) throw bundle.error;
  return bundle.value;
};

/** An environment: the base spec with its own setup step, so each plans its own image. */
const environment = (name: string, account?: string): NewWorkspace => {
  const base = createWorkspaceBuildSpec({
    target: {
      os: { family: "ubuntu", mode: "require" },
      runtime: { family: "boat", mode: "require" },
    },
  });
  return {
    ...base,
    // A Boat workspace starts from a capture of its files (Mend's sessions), never a clone.
    sources: {
      ...base.sources,
      workspace: { kind: "capture", endpoint: "https://mend.example.invalid/capture" },
    },
    lifecycle: { ...base.lifecycle, setup: [{ run: `echo ${name}`, shell: "bash" }] },
    runtime: { ...base.runtime, ...(account === undefined ? {} : { boatAccountId: account }) },
  };
};

type Scope = NativePublicationKey["scope"];
const ownerOf = (scope: Scope) =>
  scope.kind === "owner" ? scope.ownerUserId : "usr_unused_domain";

interface Catalog {
  readonly deploymentId: string;
  readonly service: BoatNativeCatalogService;
  readonly owner: string;
}

interface Context {
  readonly db: DB;
  readonly boat: FakeBoat;
  readonly repo: NativePublicationRepoService;
  /** The install's own account's catalog, on the fake Boat's one key. */
  readonly catalog: Catalog;
  /** Another catalog over the same Boat account: a second stored account, or another install. */
  readonly other: () => Promise<Catalog>;
  readonly person: () => Promise<Scope>;
  /** A run that may pin an image. */
  readonly consumer: (scope: Scope) => Promise<NativeArtifactConsumer>;
  /** While set, every plan of the install's catalog fails, as a missing asset would make it. */
  readonly failPlans: { value: boolean };
  /** Builds an environment's image through the catalog; the run that built it holds it. */
  readonly build: (
    spec: NewWorkspace,
    scope: Scope,
    on?: Catalog,
  ) => Promise<{ readonly publicationId: string; readonly pin: NativeArtifactConsumer }>;
  readonly release: (pin: NativeArtifactConsumer, publicationId: string) => Promise<void>;
  /** A workspace whose latest launch was this spec, in this state, last changed at `changedAt`. */
  readonly workspace: (input: {
    readonly spec: NewWorkspace;
    readonly scope: Scope;
    readonly status: "queued" | "running" | "ready" | "stopped" | "failed";
    readonly changedAt?: Date;
    readonly job?: "queued" | "running" | "succeeded" | "failed";
    readonly binds?: readonly { readonly mountPath: string; readonly subpath: string }[];
    /** The runtime its latest launch resolved to; absent, none is recorded (not launched yet). */
    readonly adapter?: "boat" | "docker";
  }) => Promise<string>;
  /** Whether Boat's builder plans this spec at all. */
  readonly plans: (spec: NewWorkspace) => Promise<boolean>;
  /** One retention pass at `at`, with the worker's default bounds, every page. */
  readonly reap: (
    at: Date,
    on?: Catalog,
  ) => Promise<readonly { readonly id: string; readonly outcome: string; readonly code: string }[]>;
  readonly state: (publicationId: string) => Promise<string | undefined>;
  readonly snapshotOf: (publicationId: string) => Promise<string>;
  /** What the account's key report reads: saved snapshots used. */
  readonly used: () => Promise<number>;
}

const withRetention = (body: (c: Context) => Promise<void>) =>
  withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
    const bundle = await loadBundle(bundleDirectory ?? "");
    const planned = await createNativeRecipe(environment("manifest"), bundle);
    if (!planned.ok) throw planned.error;
    const manifest = planned.value.agentManifestDigest;
    const boat = new FakeBoat({
      runId: `ret${randomUUID().slice(0, 8)}`,
      credential: KEY,
      network: "unit",
      baseImage: "unit-base",
      docker,
      deletionWithdrawnMs: 20,
    });
    await boat.start();
    const db = await createSealantDB(url);
    const journals: string[] = [];
    const runtimes: { dispose: () => Promise<void> }[] = [];
    try {
      const credential = BoatSecret.parse(KEY);
      if (!credential.ok) throw credential.error;
      const opened = HttpBoatApi.create({
        credential: credential.value,
        baseUrl: boat.baseUrl,
        timeoutMs: 5_000,
      });
      if (!opened.ok) throw opened.error;
      const client = opened.value;
      // Boat's own calls go to the fake; the guest's (commands, files) are answered here, as an
      // installed image would answer them.
      const api: BoatApi = {
        create: client.create.bind(client),
        discover: client.discover.bind(client),
        get: client.get.bind(client),
        execute: async (_id, command) => ({
          ok: true,
          value: {
            exitCode: 0,
            timedOut: false,
            stderr: "",
            stdout: command.endsWith("cat /etc/sealant/image-probe.json")
              ? JSON.stringify(nativeBuilderProbe)
              : command.endsWith("cat /var/lib/sealant/agent/manifest.json")
                ? JSON.stringify({ digest: manifest })
                : "",
          },
        }),
        writeFile: async () => ({ ok: true, value: undefined }),
        uploadFile: async () => ({ ok: true, value: undefined }),
        hostControl: client.hostControl.bind(client),
        stop: client.stop.bind(client),
        resume: client.resume.bind(client),
        deleteSandbox: client.deleteSandbox.bind(client),
        getDeletion: client.getDeletion.bind(client),
        saveSnapshot: client.saveSnapshot.bind(client),
        getSnapshot: client.getSnapshot.bind(client),
        deleteSnapshot: client.deleteSnapshot.bind(client),
      };
      const Db = Layer.succeed(SealantDB, db);
      const repos = ManagedRuntime.make(NativePublicationRepoLive.pipe(Layer.provide(Db)));
      runtimes.push(repos);
      const repo = await repos.runPromise(NativePublicationRepo);
      const failPlans = { value: false };
      const makeCatalog = async (deploymentId: string, plans = false): Promise<Catalog> => {
        const directory = await mkdtemp(join(tmpdir(), "core4-retention-journals-"));
        journals.push(directory);
        const owner = randomUUID();
        const builder = new BoatSnapshotBuilder({
          api,
          runtimeBundle: bundle,
          journalDirectory: directory,
          owner,
          pollIntervalMs: 5,
          cleanupTimeoutMs: 5_000,
        });
        const wrapped: IBoatSnapshotBuilder = {
          plan: (spec) =>
            plans && failPlans.value
              ? Promise.resolve({ ok: false, error: new NativeBuildError("native-invalid-recipe") })
              : builder.plan(spec),
          build: (input) => builder.build(input),
          findPublished: (input) => builder.findPublished(input),
          remove: (artifact) => builder.remove(artifact),
          cleanup: (path) => builder.cleanup(path),
          journals: (input) => builder.journals(input),
          reconcileBuild: (ownership, expected) => builder.reconcileBuild(ownership, expected),
        };
        const runtime = ManagedRuntime.make(
          boatNativeCatalogLayer({ deploymentId, builder: wrapped }).pipe(Layer.provide(Db)),
        );
        runtimes.push(runtime);
        return { deploymentId, owner, service: await runtime.runPromise(BoatNativeCatalog) };
      };
      const catalog = await makeCatalog(`sealant-install-${randomUUID()}`, true);
      const planner = new BoatSnapshotBuilder({
        api,
        runtimeBundle: bundle,
        journalDirectory: journals[0] ?? "",
        owner: catalog.owner,
      });
      const person = async (): Promise<Scope> => {
        const id = `usr_retention_${randomUUID()}`;
        await Effect.runPromise(
          db.insert(schema.user).values({ id, email: `${id}@example.invalid`, name: id }),
        );
        return { kind: "owner", ownerUserId: id };
      };
      const consumer = async (scope: Scope) => {
        const runId = randomUUID();
        await Effect.runPromise(
          db.insert(schema.workspaceAttempts).values({ id: runId, ownerUserId: ownerOf(scope) }),
        );
        return nativeArtifactConsumerSchema.parse({ runId, runtimeInstanceId: runId });
      };
      const pages = async (at: Date, on: Catalog) => {
        const entries: { id: string; outcome: string; code: string }[] = [];
        let after: string | undefined;
        do {
          const page = await Effect.runPromise(
            on.service.reap({
              stoppedSince: new Date(at.getTime() - RESUME_DAYS * DAY),
              unusedSince: new Date(at.getTime() - MIN_AGE_HOURS * 3_600_000),
              limit: 3,
              ...(after === undefined ? {} : { after }),
            }),
          );
          entries.push(...page.entries);
          after = page.next;
        } while (after !== undefined);
        return entries;
      };
      await body({
        db,
        boat,
        repo,
        catalog,
        other: () => makeCatalog(`sealant-account-${randomUUID()}`),
        person,
        consumer,
        failPlans,
        build: async (spec, scope, on = catalog) => {
          const pin = await consumer(scope);
          const published = await Effect.runPromise(
            on.service.acquire({ spec, scope, consumer: pin }),
          );
          return { publicationId: published.publicationId, pin };
        },
        release: (pin, publicationId) =>
          Effect.runPromise(catalog.service.release(pin, publicationId)),
        workspace: async (input) => {
          const runId = randomUUID();
          const workspaceId = randomUUID();
          const changedAt = input.changedAt ?? new Date();
          await Effect.runPromise(
            db
              .insert(schema.workspaceAttempts)
              .values({ id: runId, ownerUserId: ownerOf(input.scope) }),
          );
          await Effect.runPromise(
            db.insert(schema.workspaces).values({
              id: workspaceId,
              ownerUserId: ownerOf(input.scope),
              status: input.status,
              latestRunId: runId,
              binds: [...(input.binds ?? [])],
              createdAt: changedAt,
              updatedAt: changedAt,
            }),
          );
          await Effect.runPromise(
            db.insert(schema.ociImageBuildJobs).values({
              id: randomUUID(),
              runId,
              status: input.job ?? "succeeded",
              registryId: "boat",
              repository: "boat",
              tag: runId,
              imageScope: input.scope,
              requestPayload: input.spec,
            }),
          );
          if (input.adapter !== undefined)
            await Effect.runPromise(
              db.insert(schema.workspaceRuntimeInstances).values({
                runId,
                status: input.status === "stopped" ? "stopped" : "running",
                adapter: input.adapter,
              }),
            );
          return workspaceId;
        },
        reap: (at, on = catalog) => pages(at, on),
        plans: async (spec) => (await planner.plan(spec)).ok,
        state: async (id) => (await Effect.runPromise(repo.get(id)))?.state,
        snapshotOf: async (id) => {
          const record = await Effect.runPromise(repo.get(id));
          if (record?.publication === null || record?.publication === undefined)
            throw new Error("no publication");
          return record.publication.snapshot.identity.name;
        },
        used: async () => {
          const observed = await observeBoatKey(client, { organization: null });
          if (observed.kind !== "report" || !observed.report.snapshots.observed)
            throw new Error("the key report did not read the snapshot allowance");
          return observed.report.snapshots.used;
        },
      });
    } finally {
      for (const runtime of runtimes.toReversed()) await runtime.dispose();
      await boat.stop();
      for (const directory of journals) {
        await readdir(directory);
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

/** A snapshot the fake Boat holds that this install's database knows nothing of. */
const foreignSnapshot = (boat: FakeBoat, name: string) =>
  boat.snapshots.set(name, {
    name,
    sourceSandboxId: "bx_3456789a",
    snapshotId: randomUUID(),
    createdAt: new Date(0).toISOString(),
    image: `unit-${name}`,
    dockerData: `unit-${name}-docker`,
    status: "ready",
  });

const later = (days: number) => new Date(Date.now() + days * DAY);

describe.skipIf(databaseUrl === undefined || bundleDirectory === undefined)(
  "Boat image retention (fake Boat, injected clock)",
  { timeout: 120_000 },
  () => {
    it("removes the images no workspace can use once nothing used them for a day, and the count falls", () =>
      withRetention(async (c) => {
        const person = await c.person();
        // `current` is what this person's workspaces start from now. `old` was the environment
        // before it changed, and its only workspace stopped 20 days ago. `replaced` was the image
        // of a workspace whose latest launch moved to `current`.
        const current = await c.build(environment("current"), person);
        const old = await c.build(environment("old"), person);
        const replaced = await c.build(environment("replaced"), person);
        for (const each of [current, old, replaced]) await c.release(each.pin, each.publicationId);
        await c.workspace({ spec: environment("current"), scope: person, status: "stopped" });
        await c.workspace({
          spec: environment("old"),
          scope: person,
          status: "stopped",
          changedAt: new Date(Date.now() - 20 * DAY),
        });
        const before = await c.used();
        expect(before).toBe(3);

        // Now: each was used a moment ago, so nothing is removed yet.
        const now = await c.reap(new Date());
        expect(now.filter((entry) => entry.outcome === "updated")).toEqual([]);
        expect(await c.used()).toBe(3);

        // Two days on: the two images nothing can start from are removed, in Boat and in Core.
        const oldName = await c.snapshotOf(old.publicationId);
        const replacedName = await c.snapshotOf(replaced.publicationId);
        const pass = await c.reap(later(2));
        expect(pass).toEqual(
          expect.arrayContaining([
            { id: old.publicationId, outcome: "updated", code: "removed" },
            { id: replaced.publicationId, outcome: "updated", code: "removed" },
            { id: current.publicationId, outcome: "skipped", code: "retained" },
          ]),
        );
        expect(await c.state(old.publicationId)).toBe("removed");
        expect(await c.state(replaced.publicationId)).toBe("removed");
        expect(await c.state(current.publicationId)).toBe("ready");
        expect(c.boat.snapshots.has(oldName)).toBe(false);
        expect(c.boat.snapshots.has(replacedName)).toBe(false);
        expect(await c.used()).toBe(1);

        // A later launch of the old environment builds it again.
        const again = await c.build(environment("old"), person);
        expect(again.publicationId).not.toBe(old.publicationId);
        expect(await c.state(again.publicationId)).toBe("ready");
      }));

    it("keeps a running workspace's, a resumable one's, a standby's, a build's in flight, and a reopened quarantine", () =>
      withRetention(async (c) => {
        const person = await c.person();
        const building = await c.person();
        // Running: its run holds the image (the pin is live).
        const running = await c.build(environment("running"), person);
        await Effect.runPromise(
          c.catalog.service.markConsumer(running.pin, running.publicationId, "live"),
        );
        await c.workspace({ spec: environment("running"), scope: person, status: "ready" });
        // Stopped ten days ago and not archived: it starts again from this image.
        const resumable = await c.build(environment("resumable"), person);
        await c.release(resumable.pin, resumable.publicationId);
        await c.workspace({
          spec: environment("resumable"),
          scope: person,
          status: "stopped",
          changedAt: new Date(Date.now() - 10 * DAY),
        });
        // A standby: a ready workspace with binds, its run holding the image.
        const standby = await c.build(environment("standby"), person);
        await Effect.runPromise(
          c.catalog.service.markConsumer(standby.pin, standby.publicationId, "live"),
        );
        await c.workspace({
          spec: environment("standby"),
          scope: person,
          status: "ready",
          binds: [{ mountPath: "/workspace", subpath: "pool" }],
        });
        // A build in flight: its job runs for a scope whose workspace is not written yet (the
        // create's transaction), so no wanted key names it; nothing of that scope goes meanwhile.
        const inFlight = await c.build(environment("in-flight"), building);
        await c.release(inFlight.pin, inFlight.publicationId);
        const runId = randomUUID();
        await Effect.runPromise(
          c.db.insert(schema.workspaceAttempts).values({
            id: runId,
            ownerUserId: building.kind === "owner" ? building.ownerUserId : "",
          }),
        );
        await Effect.runPromise(
          c.db.insert(schema.ociImageBuildJobs).values({
            id: randomUUID(),
            runId,
            status: "running",
            registryId: "boat",
            repository: "boat",
            tag: runId,
            imageScope: building,
            requestPayload: environment("in-flight"),
          }),
        );
        // Quarantined for billing, then reopened (the wallet was funded): its next launch builds.
        c.boat.faults = {
          refuse: (call) =>
            call.method === "POST" && call.path === "/sandboxes"
              ? BOAT_REFUSALS["billing-required"]
              : undefined,
        };
        const refused = await Effect.runPromise(
          Effect.flip(
            c.catalog.service.acquire({
              spec: environment("reopened"),
              scope: person,
              consumer: await c.consumer(person),
            }),
          ),
        );
        c.boat.faults = {};
        const quarantined =
          refused instanceof NativeCatalogError ? refused.publicationId : undefined;
        if (quarantined === undefined) throw new Error("no quarantined build");
        // Boat refused its cleanup's replay too; the journal sweep finishes it now Boat answers.
        expect((await Effect.runPromise(c.repo.get(quarantined)))?.reason).toMatch(
          /^native-(cleanup-pending-)?boat-billing-required$/,
        );
        await Effect.runPromise(c.catalog.service.reconcile({ limit: 50 }));
        expect((await Effect.runPromise(c.repo.get(quarantined)))?.reason).toBe(
          "native-boat-billing-required",
        );
        expect(await reopenBoatQuarantine(c.db, c.catalog.deploymentId)).toBe(1);
        // A control: an image nothing holds or wants, removed by the same pass.
        const unused = await c.build(environment("unused"), person);
        await c.release(unused.pin, unused.publicationId);

        const pass = await c.reap(later(2));
        for (const kept of [running, resumable, standby, inFlight])
          expect(await c.state(kept.publicationId)).toBe("ready");
        expect(pass).toContainEqual({
          id: unused.publicationId,
          outcome: "updated",
          code: "removed",
        });
        // The reopened quarantine is not an image: left as it is, and its next launch builds it.
        const reopened = await Effect.runPromise(c.repo.get(quarantined));
        expect(reopened?.state).toBe("quarantined");
        expect(reopened?.reopenedAt).not.toBeNull();
        expect(await c.used()).toBe(4);
        const rebuilt = await c.build(environment("reopened"), person);
        expect(rebuilt.publicationId).not.toBe(quarantined);
        expect(await c.state(rebuilt.publicationId)).toBe("ready");
        expect(await c.used()).toBe(5);
      }));

    it("counts only Boat workspaces: Docker ones Boat refuses neither count nor stop the pass", () =>
      withRetention(async (c) => {
        const person = await c.person();
        // The install's own account, beside Docker: every create has an image scope, Docker or not.
        const wanted = await c.build(environment("boat-wanted"), person);
        const unused = await c.build(environment("boat-unused"), person);
        for (const each of [wanted, unused]) await c.release(each.pin, each.publicationId);
        await c.workspace({
          spec: environment("boat-wanted"),
          scope: person,
          status: "stopped",
          adapter: "boat",
        });
        const base = createWorkspaceBuildSpec();
        // The Boat environments here are ones Boat launches.
        expect(boatLaunchSupport(environment("boat-wanted")).supported).toBe(true);
        const customImage: NewWorkspace = {
          ...base,
          target: {
            runtime: { family: "auto", mode: "prefer" },
            os: { family: "custom", mode: "require", baseImage: "docker.io/library/ubuntu:24.04" },
          },
        };
        const arch: NewWorkspace = {
          ...base,
          target: {
            runtime: { family: "auto", mode: "prefer" },
            os: { family: "arch", mode: "require" },
          },
        };
        const hostDirectories: NewWorkspace = {
          ...base,
          sources: {
            ...base.sources,
            mounts: [
              {
                hostPath: "/srv/projects",
                mountPath: "/projects",
                readOnly: true,
                bindable: false,
              },
            ],
          },
        };
        for (const spec of [customImage, arch, hostDirectories]) {
          expect(newWorkspaceSchema.safeParse(spec).success).toBe(true);
          expect(boatLaunchSupport(spec).supported).toBe(false);
        }
        // Boat's planner refuses the first two: counted, either would stop the whole pass.
        expect(await c.plans(customImage)).toBe(false);
        expect(await c.plans(arch)).toBe(false);
        await c.workspace({ spec: customImage, scope: person, status: "ready", adapter: "docker" });
        await c.workspace({ spec: arch, scope: person, status: "stopped", adapter: "docker" });
        // Failed before any runtime was chosen: no adapter recorded, and Boat refuses its spec.
        await c.workspace({ spec: hostDirectories, scope: person, status: "failed" });

        const pass = await c.reap(later(2));
        expect(pass).toEqual(
          expect.arrayContaining([
            { id: unused.publicationId, outcome: "updated", code: "removed" },
            { id: wanted.publicationId, outcome: "skipped", code: "retained" },
          ]),
        );
        expect(await c.state(wanted.publicationId)).toBe("ready");
        expect(await c.used()).toBe(1);
      }));

    it("leaves another install's images, another account's and a full check's snapshot alone", () =>
      withRetention(async (c) => {
        const person = await c.person();
        const mine = await c.build(environment("mine"), person);
        await c.release(mine.pin, mine.publicationId);
        // A second stored account over the same Boat account: its own deployment, its own image.
        const second = await c.other();
        const theirs = await c.build(environment("theirs"), person, second);
        await Effect.runPromise(second.service.release(theirs.pin, theirs.publicationId));
        const theirsName = await c.snapshotOf(theirs.publicationId);
        // Another install's image (its own deployment and database), and a full check's snapshot.
        foreignSnapshot(c.boat, `sealant-dev-boat-stream-${randomUUID().replaceAll("-", "")}`);
        foreignSnapshot(c.boat, `sealant-key-proof-${randomUUID().slice(0, 8)}`);
        const mineName = await c.snapshotOf(mine.publicationId);
        const others = [...c.boat.snapshots.keys()].filter((name) => name !== mineName);
        expect(await c.used()).toBe(4);

        const pass = await c.reap(later(2));
        expect(pass).toEqual([{ id: mine.publicationId, outcome: "updated", code: "removed" }]);
        expect(c.boat.snapshots.has(mineName)).toBe(false);
        expect(c.boat.snapshots.has(theirsName)).toBe(true);
        expect(await c.state(theirs.publicationId)).toBe("ready");
        expect([...c.boat.snapshots.keys()].toSorted()).toEqual(others.toSorted());
        expect(await c.used()).toBe(3);
      }));

    it("a lost reply to the delete, and a crash between recording and issuing it, end with Core and Boat agreeing", () =>
      withRetention(async (c) => {
        const person = await c.person();
        const lost = await c.build(environment("lost"), person);
        const crashed = await c.build(environment("crashed"), person);
        for (const each of [lost, crashed]) await c.release(each.pin, each.publicationId);
        const lostName = await c.snapshotOf(lost.publicationId);
        const crashedName = await c.snapshotOf(crashed.publicationId);
        const at = later(2);
        const policy = { wanted: [], unusedSince: new Date(at.getTime() - DAY) };

        // The crash: the removal is recorded (retiring) and claimed, and the process dies before
        // it asks Boat for anything. Boat still holds the image; Core no longer launches on it.
        expect((await Effect.runPromise(c.repo.retire(crashed.publicationId, policy)))?.state).toBe(
          "retiring",
        );
        expect(
          await Effect.runPromise(c.repo.claim(crashed.publicationId, "remove", 60_000)),
        ).toBeDefined();
        expect(c.boat.snapshots.has(crashedName)).toBe(true);

        // The lost reply: Boat deletes the image and the reply never arrives.
        c.boat.faults = {
          snapshotDeleteReply: (name) => (name === lostName ? "lose" : undefined),
        };
        const first = await c.reap(at);
        expect(first).toEqual(
          expect.arrayContaining([
            { id: lost.publicationId, outcome: "obligation", code: expect.any(String) },
            { id: crashed.publicationId, outcome: "skipped", code: "active-claim" },
          ]),
        );
        c.boat.faults = {};
        // Boat has deleted it; Core holds it as a removal still pending, never as an image to use.
        expect(c.boat.snapshots.has(lostName)).toBe(false);
        expect(await c.state(lost.publicationId)).toBe("quarantined");
        // A launch of that environment meanwhile waits, as for a build in progress: its build job
        // tries again on `publication-pending`, and no person reads a store error.
        const waiting = await c.consumer(person);
        const launch = () =>
          Effect.runPromise(
            c.catalog.service.acquire({
              spec: environment("lost"),
              scope: person,
              consumer: waiting,
            }),
          );
        await expect(launch()).rejects.toMatchObject({
          code: "publication-pending",
          detail: "native-publication-removing",
        });

        // The crashed claim lapses; the next pass finishes both.
        await Effect.runPromise(expireNativeClaim(c.db, crashed.publicationId));
        const second = await c.reap(at);
        expect(second).toEqual(
          expect.arrayContaining([
            { id: lost.publicationId, outcome: "updated", code: "removed" },
            { id: crashed.publicationId, outcome: "updated", code: "removed" },
          ]),
        );
        expect(await c.state(lost.publicationId)).toBe("removed");
        expect(await c.state(crashed.publicationId)).toBe("removed");
        // The waiting launch, tried again, builds the image anew.
        const rebuilt = await launch();
        expect(rebuilt.publicationId).not.toBe(lost.publicationId);
        expect(await c.state(rebuilt.publicationId)).toBe("ready");
        expect(c.boat.snapshots.has(crashedName)).toBe(false);
        expect(
          c.boat.events.filter(
            (event) => event.kind === "snapshot-deleted" && event.detail === lostName,
          ),
        ).toHaveLength(1);
      }));

    it("leaves an account being removed to its own removal", () =>
      withRetention(async (c) => {
        const person = await c.person();
        const image = await c.build(environment("removing"), person);
        await c.release(image.pin, image.publicationId);
        await Effect.runPromise(
          c.db.insert(schema.boatAccounts).values({
            id: randomUUID(),
            label: "being removed",
            deploymentId: c.catalog.deploymentId,
            builderOwner: c.catalog.owner,
            sealedKey: "sealed",
            keyId: "key",
            // An organization's key, as the images were built naming no wallet: a resolved account.
            keyKind: "organization",
            removalRequestedAt: new Date(),
          }),
        );
        const pass = await c.reap(later(2));
        expect(pass).toEqual([{ id: image.publicationId, outcome: "skipped", code: "retained" }]);
        expect(await c.state(image.publicationId)).toBe("ready");
        expect(await c.used()).toBe(1);
      }));

    it("removes nothing in a pass where a workspace's spec cannot be planned", () =>
      withRetention(async (c) => {
        const person = await c.person();
        const image = await c.build(environment("unplanned"), person);
        await c.release(image.pin, image.publicationId);
        await c.workspace({ spec: environment("elsewhere"), scope: person, status: "stopped" });
        c.failPlans.value = true;
        await expect(c.reap(later(2))).rejects.toBeDefined();
        expect(await c.state(image.publicationId)).toBe("ready");
        c.failPlans.value = false;
        expect(await c.reap(later(2))).toEqual([
          { id: image.publicationId, outcome: "updated", code: "removed" },
        ]);
      }));
  },
);
