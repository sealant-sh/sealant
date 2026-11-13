import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { CredentialCipherService } from "@sealant/credentials";
import {
  BoatAccountRepo,
  BoatAccountRepoLive,
  BoatRunRepo,
  BoatRunRepoLive,
  NativePublicationRepo,
  NativePublicationRepoLive,
  SealantDB,
  boatAccountBuilderOwner,
  makeSealantDBLayer,
  schema,
  user,
  workspaceAttempts,
  type DB,
} from "@sealant/db";
import {
  boatRunSeedRows,
  recordBoatRunStopped,
  requestBoatRunStop,
} from "@sealant/db/testing/boat-runs";
import { nativeConsumerRows } from "@sealant/db/testing/native-publications";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import {
  nativeArtifactConsumerSchema,
  nativePublicationEvidenceSchema,
  nativePublicationSchema,
  nativeSnapshotArtifactSchema,
  newWorkspaceSchema,
  type NativeBuildOwnership,
  type NativePublication,
} from "@sealant/validators";
import { parseWorkerEnv } from "@sealant/validators/env";
import {
  BOAT_LAUNCH_REPORT_FRESH_MS,
  BoatAccountDirectory,
  BoatApiError,
  HttpBoatApi,
  boatLaunchRefusal,
  boatLaunchSupportOf,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  type BoatClientFactory,
} from "@sealant/workspaces";
import { FakeBoat } from "@sealant/workspaces/testing/fake-boat";
import { RecordedBoat } from "@sealant/workspaces/testing/recorded-boat";
import { Context, Effect, Exit, Layer, Result, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { assembleBoat, type BoatSnapshotBuilderFactory } from "./boat-assembly.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

/** Fixture keys only: each opens a client on one recorded Boat, as one real Boat account would. */
const DEFAULT_KEY = "default-account-key-for-tests";
const KEY_A = "account-a-key-for-tests-only";
const KEY_A_ROTATED = "account-a-rotated-key-for-tests";
const KEY_B = "account-b-key-for-tests-only";
const DEFAULT_DEPLOYMENT = "install-default";

const cipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

const hex = (digit: string) => digit.repeat(64);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const runtimeIdentity = {
  source: `ghcr.io/sealant-sh/sealantd-next:0.0.0-test@sha256:${hex("1")}`,
  platform: "linux/amd64" as const,
  manifest: hex("2"),
  sealantd: hex("3"),
  sealantctl: hex("4"),
};
const imageProbe = {
  version: 1 as const,
  tools: {
    sudo: true,
    sudoSetuid: true,
    useradd: true,
    groupadd: true,
    setfacl: true,
    getfacl: true,
    setpriv: true,
  },
  sudoersMend: false,
  sudoersIncludesDir: true,
  noNewPrivileges: false,
  passwdWritable: true,
  mendGroup: "absent" as const,
  reservedIdsInUse: [],
  personEnv: false,
  sharedDirs: [],
  sealantd: null,
};

/** A saved image as a builder reports it, owned by `owner` and named for its build. */
const builtImage = (owner: string, buildId: string, ownership?: NativeBuildOwnership) => {
  // The installation receipt names everything the catalog checks a publication against.
  const receipt = JSON.stringify({
    version: 4,
    agent: { manifestDigest: hex("7") },
    ownership,
    owner,
    build: buildId,
    recipeHash: hex("5"),
    assetsHash: hex("6"),
    runtime: runtimeIdentity,
    probe: imageProbe,
  });
  return {
    artifact: nativeSnapshotArtifactSchema.parse({
      kind: "boat-saved-snapshot",
      owner,
      build: buildId,
      recipeHash: hex("5"),
      receiptHash: sha256(receipt),
      runtime: runtimeIdentity,
      identity: {
        name: `sealant-test-${buildId.slice(0, 8)}`,
        sourceSandboxId: "bx_23456789",
        createdAt: new Date().toISOString(),
      },
    }),
    evidence: nativePublicationEvidenceSchema.parse({
      imageProbe,
      receiptHash: sha256(receipt),
      receipt,
      runtime: runtimeIdentity,
      assetsHash: hex("6"),
      recipeHash: hex("5"),
      daemonRecovery: "supported",
      executorRecovery: "unverified",
    }),
  };
};

const unused = async (): Promise<never> => {
  throw new Error("not asked of this builder in these tests");
};

/** One builder per account the worker made one for: whose images, where, and what it was asked. */
interface MadeBuilder {
  readonly owner: string;
  readonly journalDirectory: string;
  readonly built: string[];
  readonly removed: string[];
}

/** A builder that saves no image in Boat: it answers as the real one does, and records each ask. */
const recordingBuilders =
  (made: MadeBuilder[]): BoatSnapshotBuilderFactory =>
  async (options) => {
    const record: MadeBuilder = {
      owner: options.owner,
      journalDirectory: options.journalDirectory,
      built: [],
      removed: [],
    };
    made.push(record);
    return {
      plan: async () => ({
        ok: true,
        value: {
          recipeHash: hex("5"),
          runtime: runtimeIdentity,
          assetsHash: hex("6"),
          platform: "linux/amd64",
        },
      }),
      build: async (input) => {
        const image = builtImage(
          options.owner,
          input.ownership?.buildId ?? randomUUID(),
          input.ownership,
        );
        record.built.push(image.artifact.identity.name);
        return { ok: true, value: { outcome: "built", ...image } };
      },
      findPublished: unused,
      remove: async (artifact) => {
        record.removed.push(artifact.identity.name);
        return { ok: true, value: "deleted" };
      },
      cleanup: unused,
      journals: async () => ({ ok: true, value: { entries: [], failures: [] } }),
      reconcileBuild: unused,
    };
  };

/** A Boat workspace as a create stores it, in the account it names. */
const boatWorkspace = (boatAccountId?: string) =>
  newWorkspaceSchema.parse({
    sources: { workspace: { kind: "capture", endpoint: "https://mend.example.com/session/s1" } },
    harness: { id: "claude-code" },
    target: {
      os: { family: "ubuntu", mode: "require" },
      runtime: { family: "boat", mode: "require" },
    },
    runtime: {
      resources: "none",
      ...(boatAccountId === undefined ? {} : { boatAccountId }),
    },
  });

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const sandboxId = () =>
  `bx_${Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("")}`;

const neverStops = async (): Promise<never> => {
  throw new Error("no shared stop is expected here");
};

interface Context {
  readonly db: DB;
  readonly boats: {
    readonly fallback: RecordedBoat;
    readonly a: RecordedBoat;
    readonly b: RecordedBoat;
  };
  readonly accounts: { readonly a: string; readonly b: string };
  readonly deployments: { readonly a: string; readonly b: string };
  readonly builders: MadeBuilder[];
  readonly state: string;
  readonly boat: NonNullable<Awaited<ReturnType<typeof assembleBoat>>>;
  readonly repo: <A, E>(
    effect: Effect.Effect<A, E, BoatAccountRepo | BoatRunRepo | NativePublicationRepo>,
  ) => Promise<A>;
  readonly clientFor: BoatClientFactory;
  /** Assembles another worker's Boat on the same database, with these settings beside the cipher. */
  readonly assemble: (
    env: Record<string, string>,
  ) => Promise<NonNullable<Awaited<ReturnType<typeof assembleBoat>>>>;
  readonly owner: string;
  /**
   * One Boat run of an account with its VM in that account's Boat, as a launch leaves it: bound,
   * nothing pushed to it, its publication pin live. `stopping`: its stop was asked.
   */
  readonly seedRun: (input: {
    readonly accountId?: string;
    readonly deploymentId: string;
    readonly boat: RecordedBoat;
    readonly stopping?: boolean;
    /** A create issued with no VM on record yet: what the VM sweep resolves. */
    readonly issuedOnly?: boolean;
    /** The account's image it launched from; absent, an image no catalog holds. */
    readonly image?: NativePublication;
  }) => Promise<{ readonly runId: string; readonly sandboxId: string }>;
}

/** The settings of an install that set every Boat name itself, as installs did before. */
const EXPLICIT_ENV = {
  SEALANT_BOAT_API_KEY: DEFAULT_KEY,
  SEALANT_BOAT_DEPLOYMENT_ID: DEFAULT_DEPLOYMENT,
  SEALANT_BOAT_BUILDER_OWNER: "11111111-2222-4333-8444-555555555555",
};

const withAccounts = async (
  run: (context: Context) => Promise<void>,
  /** The worker's Boat settings beside the cipher and the state directory. */
  settings: Record<string, string> = EXPLICIT_ENV,
) => {
  if (DATABASE_URL === undefined) throw new Error("SEALANT_TEST_DATABASE_URL required");
  await withWorkspaceJobTestDatabase(DATABASE_URL, async (url) => {
    const scope = await Effect.runPromise(Scope.make());
    const fallback = new RecordedBoat();
    const a = new RecordedBoat();
    const b = new RecordedBoat();
    const state = await mkdtemp(join(tmpdir(), "boat-accounts-"));
    let boat: Context["boat"] | undefined;
    const others: Context["boat"][] = [];
    try {
      const built = await Effect.runPromise(Layer.buildWithScope(makeSealantDBLayer(url), scope));
      const db = Context.get(built, SealantDB);
      const atA = await a.listen();
      // The rotated key is another key for the same Boat account: the same recorded Boat.
      const urls = new Map([
        [DEFAULT_KEY, await fallback.listen()],
        [KEY_A, atA],
        [KEY_A_ROTATED, atA],
        [KEY_B, await b.listen()],
      ]);
      const clientFor: BoatClientFactory = (credential) => {
        const baseUrl = urls.get(credential.reveal());
        return baseUrl === undefined
          ? { ok: false, error: new BoatApiError("credential", 401, "unauthorized") }
          : HttpBoatApi.create({ credential, baseUrl, timeoutMs: 5_000 });
      };
      const repo = <A, E>(
        effect: Effect.Effect<A, E, BoatAccountRepo | BoatRunRepo | NativePublicationRepo>,
      ) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provide(
              Layer.mergeAll(BoatAccountRepoLive, BoatRunRepoLive, NativePublicationRepoLive),
            ),
            Effect.provideService(SealantDB, db),
          ),
        );
      const store = (label: string, key: string) =>
        repo(
          Effect.flatMap(BoatAccountRepo, (accounts) =>
            accounts.create({
              id: randomUUID(),
              label,
              sealedKey: `sealed:${key}`,
              keyId: "k-test",
              // The recorded Boat keeps no wallets apart: an organization's key, one wallet.
              keyKind: "organization",
            }),
          ),
        );
      const accountA = await store("Organization A", KEY_A);
      const accountB = await store("Organization B", KEY_B);
      const builders: MadeBuilder[] = [];
      const assembleWith = async (env: Record<string, string>) => {
        const assembled = await assembleBoat({
          env: parseWorkerEnv({
            SEALANT_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
            SEALANT_BOAT_STATE_DIRECTORY: state,
            DOCKER_RUNTIME_ENABLED: "false",
            ...env,
          }),
          db,
          credentialCipher: cipher,
          docker: undefined,
          snapshotBuilder: recordingBuilders(builders),
          clientFor,
          // The key checks a worker makes (an install's wallet, its reports) reach the recorded
          // Boats too, never Boat's real API.
          keyClientFor: (credential) => {
            const baseUrl = urls.get(credential.reveal());
            return baseUrl === undefined
              ? { ok: false, error: new BoatApiError("credential", 401, "unauthorized") }
              : HttpBoatApi.create({ credential, baseUrl, timeoutMs: 5_000 });
          },
          // Every call reads the key's revision: a rotation is seen at once.
          revisionCheckMs: 0,
        });
        if (assembled === undefined) throw new Error("Boat is not assembled");
        return assembled;
      };
      boat = await assembleWith(settings);
      const assemble: Context["assemble"] = async (env) => {
        const other = await assembleWith(env);
        others.push(other);
        return other;
      };
      const owner = `usr_${randomUUID()}`;
      await Effect.runPromise(
        db.insert(user).values({ id: owner, email: `${owner}@example.invalid`, name: "accounts" }),
      );
      const seedRun: Context["seedRun"] = async (input) => {
        const runId = randomUUID();
        const id = sandboxId();
        const seeded = boatRunSeedRows({
          runId,
          sandboxId: id,
          deploymentId: input.deploymentId,
          ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          ...(input.image === undefined ? {} : { publicationId: input.image.publicationId }),
        });
        const publication =
          input.image ??
          (() => {
            const image = builtImage(randomUUID(), randomUUID());
            return nativePublicationSchema.parse({
              kind: "boat-native",
              publicationId: seeded.publication.id,
              snapshot: image.artifact,
              evidence: image.evidence,
            });
          })();
        await Effect.runPromise(
          Effect.gen(function* () {
            yield* db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner });
            // An image no catalog holds, unless the run launched from one the test built.
            if (input.image === undefined)
              yield* db.insert(schema.nativePublications).values({
                ...seeded.publication,
                state: "superseded",
              });
            yield* db.insert(schema.boatRuns).values({
              ...seeded.run,
              resources: "none",
              ...(input.issuedOnly === true
                ? { sandboxId: null, createdSeenAt: null, target: null }
                : {}),
            });
            yield* db.insert(schema.nativePublicationConsumers).values({
              runId,
              runtimeInstanceId: runId,
              publicationId: publication.publicationId,
              state: "live",
            });
            yield* db.insert(schema.workspaceRuntimeInstances).values({
              runId,
              adapter: "boat",
              publication,
              status: input.stopping === true ? "ready" : "running",
              stopReason: input.stopping === true ? "user" : null,
              resourceId: input.issuedOnly === true ? null : id,
              publicationId: publication.publicationId,
            });
          }),
        );
        if (input.issuedOnly !== true)
          input.boat.vms.set(id, {
            id,
            key: seeded.run.idempotencyKey,
            labels: {
              "sealant-runtime": "boat",
              "sealant-deployment": input.deploymentId,
              "sealant-workspace": seeded.run.workspaceId,
              "sealant-run": runId,
              "sealant-instance": runId,
              "sealant-attempt": seeded.run.launchAttemptId,
              "sealant-source": publication.publicationId,
            },
            state: "idle",
          });
        return { runId, sandboxId: id };
      };
      await run({
        db,
        boats: { fallback, a, b },
        accounts: { a: accountA.id, b: accountB.id },
        deployments: { a: accountA.deploymentId, b: accountB.deploymentId },
        builders,
        state,
        boat,
        repo,
        clientFor,
        assemble,
        owner,
        seedRun,
      });
    } finally {
      await boat?.dispose();
      for (const other of others) await other.dispose();
      await Promise.all([fallback.close(), a.close(), b.close()]);
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(state, { recursive: true, force: true });
    }
  });
};

