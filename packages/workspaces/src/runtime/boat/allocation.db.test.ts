import { constants, createHash, publicEncrypt, randomUUID } from "node:crypto";
import http from "node:http";

import { credentialCipherLayer, type CredentialCipherError } from "@sealant/credentials";
import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  NativePublicationRepo,
  NativePublicationRepoLive,
  SealantDB,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  WorkspaceAttemptRepoLive,
  makeSealantDBLayer,
  user,
  workspaceAttempts,
  type DB,
} from "@sealant/db";
import { corruptBoatAllocation } from "@sealant/db/testing/boat-allocations";
import { nativeConsumerRows } from "@sealant/db/testing/native-publications";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import {
  boatAllocationInputSchema,
  boatAllocationRecordSchema,
  nativePublicationKeySchema,
  nativePublicationSchema,
  type BoatAllocationInput,
  type BoatAllocationRecord,
  type BoatExecutionTarget,
} from "@sealant/validators";
import { Context, Effect, Fiber, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { adoptStrandedLaunchesEffect } from "../../worker/adopt-stranded-launches.js";
import { boatAllocationWorkerLayer } from "../../worker/boat-allocation.js";
import { BoatAllocation, BoatAllocationProvider, boatAllocationLayer } from "./allocation.js";
import { HttpBoatApi } from "./api.js";
import { BoatSecret } from "./config.js";
import {
  BoatGuestTransportService,
  boatExecutionLayer,
  type BoatGuestTransport,
} from "./execution.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = (value: string) => {
  const parsed = BoatSecret.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const probe = {
  version: 1,
  tools: {
    sudo: true,
    sudoSetuid: true,
    useradd: true,
    groupadd: true,
    setfacl: true,
    getfacl: true,
    setpriv: true,
  },
  sudoersMend: true,
  sudoersIncludesDir: true,
  noNewPrivileges: false,
  passwdWritable: true,
  mendGroup: "present",
  reservedIdsInUse: [],
  personEnv: true,
  sharedDirs: [],
  sealantd: null,
};
const seed = (db: DB, catalog: NativePublicationRepo["Service"]) =>
  Effect.gen(function* () {
    const owner = `usr_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    yield* db
      .insert(user)
      .values({ id: owner, email: `${owner}@example.invalid`, name: "allocation test" });
    yield* db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner });
    const runtime = {
      source: `ghcr.io/sealant-sh/sealantd-next:test@sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
      manifest: "a".repeat(64),
      sealantd: "b".repeat(64),
      socat: "c".repeat(64),
      relay: "d".repeat(64),
    };
    const key = nativePublicationKeySchema.parse({
      deploymentId: "test",
      scope: { kind: "owner", ownerUserId: owner },
      recipeHash: "e".repeat(64),
      assetsHash: "f".repeat(64),
      platform: "linux/amd64",
      runtime,
    });
    const consumer = boatAllocationInputSchema.shape.consumer.parse({
      runId,
      runtimeInstanceId: runId,
    });
    const reserved = yield* catalog.reserve(key, consumer);
    const ownership = reserved.ownership;
    const manifest = JSON.stringify({
      format: "sealant-guest-manifest-v1",
      files: {},
      inputs: {},
      bundle_paths: ["/var/lib/sealant/guest/sealantd"],
    });
    const receipt = JSON.stringify({
      version: 3,
      ownership,
      owner: randomUUID(),
      build: ownership.buildId,
      recipeHash: key.recipeHash,
      assetsHash: key.assetsHash,
      runtime: key.runtime,
      probe,
      guest: { manifest, manifestDigest: hash(manifest) },
    });
    const receiptValue = z.object({ owner: z.string() }).parse(JSON.parse(receipt));
    const publication = nativePublicationSchema.parse({
      kind: "boat-native",
      publicationId: ownership.publicationId,
      snapshot: {
        kind: "boat-saved-snapshot",
        owner: receiptValue.owner,
        build: ownership.buildId,
        recipeHash: key.recipeHash,
        receiptHash: hash(receipt),
        runtime: key.runtime,
        identity: {
          name: `allocation-${ownership.publicationId}`,
          sourceSandboxId: "bx_3456789a",
          createdAt: "2026-11-06T00:00:00.000Z",
          snapshotId: randomUUID(),
        },
      },
      evidence: {
        receipt,
        receiptHash: hash(receipt),
        imageProbe: probe,
        runtime: key.runtime,
        assetsHash: key.assetsHash,
        recipeHash: key.recipeHash,
        daemonRecovery: "supported",
        executorRecovery: "unverified",
      },
    });
    const claim = yield* catalog.claim(publication.publicationId, "build", 60000);
    if (claim === undefined) throw new Error("missing claim");
    yield* catalog.publish(claim, publication);
    return boatAllocationInputSchema.parse({
      deploymentId: "test",
      workspaceId: "workspace",
      consumer,
      launchAttemptId: randomUUID(),
      publication,
      scope: key.scope,
      sourceKind: "capture",
    });
  });