/** Every VM create and delete a recorded Boat was sent. */
const writes = (boat: RecordedBoat) =>
  boat.requests.filter(
    (request) => request === "POST /api/v1/sandboxes" || request.startsWith("DELETE"),
  );

// Each stop waits on Boat's deletion operation, which the recorded Boat completes over two polls.
describe.skipIf(DATABASE_URL === undefined)(
  "Boat accounts on the worker (Postgres)",
  { timeout: 60_000 },
  () => {
    it("builds each account's images in that account, on its first launch and never before", () =>
      withAccounts(async (c) => {
        const registration = c.boat.registration;
        if (registration === undefined) throw new Error("Boat not registered");
        // At start: the default account's builder alone. No stored account has launched.
        expect(c.builders.map((builder) => builder.owner)).toEqual([
          "11111111-2222-4333-8444-555555555555",
        ]);
        const acquire = (boatAccountId?: string) =>
          Effect.gen(function* () {
            const runId = randomUUID();
            yield* c.db.insert(workspaceAttempts).values({ id: runId, ownerUserId: c.owner });
            return yield* registration.artifacts.acquire({
              spec: boatWorkspace(boatAccountId),
              scope: { kind: "owner", ownerUserId: c.owner },
              consumer: nativeArtifactConsumerSchema.parse({ runId, runtimeInstanceId: runId }),
            });
          });
        const inA = await Effect.runPromise(acquire(c.accounts.a));
        // Account A's first launch made its builder: its own owner, its own journals.
        expect(c.builders.slice(1)).toMatchObject([
          {
            owner: boatAccountBuilderOwner(c.accounts.a),
            journalDirectory: join(c.state, "boat-accounts", c.accounts.a, "native-builds"),
            built: [inA.snapshot.identity.name],
          },
        ]);
        expect(inA.snapshot.owner).toBe(boatAccountBuilderOwner(c.accounts.a));
        // The default account's launch builds its own image, under its own deployment.
        const inDefault = await Effect.runPromise(acquire());
        expect(inDefault.publicationId).not.toBe(inA.publicationId);
        expect(c.builders[0]?.built).toEqual([inDefault.snapshot.identity.name]);
        // Account B never launched: it has no builder.
        expect(c.builders.map((builder) => builder.owner)).not.toContain(
          boatAccountBuilderOwner(c.accounts.b),
        );
        // An account this install does not have builds nothing and creates nothing.
        const unknown = await Effect.runPromise(Effect.result(acquire(randomUUID())));
        expect(Result.isFailure(unknown) && unknown.failure.message).toContain(
          "boat-account-unavailable",
        );
        expect(c.builders).toHaveLength(2);
      }));

    it("resolves, stops and sweeps each account's runs with its own key, and never another's", () =>
      withAccounts(async (c) => {
        const lifecycle = c.boat.lifecycle;
        if (lifecycle === undefined) throw new Error("no Boat lifecycle");
        const inA = await c.seedRun({
          accountId: c.accounts.a,
          deploymentId: c.deployments.a,
          boat: c.boats.a,
          stopping: true,
        });
        const inB = await c.seedRun({
          accountId: c.accounts.b,
          deploymentId: c.deployments.b,
          boat: c.boats.b,
          stopping: true,
        });
        const inDefault = await c.seedRun({
          deploymentId: DEFAULT_DEPLOYMENT,
          boat: c.boats.fallback,
          stopping: true,
        });
        // A create B issued and whose VM is not on record yet.
        const issued = await c.seedRun({
          accountId: c.accounts.b,
          deploymentId: c.deployments.b,
          boat: c.boats.b,
          issuedOnly: true,
        });

        // The sweeps visit every account that has runs, the default one first.
        const swept = await c.boat.sweptStacks();
        expect(swept.map((stack) => stack.accountId)).toEqual([
          null,
          ...[c.accounts.a, c.accounts.b].toSorted((x, y) => (x < y ? -1 : 1)),
        ]);
        // The VM sweep resolves B's create in B's Boat: the create is replayed there under its key.
        for (const stack of swept) await stack.reconcileAllocations({ limit: 20 });
        const resolved = await c.repo(
          Effect.flatMap(BoatRunRepo, (runs) => runs.get(issued.runId)),
        );
        expect(resolved).toMatchObject({ accountId: c.accounts.b, deploymentId: c.deployments.b });
        expect(resolved?.sandboxId).not.toBeNull();
        expect(c.boats.b.vms.get(resolved?.sandboxId ?? "")?.labels["sealant-deployment"]).toBe(
          c.deployments.b,
        );
        expect(writes(c.boats.b)).toEqual(["POST /api/v1/sandboxes"]);
        expect(writes(c.boats.a)).toEqual([]);
        expect(writes(c.boats.fallback)).toEqual([]);

        // Each stop deletes its VM in its own account's Boat, with that account's key.
        for (const [run, own] of [
          [inA, c.boats.a],
          [inB, c.boats.b],
          [inDefault, c.boats.fallback],
        ] as const) {
          expect(await lifecycle.stop({ resourceId: run.sandboxId })).toMatchObject({
            outcome: "stopped",
          });
          expect(writes(own)).toContain(`DELETE /api/v1/sandboxes/${run.sandboxId}`);
          expect(own.vms.has(run.sandboxId)).toBe(false);
        }
        expect(writes(c.boats.a)).toEqual([`DELETE /api/v1/sandboxes/${inA.sandboxId}`]);
        expect(writes(c.boats.fallback)).toEqual([
          `DELETE /api/v1/sandboxes/${inDefault.sandboxId}`,
        ]);
        expect(new Set(c.boats.a.bearers)).toEqual(new Set([KEY_A]));
        expect(new Set(c.boats.b.bearers)).toEqual(new Set([KEY_B]));
        expect(new Set(c.boats.fallback.bearers)).toEqual(new Set([DEFAULT_KEY]));
        // A VM no run of this install names is refused before any Boat is asked.
        await expect(lifecycle.stop({ resourceId: "bx_zzzzzzzz" })).rejects.toMatchObject({
          removalRefused: true,
        });

        // Their convergence settles each account's runs and asks no Boat for another's.
        const asked = [c.boats.a, c.boats.b, c.boats.fallback].map((boat) => boat.requests.length);
        for (const stack of await c.boat.sweptStacks())
          await stack.reconcileConvergence?.({ limit: 20, stop: neverStops });
        expect(
          [c.boats.a, c.boats.b, c.boats.fallback].map((boat) => boat.requests.length),
        ).toEqual(asked);
      }));

    it("keeps a run in its account after the account's key is rotated, and uses the new key", () =>
      withAccounts(async (c) => {
        const lifecycle = c.boat.lifecycle;
        if (lifecycle === undefined) throw new Error("no Boat lifecycle");
        const run = await c.seedRun({
          accountId: c.accounts.a,
          deploymentId: c.deployments.a,
          boat: c.boats.a,
        });
        // Read with the account's key: the agent's answer is not this test's, and unknown is running.
        expect(await lifecycle.inspect?.({ resourceId: run.sandboxId })).toMatchObject({
          state: "running",
        });
        expect(c.boats.a.bearers.at(-1)).toBe(KEY_A);
        await c.repo(
          Effect.flatMap(BoatAccountRepo, (accounts) =>
            accounts.rotate(c.accounts.a, {
              sealedKey: `sealed:${KEY_A_ROTATED}`,
              keyId: "k-test",
              revision: 1,
            }),
          ),
        );
        // Its stop is asked: the removal reads and deletes its VM with the account's new key.
        await Effect.runPromise(requestBoatRunStop(c.db, run.runId));
        const before = c.boats.a.bearers.length;
        expect(await lifecycle.stop({ resourceId: run.sandboxId })).toMatchObject({
          outcome: "stopped",
        });
        expect(new Set(c.boats.a.bearers.slice(before))).toEqual(new Set([KEY_A_ROTATED]));
        expect(writes(c.boats.a)).toEqual([`DELETE /api/v1/sandboxes/${run.sandboxId}`]);
        expect(writes(c.boats.b)).toEqual([]);
        expect(
          await c.repo(Effect.flatMap(BoatRunRepo, (runs) => runs.get(run.runId))),
        ).toMatchObject({ accountId: c.accounts.a, deploymentId: c.deployments.a });
      }));

    it("refuses an account's removal while it has a run Boat may hold a VM for, then deletes its saved images and its key", () =>
      withAccounts(async (c) => {
        const registration = c.boat.registration;
        const lifecycle = c.boat.lifecycle;
        if (registration === undefined || lifecycle === undefined)
          throw new Error("not registered");
        // Account A built one image on its first launch.
        const runId = randomUUID();
        await Effect.runPromise(
          c.db.insert(workspaceAttempts).values({ id: runId, ownerUserId: c.owner }),
        );
        const consumer = nativeArtifactConsumerSchema.parse({ runId, runtimeInstanceId: runId });
        const image = await Effect.runPromise(
          registration.artifacts.acquire({
            spec: boatWorkspace(c.accounts.a),
            scope: { kind: "owner", ownerUserId: c.owner },
            consumer,
          }),
        );
        await Effect.runPromise(registration.artifacts.release(consumer, image.publicationId));
        // A run launched from it, still live.
        const live = await c.seedRun({
          accountId: c.accounts.a,
          deploymentId: c.deployments.a,
          boat: c.boats.a,
          stopping: true,
          image,
        });
        const request = () =>
          c.repo(
            Effect.flatMap(BoatAccountRepo, (accounts) => accounts.requestRemoval(c.accounts.a)),
          );
        expect(await request()).toEqual({ kind: "in-use", liveRuns: 1, buildsInFlight: 0 });
        // Its run ends: Boat no longer has its VM, and the shared stop records it stopped.
        await lifecycle.stop({ resourceId: live.sandboxId });
        await Effect.runPromise(recordBoatRunStopped(c.db, live.runId));
        expect(await Effect.runPromise(nativeConsumerRows(c.db, live.runId))).toEqual([
          { state: "released", publicationId: image.publicationId },
        ]);
        for (const stack of await c.boat.sweptStacks())
          await stack.reconcileConvergence?.({ limit: 20, stop: neverStops });
        expect(await request()).toMatchObject({ kind: "requested" });
        // From now on nothing launches in it.
        const refused = await Effect.runPromise(
          Effect.result(
            registration.artifacts.acquire({
              spec: boatWorkspace(c.accounts.a),
              scope: { kind: "owner", ownerUserId: c.owner },
              consumer,
            }),
          ),
        );
        expect(Result.isFailure(refused)).toBe(true);
        // Its catalog reserves nothing for it either, whoever asks: the reservation takes its row.
        const reserved = await c.repo(
          Effect.result(
            Effect.flatMap(NativePublicationRepo, (catalog) =>
              catalog.reserve(
                {
                  deploymentId: c.deployments.a,
                  scope: { kind: "owner", ownerUserId: c.owner },
                  recipeHash: hex("9"),
                  runtime: runtimeIdentity,
                  assetsHash: hex("6"),
                  platform: "linux/amd64",
                },
                consumer,
              ),
            ),
          ),
        );
        expect(Result.isFailure(reserved) && reserved.failure.code).toBe("account-unavailable");
        // The worker deletes the image it built in A, with A's builder, then erases A's key.
        expect(await c.boat.reconcileRemovals?.()).toEqual([
          { accountId: c.accounts.a, outcome: "removed" },
        ]);
        const builderA = c.builders.find(
          (builder) => builder.owner === boatAccountBuilderOwner(c.accounts.a),
        );
        expect(builderA?.removed).toEqual([image.snapshot.identity.name]);
        expect(c.builders[0]?.removed).toEqual([]);
        const accounts = await c.repo(Effect.flatMap(BoatAccountRepo, (repo) => repo.list()));
        expect(accounts.map((account) => account.id)).toEqual([c.accounts.b]);
        expect(
          await c.repo(Effect.flatMap(BoatAccountRepo, (repo) => repo.sealedKey(c.accounts.a))),
        ).toBeUndefined();
        // The run keeps the account it was created in.
        expect(
          await c.repo(Effect.flatMap(BoatRunRepo, (runs) => runs.get(live.runId))),
        ).toMatchObject({ accountId: c.accounts.a });
        // Nothing is left to do.
        expect(await c.boat.reconcileRemovals?.()).toEqual([]);
      }));

    it("reads a rotated key again at once when Boat refuses the one it holds", () =>
      withAccounts(async (c) => {
        const run = await c.seedRun({
          accountId: c.accounts.a,
          deploymentId: c.deployments.a,
          boat: c.boats.a,
        });
        // A process that reads the key's revision once a minute.
        const directory = new BoatAccountDirectory({
          db: c.db,
          cipher,
          clientFor: c.clientFor,
          revisionCheckMs: 60_000,
        });
        const provider = await directory.provider(c.accounts.a);
        const id = boatSandboxIdSchema.parse(run.sandboxId);
        expect((await provider?.api.get(id))?.ok).toBe(true);
        await c.repo(
          Effect.flatMap(BoatAccountRepo, (accounts) =>
            accounts.rotate(c.accounts.a, {
              sealedKey: `sealed:${KEY_A_ROTATED}`,
              keyId: "k-test",
              revision: 1,
            }),
          ),
        );
        // The old key is revoked with the rotation.
        c.boats.a.acceptsOnly = [KEY_A_ROTATED];
        const before = c.boats.a.bearers.length;
        expect((await provider?.api.get(id))?.ok).toBe(true);
        expect(c.boats.a.bearers.slice(before)).toEqual([KEY_A, KEY_A_ROTATED]);
      }));

    it("launches in a stored account with no Boat key in its environment, and says the install's own account is not there", () =>
      withAccounts(async (c) => {
        const registration = c.boat.registration;
        if (registration === undefined) throw new Error("Boat not registered");
        expect(c.boat.launchReport).toEqual({
          launches: true,
          defaultAccount: false,
          resourceGateway: false,
        });
        // No default account: nothing was built at start.
        expect(c.builders).toEqual([]);
        const acquire = (boatAccountId?: string) =>
          Effect.gen(function* () {
            const runId = randomUUID();
            yield* c.db.insert(workspaceAttempts).values({ id: runId, ownerUserId: c.owner });
            return yield* registration.artifacts.acquire({
              spec: boatWorkspace(boatAccountId),
              scope: { kind: "owner", ownerUserId: c.owner },
              consumer: nativeArtifactConsumerSchema.parse({ runId, runtimeInstanceId: runId }),
            });
          });
        const inA = await Effect.runPromise(acquire(c.accounts.a));
        expect(inA.snapshot.owner).toBe(boatAccountBuilderOwner(c.accounts.a));
        const inDefault = await Effect.runPromise(Effect.result(acquire()));
        expect(Result.isFailure(inDefault) && inDefault.failure.message).toContain(
          "boat-account-unavailable",
        );
        // The API reads what the worker wrote, and gives the worker's answer.
        await c.boat.reportLaunch("worker-stored-only");
        const reports = await c.repo(
          Effect.flatMap(BoatAccountRepo, (repo) =>
            repo.launchReports(BOAT_LAUNCH_REPORT_FRESH_MS),
          ),
        );
        const support = boatLaunchSupportOf(reports);
        expect(support).toMatchObject({ launches: true, defaultAccount: false });
        expect(boatLaunchRefusal(support, { namesAccount: true, resources: "none" })).toBe(
          undefined,
        );
        expect(boatLaunchRefusal(support, { namesAccount: false, resources: "none" })).toContain(
          "must name a stored Boat account",
        );
        expect(boatLaunchRefusal(support, { namesAccount: true, resources: undefined })).toContain(
          "no resource gateway",
        );
        // A worker that stopped reporting is not counted after five minutes.
        await c.boat.reportLaunch(
          "worker-stored-only",
          new Date(Date.now() - BOAT_LAUNCH_REPORT_FRESH_MS - 1_000),
        );
        const stale = boatLaunchSupportOf(
          await c.repo(
            Effect.flatMap(BoatAccountRepo, (repo) =>
              repo.launchReports(BOAT_LAUNCH_REPORT_FRESH_MS),
            ),
          ),
        );
        expect(stale).toMatchObject({ launches: false, observedAt: undefined });
        expect(boatLaunchRefusal(stale, { namesAccount: true, resources: "none" })).toContain(
          "No worker of this install has reported launching Boat workspaces",
        );
      }, {}));

    it("keeps an install's own names when it set them, after the settings are dropped, and sees its labelled VMs as its own", () =>
      withAccounts(async (c) => {
        // The explicit settings were adopted by the install's row when the worker started.
        const stored = await c.repo(
          Effect.flatMap(BoatAccountRepo, (repo) =>
            Effect.all([repo.installDeployment(undefined), repo.installBuilderOwner(undefined)]),
          ),
        );
        expect(stored).toEqual([DEFAULT_DEPLOYMENT, EXPLICIT_ENV.SEALANT_BOAT_BUILDER_OWNER]);
        // The same install, its operator having dropped both settings.
        const after = await c.assemble({ SEALANT_BOAT_API_KEY: DEFAULT_KEY });
        const [fallback] = await after.sweptStacks();
        expect(fallback).toMatchObject({ accountId: null, deploymentId: DEFAULT_DEPLOYMENT });
        // Its default catalog was built at start, under the owner it always had.
        expect(c.builders.map((builder) => builder.owner)).toEqual([
          EXPLICIT_ENV.SEALANT_BOAT_BUILDER_OWNER,
          EXPLICIT_ENV.SEALANT_BOAT_BUILDER_OWNER,
        ]);
        // A create issued before, its VM carrying the old label, is resolved as this install's.
        const issued = await c.seedRun({
          deploymentId: DEFAULT_DEPLOYMENT,
          boat: c.boats.fallback,
          issuedOnly: true,
        });
        await fallback?.reconcileAllocations({ limit: 20 });
        const resolved = await c.repo(
          Effect.flatMap(BoatRunRepo, (runs) => runs.get(issued.runId)),
        );
        expect(resolved?.sandboxId).not.toBeNull();
        expect(
          c.boats.fallback.vms.get(resolved?.sandboxId ?? "")?.labels["sealant-deployment"],
        ).toBe(DEFAULT_DEPLOYMENT);
      }));

    it("makes the install's own names once when none is set, and every process reads the same", () =>
      withAccounts(
        async (c) => {
          const [fallback] = await c.boat.sweptStacks();
          const deployment = fallback?.deploymentId ?? "";
          expect(deployment).toMatch(/^sealant-install-[0-9a-f-]{36}$/);
          const owner = c.builders[0]?.owner ?? "";
          expect(owner).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          // Another worker, or this one restarted, gets the same names.
          const again = await c.assemble({ SEALANT_BOAT_API_KEY: DEFAULT_KEY });
          const [second] = await again.sweptStacks();
          expect(second?.deploymentId).toBe(deployment);
          expect(c.builders[1]?.owner).toBe(owner);
          // The API's control connections read the same row.
          const names = await c.repo(
            Effect.flatMap(BoatAccountRepo, (repo) => repo.installDeployment(undefined)),
          );
          expect(names).toBe(deployment);
          // No stored account can carry it.
          expect(deployment).not.toBe(c.deployments.a);
        },
        { SEALANT_BOAT_API_KEY: DEFAULT_KEY },
      ));
  },
);