class ProviderFixture {
  bootId = randomUUID();
  readonly creates: Array<{ key: string | undefined; body: Record<string, unknown> }> = [];
  readonly commands: string[] = [];
  readonly reads: string[] = [];
  labels: Record<string, string> | undefined;
  lostCreate = false;
  noAllocation = false;
  conflict = false;
  scheduled = false;
  foreign = false;
  inventoryUnavailable = false;
  snapshotMismatch = false;
  beforeCreateReply: () => Promise<void> = async () => {};
  constructor(readonly input: BoatAllocationInput) {}
  sandbox(id = "bx_23456789") {
    return {
      id,
      state: "running",
      labels: this.foreign ? { ...this.labels, "sealant-run": "foreign" } : this.labels,
      archiveAfter: this.scheduled ? "2026-11-07T00:00:00Z" : null,
      ttlSeconds: this.scheduled ? 900 : null,
      snapshots: true,
      monitoring: false,
    };
  }
  async serve(request: http.IncomingMessage, response: http.ServerResponse) {
    const url = new URL(request.url ?? "/", "http://fixture");
    const send = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    let raw = "";
    for await (const part of request) raw += String(part);
    if (request.method === "POST" && url.pathname === "/api/v1/sandboxes") {
      const body = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
      const header = request.headers["idempotency-key"];
      this.creates.push({ key: typeof header === "string" ? header : undefined, body });
      if (!this.noAllocation) this.labels = z.record(z.string(), z.string()).parse(body.labels);
      await this.beforeCreateReply();
      if (this.lostCreate) {
        response.destroy();
        return;
      }
      send({ ok: true, sandbox: this.sandbox() });
      return;
    }
    this.reads.push(url.pathname);
    if (url.pathname.startsWith("/api/v1/saved-snapshots/")) {
      send({
        ok: true,
        snapshot: {
          ...this.input.publication.snapshot.identity,
          status: "ready",
          ...(this.snapshotMismatch ? { sourceSandboxId: "bx_456789ab" } : {}),
        },
      });
      return;
    }
    if (url.pathname === "/api/v1/sandboxes") {
      if (this.inventoryUnavailable) {
        send({ code: "rate_limited" }, 429);
        return;
      }
      // The exact match appears only on the second page, alongside an irrelevant first page.
      const second = url.searchParams.get("cursor") === "next";
      send({
        ok: true,
        sandboxes: !second
          ? [{ ...this.sandbox("bx_56789abc"), labels: { "sealant-run": "foreign" } }]
          : this.labels === undefined
            ? []
            : this.conflict
              ? [this.sandbox(), this.sandbox("bx_6789abcd")]
              : [this.sandbox()],
        pageInfo: { hasMore: !second, nextCursor: second ? null : "next", limit: 200 },
      });
      return;
    }
    if (url.pathname === "/api/v1/sandboxes/bx_23456789") {
      send({ ok: true, sandbox: this.sandbox() });
      return;
    }
    if (url.pathname.endsWith("/commands")) {
      const command = z.object({ command: z.string() }).parse(JSON.parse(raw)).command;
      this.commands.push(command);
      send({ ok: true, exitCode: 0, timedOut: false, stdout: this.bootId + "\n", stderr: "" });
      return;
    }
    send({ code: "not_found" }, 404);
  }
}
class GuestFixture implements BoatGuestTransport {
  readonly targets: BoatExecutionTarget[] = [];
  fail = false;
  target: BoatExecutionTarget | undefined;
  async bind(target: BoatExecutionTarget, raw: unknown) {
    if (this.fail) throw new Error("lost bind");
    this.targets.push(target);
    this.target = target;
    const request = z
      .object({
        format: z.string(),
        identity: z.unknown(),
        boot_id: z.string(),
        operation_id: z.string(),
        public_key: z.string(),
        manifest_digest: z.string(),
      })
      .parse(raw);
    const label = JSON.stringify([
      request.format,
      target.deploymentId,
      target.sandboxId,
      target.diskLineage,
      target.bootId,
      request.operation_id,
      target.manifestDigest,
    ]);
    return {
      format: "sealant-bootstrap-reply-v1",
      identity: request.identity,
      boot_id: target.bootId,
      operation_id: request.operation_id,
      admission: "held",
      boot: { status: "compatible" },
      ciphertext: publicEncrypt(
        {
          key: request.public_key,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
          oaepLabel: Buffer.from(label),
        },
        Buffer.from("a".repeat(64)),
      ).toString("base64"),
    };
  }
  async host() {
    return { origin: "https://fixture-8080.on.boat.dev", cookie: secret("test-cookie-local-only") };
  }
  async call(_host: unknown, bearer: BoatSecret, route: string) {
    expect(route).toBe("status");
    expect(bearer.reveal()).toBe("a".repeat(64));
    if (this.target === undefined) throw new Error("missing target");
    return {
      format: "sealant-receiver-status-v1",
      identity: {
        deployment_id: this.target.deploymentId,
        instance_id: this.target.sandboxId,
        disk_lineage: this.target.diskLineage,
      },
      boot_id: this.target.bootId,
      admission: "held",
      execution: "unavailable",
      epoch: null,
      operation_id: null,
      stage: "empty",
    };
  }
}
const test = async (
  run: (s: {
    db: DB;
    input: BoatAllocationInput;
    allocations: BoatAllocation["Service"];
    repo: BoatAllocationRepo["Service"];
    catalog: NativePublicationRepo["Service"];
    runtimes: WorkspaceRuntimeInstanceRepo["Service"];
    executions: BoatExecutionRepo["Service"];
    provider: ProviderFixture;
    guest: GuestFixture;
  }) => Promise<void>,
) => {
  if (databaseUrl === undefined) throw new Error("SEALANT_TEST_DATABASE_URL required");
  await withWorkspaceJobTestDatabase(databaseUrl, async (url) => {
    const DBLayer = makeSealantDBLayer(url);
    const Repos = Layer.mergeAll(
      NativePublicationRepoLive,
      BoatAllocationRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
      BoatExecutionRepoLive,
    ).pipe(Layer.provideMerge(DBLayer));
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* SealantDB;
        const catalog = yield* NativePublicationRepo;
        const repo = yield* BoatAllocationRepo;
        const runtimes = yield* WorkspaceRuntimeInstanceRepo;
        const executions = yield* BoatExecutionRepo;
        const input = yield* seed(db, catalog);
        const provider = new ProviderFixture(input);
        const guest = new GuestFixture();
        const server = http.createServer((request, response) => {
          void provider.serve(request, response).catch(() => {
            response.writeHead(500);
            response.end();
          });
        });
        yield* Effect.acquireRelease(
          Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  server.closeAllConnections();
                  server.close((error) => {
                    if (error) {
                      reject(error);
                      return;
                    }
                    resolve();
                  });
                }),
            ),
        );
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("missing address");
        const api = HttpBoatApi.create({
          credential: secret("test-provider-key-local-only"),
          baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
          timeoutMs: 1000,
        });
        if (!api.ok) throw api.error;
        const Infra = Layer.mergeAll(
          Layer.succeed(SealantDB, db),
          credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") }),
          Layer.succeed(BoatAllocationProvider, { deploymentId: "test", api: api.value }),
        );
        // The complete production assembly builds with no provider I/O or admission.
        const Root: Layer.Layer<BoatAllocation, CredentialCipherError> =
          boatAllocationWorkerLayer.pipe(Layer.provide(Infra));
        yield* Layer.build(Root);
        const Exchange = boatExecutionLayer.pipe(
          Layer.provide(Layer.succeed(BoatGuestTransportService, guest)),
        );
        const Test = boatAllocationLayer.pipe(Layer.provide(Exchange), Layer.provide(Infra));
        const context = yield* Layer.build(Test);
        const allocations = Context.get(context, BoatAllocation);
        yield* Effect.promise(() =>
          run({ db, input, allocations, repo, catalog, runtimes, executions, provider, guest }),
        );
      }).pipe(Effect.provide(Repos), Effect.scoped),
    );
  });
};
const execute = Effect.runPromise;
const reservation = (input: BoatAllocationInput): BoatAllocationRecord =>
  boatAllocationRecordSchema.parse({
    input,
    manifestDigest: hash(
      JSON.stringify({
        format: "sealant-guest-manifest-v1",
        files: {},
        inputs: {},
        bundle_paths: ["/var/lib/sealant/guest/sealantd"],
      }),
    ),
    idempotencyKey: randomUUID(),
    diskLineage: randomUUID(),
    phase: "reserved",
    sandboxId: null,
    conflictingSandboxes: [],
    target: null,
    reason: null,
  });