/**
 * A builder that makes its images in Boat through the account's own client, as the real one does:
 * a VM, a saved snapshot of it, the VM deleted; and removes one as the real one does, reading it
 * first, so a snapshot Boat does not show the request's wallet reads as already gone. `crashes`:
 * how many removals die before they finish, as a worker that stops halfway would.
 */
const walletBuilders =
  (faults: { crashes: number; gate?: Promise<void> }): BoatSnapshotBuilderFactory =>
  async (options) => ({
    plan: async () => ({
      ok: true,
      value: {
        recipeHash: hex("5"),
        runtime: runtimeIdentity,
        assetsHash: hex("6"),
        platform: "linux/amd64",
      },
    }),
    build: async (input) => {
      // A test holds a build here, in flight, to change the account's wallet meanwhile.
      await faults.gate;
      const image = builtImage(
        options.owner,
        input.ownership?.buildId ?? randomUUID(),
        input.ownership,
      );
      const vm = await options.api.create({
        idempotencyKey: randomUUID(),
        marker: randomUUID(),
        purpose: "native-build",
        lifetime: { kind: "bounded" },
        requestVersion: 2,
      });
      if (!vm.ok) throw new Error("Boat refused the build VM");
      const saved = await options.api.saveSnapshot(
        vm.value.id,
        boatSnapshotNameSchema.parse(image.artifact.identity.name),
      );
      if (!saved.ok) throw new Error("Boat refused the save");
      await options.api.deleteSandbox(vm.value.id);
      // As the real builder does, it waits for Boat to withdraw the VM.
      for (let poll = 0; poll < 100; poll++) {
        const read = await options.api.get(vm.value.id);
        if (!read.ok && read.error.status === 404) break;
        await sleep(20);
      }
      return { ok: true, value: { outcome: "built", ...image } };
    },
    findPublished: unused,
    remove: async (artifact) => {
      if (faults.crashes > 0) {
        faults.crashes -= 1;
        throw new Error("the worker stopped halfway through the removal");
      }
      const name = boatSnapshotNameSchema.parse(artifact.identity.name);
      const found = await options.api.getSnapshot(name);
      if (!found.ok && found.error.status === 404) return { ok: true, value: "absent" };
      if (!found.ok) throw new Error("Boat did not answer the read");
      const deleted = await options.api.deleteSnapshot(name);
      if (!deleted.ok) throw new Error("Boat did not answer the delete");
      return { ok: true, value: "deleted" };
    },
    cleanup: unused,
    journals: async () => ({ ok: true, value: { entries: [], failures: [] } }),
    reconcileBuild: unused,
  });

/** Boat refuses the account reads: the key lacks `account.read`. */
const noAccountRead = (fake: FakeBoat) => {
  fake.faults = {
    refuse: ({ method, path }) =>
      method === "GET" && (path === "/limits" || path === "/orgs" || path === "/me")
        ? {
            status: 403,
            code: "api_key_action_forbidden",
            message: "The action is not on the key.",
          }
        : undefined,
  };
};

describe.skipIf(DATABASE_URL === undefined)(
  "Boat wallets on the worker: every object recorded where it was made (Postgres, fake Boat)",
  { timeout: 90_000 },
  () => {
    const KEY = "boat_live_fixture_wallet_worker_0007";

    /** One worker on a fresh database and a fake Boat whose account bills `personal` now. */
    const withWallets = (
      run: (c: {
        readonly db: DB;
        readonly fake: FakeBoat;
        readonly worker: NonNullable<Awaited<ReturnType<typeof assembleBoat>>>;
        readonly faults: { crashes: number; gate?: Promise<void> };
        readonly store: (
          organization: string | null,
          keyKind: "personal" | "organization" | null,
        ) => Promise<{ readonly id: string; readonly deploymentId: string }>;
        readonly launchImage: (accountId: string | undefined) => Promise<NativePublication>;
        readonly installWallet: () => Promise<unknown>;
        readonly account: (id: string) => Promise<{
          readonly organization: string | null;
          readonly keyRevision: number;
        }>;
        readonly change: (id: string, from: string | null, to: string) => Promise<string>;
        readonly walletOf: (publicationId: string) => Promise<unknown>;
        readonly stateOf: (publicationId: string) => Promise<string | undefined>;
        readonly sql: (statement: string) => Promise<void>;
        readonly building: (deploymentId: string) => Promise<boolean>;
        readonly mark: () => { readonly sent: number; readonly named: number };
        readonly namedSince: (from: { readonly sent: number; readonly named: number }) => string[];
      }) => Promise<void>,
      /** The worker's Boat settings beside the state directory, and the fake before it starts. */
      setup: {
        readonly settings?: Readonly<Record<string, string>>;
        readonly prepare?: (fake: FakeBoat) => void;
      } = {},
    ) =>
      withWorkspaceJobTestDatabase(DATABASE_URL ?? "", async (url) => {
        const scope = await Effect.runPromise(Scope.make());
        const fake = new FakeBoat({
          runId: `wl${randomUUID().slice(0, 6)}`,
          credential: KEY,
          network: "unit",
          baseImage: "unit-base",
          docker: async (args) => ({
            code: 0,
            stdout: args[0] === "inspect" ? "192.0.10.5\n" : "running\n",
            stderr: "",
            timedOut: false,
          }),
        });
        fake.account = { activeWallet: "personal" };
        setup.prepare?.(fake);
        await fake.start();
        const state = await mkdtemp(join(tmpdir(), "boat-wallet-"));
        let worker: NonNullable<Awaited<ReturnType<typeof assembleBoat>>> | undefined;
        try {
          const built = await Effect.runPromise(
            Layer.buildWithScope(makeSealantDBLayer(url), scope),
          );
          const db = Context.get(built, SealantDB);
          const repo = <A, E>(
            effect: Effect.Effect<A, E, BoatAccountRepo | BoatRunRepo | NativePublicationRepo>,
          ) =>
            Effect.runPromise(
              effect.pipe(
                Effect.provide(
                  Layer.mergeAll(BoatAccountRepoLive, BoatRunRepoLive, NativePublicationRepoLive),
                ),
                Effect.provideService(SealantDB, db),
              ),
            );
          const faults: { crashes: number; gate?: Promise<void> } = { crashes: 0 };
          const clientFor: BoatClientFactory = (credential, options) =>
            HttpBoatApi.create({
              credential,
              baseUrl: fake.baseUrl,
              timeoutMs: 5_000,
              ...(options?.organization === undefined
                ? {}
                : { organization: options.organization }),
            });
          worker = await assembleBoat({
            env: parseWorkerEnv({
              SEALANT_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
              SEALANT_BOAT_STATE_DIRECTORY: state,
              DOCKER_RUNTIME_ENABLED: "false",
              ...setup.settings,
            }),
            db,
            credentialCipher: cipher,
            docker: undefined,
            snapshotBuilder: walletBuilders(faults),
            clientFor,
            keyClientFor: (credential, options) =>
              HttpBoatApi.create({
                credential,
                baseUrl: fake.baseUrl,
                timeoutMs: 5_000,
                ...(options?.organization === undefined
                  ? {}
                  : { organization: options.organization }),
              }),
          });
          if (worker === undefined) throw new Error("Boat is not assembled");
          const assembled = worker;
          const owner = `usr_${randomUUID()}`;
          await Effect.runPromise(
            db
              .insert(user)
              .values({ id: owner, email: `${owner}@example.invalid`, name: "wallet" }),
          );
          await run({
            db,
            fake,
            worker: assembled,
            faults,
            store: async (organization, keyKind) => {
              const created = await repo(
                Effect.flatMap(BoatAccountRepo, (accounts) =>
                  accounts.create({
                    id: randomUUID(),
                    label: "Wallets",
                    sealedKey: `sealed:${KEY}`,
                    keyId: "k-test",
                    keyKind,
                    ...(organization === null ? {} : { organization }),
                  }),
                ),
              );
              return { id: created.id, deploymentId: created.deploymentId };
            },
            launchImage: async (accountId) => {
              const registration = assembled.registration;
              if (registration === undefined) throw new Error("Boat not registered");
              const runId = randomUUID();
              await Effect.runPromise(
                db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner }),
              );
              const consumer = nativeArtifactConsumerSchema.parse({
                runId,
                runtimeInstanceId: runId,
              });
              const image = await Effect.runPromise(
                registration.artifacts.acquire({
                  spec: boatWorkspace(accountId),
                  scope: { kind: "owner", ownerUserId: owner },
                  consumer,
                }),
              );
              await Effect.runPromise(
                registration.artifacts.release(consumer, image.publicationId),
              );
              return image;
            },
            account: async (id) => {
              const found = await repo(
                Effect.flatMap(BoatAccountRepo, (accounts) => accounts.get(id)),
              );
              if (found === undefined) throw new Error("no account");
              return found;
            },
            change: async (id, from, to) => {
              const changed = await repo(
                Effect.flatMap(BoatAccountRepo, (accounts) =>
                  accounts.changeOrganization(
                    { accountId: id },
                    { organization: to, expected: from, unsettled: [] },
                  ),
                ),
              );
              return changed.kind;
            },
            installWallet: () =>
              repo(Effect.flatMap(BoatAccountRepo, (accounts) => accounts.installWallet())),
            walletOf: (publicationId) =>
              repo(
                Effect.flatMap(NativePublicationRepo, (catalog) => catalog.wallet(publicationId)),
              ),
            stateOf: async (publicationId) =>
              (
                await repo(
                  Effect.flatMap(NativePublicationRepo, (catalog) => catalog.get(publicationId)),
                )
              )?.state,
            sql: async (statement) => {
              await Effect.runPromise(db.execute(statement));
            },
            building: async (deploymentId) =>
              (
                await repo(
                  Effect.flatMap(NativePublicationRepo, (catalog) =>
                    catalog.heldByDeployment({ deploymentId, limit: 50 }),
                  ),
                )
              ).some((record) => record.state === "reserved" || record.state === "building"),
            mark: () => ({
              sent: fake.events.filter((event) => event.kind === "api").length,
              named: fake.organizationHeaders.length,
            }),
            namedSince: (from) => {
              const sent = fake.events.filter((event) => event.kind === "api").length - from.sent;
              const named = fake.organizationHeaders.slice(from.named);
              // Every request since `from` named a wallet: none went to "whatever is active".
              expect(named).toHaveLength(sent);
              return named.map((each) => each.organization);
            },
          });
        } finally {
          await worker?.dispose();
          await fake.stop();
          await Effect.runPromise(Scope.close(scope, Exit.void));
          await rm(state, { recursive: true, force: true });
        }
      });

    /** Retention as the hourly pass runs it, with every image unused since long ago. */
    const retention = { stoppedSince: new Date(0), unusedSince: new Date(Date.now() + 86_400_000) };

    it("records a connect-pinned key's first image in its wallet, resolves a legacy account found after a wallet switch, and moves between wallets leaving nothing stranded", () =>
      withWallets(async (c) => {
        // As connect stores a personal key: pinned to the wallet it bills.
        const pinned = await c.store("personal", "personal");
        const first = await c.launchImage(pinned.id);
        expect(await c.walletOf(first.publicationId)).toEqual({
          state: "known",
          wallet: "personal",
        });
        expect(c.fake.heldIn("personal").snapshots).toEqual([first.snapshot.identity.name]);

        // As the migration leaves an account Mend connected before Core pinned accounts.
        await c.sql(
          `update boat_accounts set boat_organization = null, key_kind = null where id = '${pinned.id}'`,
        );
        await c.sql(
          `update native_publications set boat_wallet = null, boat_wallet_state = 'unknown' where deployment_id = '${pinned.deploymentId}'`,
        );
        // The owner switches the active wallet in Boat for their own use.
        c.fake.account = { ...c.fake.account, activeWallet: "team_acme" };
        // Retention before Core has found where the image is: nothing is asked, nothing removed.
        await c.worker.reapImages?.(retention);
        expect(await c.stateOf(first.publicationId)).toBe("ready");
        expect(c.fake.heldIn("personal").snapshots).toEqual([first.snapshot.identity.name]);

        // The resolve pass finds the image where it is, and pins the account to the wallet it
        // bills now (no VM of it runs).
        const from = c.mark();
        expect(await c.worker.resolveWallets()).toEqual([
          { accountId: pinned.id, outcome: "pinned" },
        ]);
        // The key check names no wallet (read-only, never read as absence); the image is looked
        // for under each wallet by name, and found in `personal`.
        expect(c.fake.organizationHeaders.slice(from.named)).toContainEqual({
          method: "GET",
          path: `/saved-snapshots/${first.snapshot.identity.name}`,
          organization: "personal",
        });
        expect(await c.account(pinned.id)).toMatchObject({ organization: "team_acme" });
        expect(await c.walletOf(first.publicationId)).toEqual({
          state: "known",
          wallet: "personal",
        });

        // The image is removed where it was made, by requests that name that wallet.
        const removal = c.mark();
        expect(await c.worker.removeImagesElsewhere?.()).toEqual([
          { accountId: pinned.id, removed: 1, pending: 0 },
        ]);
        expect(new Set(c.namedSince(removal))).toEqual(new Set(["personal"]));
        expect(c.fake.heldIn("personal")).toEqual({ sandboxes: [], snapshots: [] });
        expect(await c.stateOf(first.publicationId)).toBe("removed");

        // Pinned to each wallet in turn: each launch builds in the wallet named now; each image
        // left in the other is removed there.
        const inAcme = await c.launchImage(pinned.id);
        expect(c.fake.heldIn("team_acme").snapshots).toEqual([inAcme.snapshot.identity.name]);
        expect(await c.change(pinned.id, "team_acme", "personal")).toBe("changed");
        const inPersonal = await c.launchImage(pinned.id);
        expect(inPersonal.publicationId).not.toBe(inAcme.publicationId);
        expect(c.fake.heldIn("personal").snapshots).toEqual([inPersonal.snapshot.identity.name]);
        await c.worker.removeImagesElsewhere?.();
        expect(c.fake.heldIn("team_acme").snapshots).toEqual([]);
        expect(await c.change(pinned.id, "personal", "team_acme")).toBe("changed");
        await c.worker.removeImagesElsewhere?.();
        expect(c.fake.heldIn("personal").snapshots).toEqual([]);
        // Nothing recorded removed that Boat still has.
        for (const image of [first, inAcme, inPersonal])
          if ((await c.stateOf(image.publicationId)) === "removed")
            expect(c.fake.snapshots.has(image.snapshot.identity.name)).toBe(false);
      }));

    it("refuses a change while a build is in flight, records the image where it finished, and removes it there after the change", () =>
      withWallets(async (c) => {
        const account = await c.store("personal", "personal");
        const held = Promise.withResolvers<void>();
        c.faults.gate = held.promise;
        const launching = c.launchImage(account.id);
        // The build is reserved, and held in the builder.
        for (let poll = 0; poll < 200 && !(await c.building(account.deploymentId)); poll++)
          await sleep(20);
        expect(await c.change(account.id, "personal", "team_acme")).toBe("in-use");
        held.resolve();
        const image = await launching;
        expect(await c.walletOf(image.publicationId)).toEqual({
          state: "known",
          wallet: "personal",
        });
        expect(await c.change(account.id, "personal", "team_acme")).toBe("changed");
        delete c.faults.gate;
        const removal = c.mark();
        await c.worker.removeImagesElsewhere?.();
        expect(new Set(c.namedSince(removal))).toEqual(new Set(["personal"]));
        expect(c.fake.heldIn("personal").snapshots).toEqual([]);
        expect(await c.stateOf(image.publicationId)).toBe("removed");
      }));

    it("removes a pinned account's image with requests that name its wallet when the owner switches the active wallet between retention passes", () =>
      withWallets(async (c) => {
        const account = await c.store("personal", "personal");
        const image = await c.launchImage(account.id);
        await c.worker.reapImages?.({ stoppedSince: new Date(0), unusedSince: new Date(0) });
        c.fake.account = { ...c.fake.account, activeWallet: "team_acme" };
        const from = c.mark();
        await c.worker.reapImages?.(retention);
        expect(new Set(c.namedSince(from))).toEqual(new Set(["personal"]));
        expect(await c.stateOf(image.publicationId)).toBe("removed");
        expect(c.fake.heldIn("personal").snapshots).toEqual([]);
      }));

    it("pins the install's own key to its setting when Boat hides which wallet it bills, and launches there", () =>
      withWallets(
        async (c) => {
          expect(await c.installWallet()).toMatchObject({ organization: "personal" });
          const image = await c.launchImage(undefined);
          expect(await c.walletOf(image.publicationId)).toEqual({
            state: "known",
            wallet: "personal",
          });
          expect(c.fake.heldIn("personal").snapshots).toEqual([image.snapshot.identity.name]);
        },
        {
          settings: {
            SEALANT_BOAT_API_KEY: KEY,
            SEALANT_BOAT_ORGANIZATION: "personal",
            SEALANT_BOAT_BUILDER_OWNER: "11111111-2222-4333-8444-555555555555",
          },
          prepare: noAccountRead,
        },
      ));

    it("launches nothing in the install's own account while Core cannot see which wallet its key bills", () =>
      withWallets(
        async (c) => {
          expect(await c.installWallet()).toMatchObject({ organization: null });
          await expect(c.launchImage(undefined)).rejects.toThrow();
          expect(c.fake.heldIn("personal")).toEqual({ sandboxes: [], snapshots: [] });
          expect(c.fake.organizationHeaders.map((each) => each.path)).not.toContain("/sandboxes");
          // Once Boat shows it (the key gained account.read), the next pass pins it, and it launches.
          c.fake.faults = {};
          expect(await c.worker.resolveWallets()).toEqual([
            { accountId: "default", outcome: "pinned" },
          ]);
          const image = await c.launchImage(undefined);
          expect(c.fake.heldIn("personal").snapshots).toEqual([image.snapshot.identity.name]);
        },
        {
          settings: {
            SEALANT_BOAT_API_KEY: KEY,
            SEALANT_BOAT_BUILDER_OWNER: "11111111-2222-4333-8444-555555555555",
          },
          prepare: noAccountRead,
        },
      ));
  },
);