describe.runIf(databaseUrl !== undefined)(
  "Boat allocation through PostgreSQL and provider HTTP",
  () => {
    it("reserves the actual run, exact source, pending runtime and sealed exchange without starting work", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        expect(target).toMatchObject({
          runId: s.input.consumer.runId,
          runtimeInstanceId: s.input.consumer.runId,
          bootId: s.provider.bootId,
          sourceId: s.input.publication.publicationId,
        });
        expect(s.provider.creates).toHaveLength(1);
        expect(s.provider.creates[0]?.body).toMatchObject({
          from: s.input.publication.snapshot.identity.name,
          ttlSeconds: null,
          noEnv: true,
          snapshots: true,
          visibility: "private",
          monitoring: false,
        });
        expect(await execute(s.executions.get(target.runId))).toMatchObject({
          phase: "control",
          target,
        });
        expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
          status: "pending",
          adapter: "boat",
          resourceId: target.sandboxId,
          publication: s.input.publication,
        });
        expect(await execute(nativeConsumerRows(s.db, target.runId))).toEqual([
          { publicationId: s.input.publication.publicationId, state: "pending" },
        ]);
        await expect(
          execute(s.catalog.release(s.input.consumer, s.input.publication.publicationId)),
        ).rejects.toThrow("consumer-conflict");
        expect(await execute(s.allocations.prepare(s.input))).toEqual(target);
        expect(s.provider.creates).toHaveLength(1);
        expect(s.guest.targets).toHaveLength(1);
      }));
    it("adopts a lost create response from the complete paginated inventory after restarting the service", () =>
      test(async (s) => {
        s.provider.lostCreate = true;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow(
          "provider-unavailable",
        );
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "issued",
          sandboxId: null,
        });
        const swept = await execute(s.allocations.reconcile({ limit: 20 }));
        expect(swept.entries).toEqual([{ runId: s.input.consumer.runId, outcome: "bound" }]);
        expect(s.provider.creates).toHaveLength(1);
        expect(s.guest.targets).toHaveLength(1);
      }));
    it("keeps a pre-send crash issued even after empty or unavailable inventory and keeps its pin", () =>
      test(async (s) => {
        const record = await execute(s.repo.reserve(reservation(s.input)));
        await execute(s.repo.advance(record, { ...record, phase: "issued" }));
        expect((await execute(s.allocations.reconcile({ limit: 20 }))).entries[0]?.outcome).toBe(
          "pending",
        );
        s.provider.inventoryUnavailable = true;
        expect((await execute(s.allocations.reconcile({ limit: 20 }))).entries[0]?.outcome).toBe(
          "unavailable",
        );
        expect(s.provider.creates).toHaveLength(0);
        expect(s.guest.targets).toHaveLength(0);
        await expect(
          execute(s.catalog.release(s.input.consumer, s.input.publication.publicationId)),
        ).rejects.toThrow("consumer-conflict");
      }));
    it("admits only one create issuer under a deterministic same-record race", () =>
      test(async (s) => {
        const record = await execute(s.repo.reserve(reservation(s.input)));
        const results = await Promise.allSettled([
          execute(s.repo.advance(record, { ...record, phase: "issued" })),
          execute(s.repo.advance(record, { ...record, phase: "issued" })),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        await execute(s.allocations.reconcile({ limit: 20 }));
        expect(s.provider.creates).toHaveLength(0);
      }));
    it("refuses changed source, scope, launch identity and publication before provider effects", () =>
      test(async (s) => {
        await execute(s.repo.reserve(reservation(s.input)));
        for (const input of [
          { ...s.input, launchAttemptId: "other" },
          { ...s.input, scope: { kind: "owner" as const, ownerUserId: "other" } },
          { ...s.input, workspaceId: "other" },
        ]) {
          await expect(execute(s.allocations.prepare(input))).rejects.toThrow("target-mismatch");
        }
        expect(s.provider.creates).toHaveLength(0);
        expect(s.provider.reads).toHaveLength(0);
        s.provider.snapshotMismatch = true;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("source-mismatch");
        expect(s.provider.creates).toHaveLength(0);
      }));
    it("rolls back allocation reservation when another runtime already owns the run", () =>
      test(async (s) => {
        await execute(
          s.runtimes.upsertRuntimeInstance({
            runId: s.input.consumer.runId,
            status: "pending",
            adapter: "docker",
          }),
        );
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("binding-conflict");
        expect(await execute(s.repo.get(s.input.consumer.runId))).toBeUndefined();
        expect(s.provider.creates).toHaveLength(0);
      }));
    it("never creates a reservation stopped before issuance", () =>
      test(async (s) => {
        await execute(s.repo.reserve(reservation(s.input)));
        await execute(
          s.runtimes.markStopRequested({ runId: s.input.consumer.runId, stopReason: "user" }),
        );
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("allocation-held");
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "held",
          reason: "run-stopped",
        });
        expect(s.provider.creates).toHaveLength(0);
        expect(s.provider.reads).toHaveLength(0);
      }));
    it("refuses issuance when the catalog quarantines the source after reservation", () =>
      test(async (s) => {
        await execute(s.repo.reserve(reservation(s.input)));
        await execute(s.catalog.rejectReady(s.input.publication, "fixture-refusal"));
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("pin-unavailable");
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "reserved",
        });
        expect(s.provider.creates).toHaveLength(0);
      }));
    it("keeps conflicting exact allocations held and records every known conflicting sandbox", () =>
      test(async (s) => {
        s.provider.lostCreate = true;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow(
          "provider-unavailable",
        );
        s.provider.conflict = true;
        expect((await execute(s.allocations.reconcile({ limit: 20 }))).entries[0]?.outcome).toBe(
          "held",
        );
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "held",
          reason: "allocation-conflict",
          conflictingSandboxes: ["bx_23456789", "bx_6789abcd"],
        });
        expect(s.provider.creates).toHaveLength(1);
        expect(s.guest.targets).toHaveLength(0);
      }));
    it("retains the exact disk when production lifetime cannot be verified", () =>
      test(async (s) => {
        s.provider.scheduled = true;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("allocation-held");
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "held",
          sandboxId: "bx_23456789",
          reason: "lifetime-unverified",
        });
        expect(s.guest.targets).toHaveLength(0);
      }));
    it("records a create completion after stop without exchanging or overwriting the stopped status", () =>
      test(async (s) => {
        s.provider.beforeCreateReply = async () => {
          await execute(
            s.runtimes.markStopped({ runId: s.input.consumer.runId, stopReason: "user" }),
          );
        };
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("allocation-held");
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "allocated",
          sandboxId: "bx_23456789",
        });
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
        ).toMatchObject({ status: "stopped", resourceId: "bx_23456789" });
        expect(s.guest.targets).toHaveLength(0);
      }));
    it("continues discovering an issued allocation after a stop, rather than forgetting its disk", () =>
      test(async (s) => {
        s.provider.lostCreate = true;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow(
          "provider-unavailable",
        );
        await execute(
          s.runtimes.markStopped({ runId: s.input.consumer.runId, stopReason: "user" }),
        );
        expect((await execute(s.allocations.reconcile({ limit: 20 }))).entries[0]?.outcome).toBe(
          "held",
        );
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "allocated",
          sandboxId: "bx_23456789",
        });
        expect(s.guest.targets).toHaveLength(0);
      }));
    it("reconciles a persisted target after exchange loss without adopting a new boot", () =>
      test(async (s) => {
        s.guest.fail = true;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow(
          "transport-unavailable",
        );
        const before = await execute(s.repo.get(s.input.consumer.runId));
        expect(before?.phase).toBe("bound");
        s.guest.fail = false;
        expect((await execute(s.allocations.reconcile({ limit: 20 }))).entries[0]?.outcome).toBe(
          "bound",
        );
        expect(await execute(s.repo.get(s.input.consumer.runId))).toEqual(before);
        expect(s.provider.commands).toEqual(
          Array(2).fill("/usr/bin/cat /proc/sys/kernel/random/boot_id"),
        );
        expect(s.provider.creates).toHaveLength(1);
      }));
    it("leaves native allocation rows to their owner during generic stranded-launch recovery", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        const Infra = Layer.succeed(SealantDB, s.db);
        const Repos = Layer.merge(WorkspaceRuntimeInstanceRepoLive, WorkspaceAttemptRepoLive).pipe(
          Layer.provide(Infra),
        );
        expect(
          await execute(
            adoptStrandedLaunchesEffect({
              runtimeAdapters: [],
              unownedGraceMs: 0,
              lostLaunchGraceMs: 0,
            }).pipe(Effect.provide(Repos)),
          ),
        ).toEqual([]);
        expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
          status: "pending",
          resourceId: target.sandboxId,
        });
      }));
    it("refuses a changed current boot without replacing the persisted target or exchange", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        s.provider.bootId = randomUUID();
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("target-mismatch");
        expect((await execute(s.repo.get(s.input.consumer.runId)))?.target).toEqual(target);
        expect(s.guest.targets).toHaveLength(1);
        expect(s.provider.creates).toHaveLength(1);
      }));
    it("advances past malformed records and still reconciles other runs in the page", () =>
      test(async (s) => {
        const first = await execute(s.repo.reserve(reservation(s.input)));
        await execute(
          corruptBoatAllocation(s.db, s.input.consumer.runId, { ...first, phase: "invalid" }),
        );
        const nextInput = await execute(seed(s.db, s.catalog));
        const next = await execute(s.repo.reserve(reservation(nextInput)));
        await execute(s.repo.advance(next, { ...next, phase: "issued" }));
        const sweep = await execute(s.allocations.reconcile({ limit: 2 }));
        expect(sweep.entries).toContainEqual({
          runId: s.input.consumer.runId,
          outcome: "unavailable",
        });
        expect(sweep.entries).toContainEqual({
          runId: nextInput.consumer.runId,
          outcome: "pending",
        });
        expect(sweep.next).toBe(
          [s.input.consumer.runId, nextInput.consumer.runId].toSorted().at(-1),
        );
        expect(s.provider.creates).toHaveLength(0);
      }));
    it("refuses release-before-reservation and never recreates a released consumer pin", () =>
      test(async (s) => {
        await execute(s.catalog.release(s.input.consumer, s.input.publication.publicationId));
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("pin-unavailable");
        expect(await execute(s.repo.get(s.input.consumer.runId))).toBeUndefined();
        expect(s.provider.creates).toHaveLength(0);
      }));
    it("bounds an unresolved create observation and later adopts its exact allocation", () =>
      test(async (s) => {
        const received = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        s.provider.beforeCreateReply = async () => {
          received.resolve();
          await release.promise;
        };
        await execute(s.repo.reserve(reservation(s.input)));
        try {
          const sweep = await execute(
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(s.allocations.reconcile({ limit: 20 }));
              yield* Effect.promise(() => received.promise);
              yield* TestClock.adjust(120001);
              return yield* Fiber.join(fiber);
            }).pipe(Effect.provide(TestClock.layer())),
          );
          expect(sweep.entries).toEqual([
            { runId: s.input.consumer.runId, outcome: "unavailable" },
          ]);
          expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
            phase: "issued",
          });
        } finally {
          release.resolve();
        }
        s.provider.beforeCreateReply = async () => {};
        expect((await execute(s.allocations.reconcile({ limit: 20 }))).entries[0]?.outcome).toBe(
          "bound",
        );
        expect(s.provider.creates).toHaveLength(1);
      }));
    it("wraps only after the last cursor page", () =>
      test(async (s) => {
        const record = await execute(s.repo.reserve(reservation(s.input)));
        await execute(s.repo.advance(record, { ...record, phase: "issued" }));
        const first = await execute(s.allocations.reconcile({ limit: 1 }));
        expect(first.next).toBe(s.input.consumer.runId);
        if (first.next === undefined) throw new Error("missing cursor");
        expect(await execute(s.allocations.reconcile({ limit: 1, after: first.next }))).toEqual({
          entries: [],
        });
        expect(s.provider.creates).toHaveLength(0);
      }));
  },
);
