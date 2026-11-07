import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  publicEncrypt,
  randomUUID,
} from "node:crypto";
import http from "node:http";

import { ResourceWorktreeKey, ResourceInstanceKey } from "@sealant/api-contracts";
import { credentialCipherLayer, type CredentialCipherError } from "@sealant/credentials";
import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  BoatTunnelRepo,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  boatTunnelRepoLayer,
  ResourceInstanceRepo,
  ResourceInstanceRepoLive,
  NativePublicationRepo,
  NativePublicationRepoLive,
  SealantDB,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  WorkspaceAttemptRepoLive,
  makeSealantDBLayer,
  user,
  workspaceAttempts,
  schema,
  type DB,
} from "@sealant/db";
import { corruptBoatAllocation } from "@sealant/db/testing/boat-allocations";
import { nativeConsumerRows } from "@sealant/db/testing/native-publications";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import {
  boatExecutionRecordSchema,
  boatAllocationInputSchema,
  boatAllocationRecordSchema,
  nativePublicationKeySchema,
  nativePublicationSchema,
  type BoatAllocationInput,
  type BoatAllocationRecord,
  type BoatExecutionTarget,
} from "@sealant/validators";
import { Context, Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BoatTunnelError,
  boatTunnelName,
  type BoatTunnelInput,
  type BoatTunnelEndpoint,
} from "../../resources/boat-tunnel.js";
import { makeResourceReconciler } from "../../resources/reconciler.js";
import { postgresSpec } from "../../resources/resource.fixture.js";
import { adoptStrandedLaunchesEffect } from "../../worker/adopt-stranded-launches.js";
import {
  boatAllocationWorkerLayer,
  boatWorkerExecutionLayer,
  boatReadinessWorkerLayer,
  boatFinalCloseWorkerLayer,
} from "../../worker/boat-allocation.js";
import { BoatReadiness, boatReadinessLayer } from "../../worker/boat-readiness.js";
import {
  BoatResources,
  BoatResourcesHost,
  boatResourcesLayer,
} from "../../worker/boat-resources.js";
import {
  fakeCaptureDaemon,
  savedStatus,
  captureStatus,
  type CaptureDaemonScriptEntry,
} from "../../worker/capture-daemon.fixture.js";
import { BoatAllocation, BoatAllocationProvider, boatAllocationLayer } from "./allocation.js";
import { HttpBoatApi } from "./api.js";
import { BoatSecret } from "./config.js";
import {
  BoatExecution,
  BoatGuestTransportService,
  boatExecutionLayer,
  type BoatGuestTransport,
} from "./execution.js";
import {
  BoatFinalClose,
  BoatFinalCloseProvider,
  boatFinalCloseLayerNoDeps,
} from "./final-close.js";

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
  sandboxMissing = false;
  beforeSandboxRead: () => Promise<void> = async () => {};
  deleteCalls = 0;
  deletionReads = 0;
  deletionCompleted = true;
  deletionForeign = false;
  deletionWrongId = false;
  deleteLost = false;
  deletionUnavailable = false;
  readonly deletionId = `bdop_${randomUUID().replaceAll("-", "")}`;
  beforeDeletion: () => Promise<void> = async () => {};
  deletion() {
    return {
      id: this.deletionWrongId ? "bdop_00000000000000000000000000000000" : this.deletionId,
      kind: "sandbox",
      targetId: this.deletionForeign ? "bx_3456789a" : "bx_23456789",
      status: this.deletionCompleted ? "completed" : "processing",
    };
  }

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
    if (request.method === "DELETE" && url.pathname === "/api/v1/sandboxes/bx_23456789") {
      this.deleteCalls++;
      await this.beforeDeletion();
      if (this.deleteLost) {
        response.destroy();
        return;
      }
      send({ ok: true, operation: this.deletion() });
      return;
    }
    if (url.pathname.startsWith("/api/v1/deletion-operations/")) {
      this.deletionReads++;
      if (this.deletionUnavailable) {
        send({ code: "unavailable" }, 503);
        return;
      }
      send({ ok: true, operation: this.deletion() });
      return;
    }
    if (url.pathname === "/api/v1/sandboxes/bx_23456789") {
      await this.beforeSandboxRead();
      if (this.sandboxMissing) {
        send({ code: "not_found" }, 404);
        return;
      }
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
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => JSON.stringify(key) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};
class GuestFixture implements BoatGuestTransport {
  starts = 0;
  permitCount = 0;
  readonly actions: string[] = [];
  beforePermit: () => Promise<void> = async () => {};
  beforeReady: () => Promise<void> = async () => {};

  async probe() {
    return {
      runtimeId: "rt_fixture",
      healthy: true,
      supports: ["exec.user", "dotfiles.user", "restore.owner_map", "process.secret-env.v1"],
    };
  }
  readonly targets: BoatExecutionTarget[] = [];
  fail = false;
  target: BoatExecutionTarget | undefined;
  admission: { epoch: number; operation_id: string } | undefined;
  readonly networkBodies: string[] = [];
  lostIsolation = false;
  beforeIsolate: () => Promise<void> = async () => {};
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
  async call(_host: unknown, bearer: BoatSecret, route: string, body?: Redacted.Redacted<string>) {
    this.actions.push(route);
    if (route === "stage")
      this.admission = z
        .object({ epoch: z.number(), operation_id: z.string() })
        .parse(JSON.parse(Redacted.value(body ?? Redacted.make(""))));
    if (route === "isolate") {
      await this.beforeIsolate();
      const raw = Redacted.value(body ?? Redacted.make(""));
      this.networkBodies.push(raw);
      if (this.lostIsolation) {
        this.lostIsolation = false;
        throw new Error("lost");
      }
      return {
        format: "sealant-guest-network-status-v1",
        binding: z.object({ binding: z.unknown() }).parse(JSON.parse(raw)).binding,
        receipt: "e".repeat(64),
        configured: true,
        handshake: "unverified",
        admission: "held",
      };
    }
    if (route === "permit" || route === "readiness") {
      const raw = Redacted.value(body ?? Redacted.make(""));
      const value = z
        .object({ binding: z.unknown(), permit_receipt: z.string().optional() })
        .parse(JSON.parse(raw));
      if (route === "permit") {
        this.permitCount++;
        await this.beforePermit();
        return {
          format: "sealant-execution-permitted-v1",
          binding: value.binding,
          receipt: hash(canonical(JSON.parse(raw))),
          handshake: "verified",
          dns: "udp-and-tcp",
          admission: "held",
        };
      }
      await this.beforeReady();
      return {
        format: "sealant-readiness-status-v1",
        binding: value.binding,
        permit_receipt: value.permit_receipt,
        invocation: "d".repeat(32),
        limits: { memory_bytes: 2147483648, cpu_millicores: 1000, tasks: 512 },
        handshake: "verified",
        dns: "udp-and-tcp",
        admission: "held",
      };
    }
    if (route === "start") this.starts = 1;
    expect(["status", "stage", "start"]).toContain(route);
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
      execution: this.starts > 0 ? "running" : "unavailable",
      epoch: this.admission?.epoch ?? null,
      operation_id: this.admission?.operation_id ?? null,
      stage: this.admission === undefined ? "empty" : "installed",
    };
  }
}
class GatewayFixture {
  allowRemoval = false;
  removalUnavailable = false;
  removeCalls = 0;
  beforeRemove: () => Promise<void> = async () => {};
  receipt = "c".repeat(64);
  readonly requests: BoatTunnelInput[] = [];
  unavailable = false;
  beforeReply: () => Promise<void> = async () => {};
  async ensure(input: BoatTunnelInput): Promise<BoatTunnelEndpoint> {
    this.requests.push(input);
    await this.beforeReply();
    if (this.unavailable) throw new Error("unknown gateway outcome");
    const publicKey = createPublicKey(
      createPrivateKey({
        key: Buffer.concat([
          Buffer.from("302e020100300506032b656e04220420", "hex"),
          Buffer.from(Redacted.value(input.privateKey), "base64"),
        ]),
        type: "pkcs8",
        format: "der",
      }),
    )
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64");
    return {
      container: boatTunnelName(input.target),
      containerId: "a".repeat(64),
      gatewayEpoch: "epoch",
      binding: "b".repeat(64),
      publicKey,
      peerKey: input.peerKey,
      listenPort: input.listenPort,
      reachSubnet: "10.98.0.32/27",
      gateway: "100.127.255.253",
      client: "100.127.255.254",
      receipt: this.receipt,
      peerHandshake: "unverified",
    };
  }
  remove() {
    return Effect.suspend(() => {
      if (!this.allowRemoval) return Effect.die("reconciliation must not remove custody");
      this.removeCalls++;
      return Effect.promise(() => this.beforeRemove()).pipe(
        Effect.andThen(() =>
          this.removalUnavailable
            ? Effect.fail(new BoatTunnelError("gateway-unavailable"))
            : Effect.void,
        ),
      );
    });
  }
}
const test = async (
  run: (s: {
    db: DB;
    input: BoatAllocationInput;
    allocations: BoatAllocation["Service"];
    executor: BoatExecution["Service"];
    resourceOwner: BoatResources["Service"];
    readiness: BoatReadiness["Service"];
    canonical: WorkspaceCaptureDrainRepo["Service"];
    final: (script: readonly CaptureDaemonScriptEntry[]) => Effect.Effect<{
      owner: BoatFinalClose["Service"];
      daemon: ReturnType<typeof fakeCaptureDaemon>;
    }>;
    reopenResources: (
      endpoint?: string,
      gatewayHostId?: string,
    ) => Effect.Effect<BoatResources["Service"], CredentialCipherError>;
    tunnels: BoatTunnelRepo["Service"];
    resources: ResourceInstanceRepo["Service"];
    gateway: GatewayFixture;
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
      boatTunnelRepoLayer,
      WorkspaceCaptureDrainRepoLive,
    ).pipe(Layer.provideMerge(DBLayer));
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* SealantDB;
        const catalog = yield* NativePublicationRepo;
        const repo = yield* BoatAllocationRepo;
        const runtimes = yield* WorkspaceRuntimeInstanceRepo;
        const executions = yield* BoatExecutionRepo;
        const tunnels = yield* BoatTunnelRepo;
        const captureRepo = yield* WorkspaceCaptureDrainRepo;
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
        const gateway = new GatewayFixture();
        const gatewayHostId = randomUUID();
        const hostLayer = (endpoint = "10.0.0.41", hostId: string = gatewayHostId) =>
          Layer.succeed(BoatResourcesHost, {
            deploymentId: "test",
            gatewayHostId: hostId,
            endpoint,
            subnets: {
              allocate: async () => "10.98.0.32/27",
              release: async () => {
                throw new Error("must retain subnet");
              },
            },
            tunnel: {
              ensure: (request) =>
                Effect.tryPromise({
                  try: () => gateway.ensure(request),
                  catch: () => new BoatTunnelError("gateway-unavailable"),
                }),
              remove: () => gateway.remove(),
            },
          });
        const ResourceLayer = boatResourcesLayer.pipe(Layer.provide(Exchange));
        const ResourceRoot: Layer.Layer<
          BoatAllocation | BoatResources | BoatReadiness | BoatFinalClose,
          CredentialCipherError
        > = Layer.mergeAll(
          boatReadinessWorkerLayer,
          boatFinalCloseWorkerLayer,
          boatAllocationWorkerLayer,
          boatResourcesLayer.pipe(Layer.provide(boatWorkerExecutionLayer)),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              Infra,
              hostLayer(),
              Layer.succeed(BoatFinalCloseProvider, { api: api.value }),
            ),
          ),
        );
        yield* Layer.build(ResourceRoot);
        const Test = Layer.mergeAll(
          boatAllocationLayer.pipe(Layer.provide(Exchange)),
          ResourceLayer,
          boatReadinessLayer.pipe(Layer.provide(Layer.merge(ResourceLayer, Exchange))),
          Exchange,
          ResourceInstanceRepoLive,
        ).pipe(Layer.provide(Layer.merge(Infra, hostLayer())));
        const context = yield* Layer.build(Test);
        const allocations = Context.get(context, BoatAllocation);
        const executor = Context.get(context, BoatExecution);
        const resourceOwner = Context.get(context, BoatResources);
        const resources = Context.get(context, ResourceInstanceRepo);
        const scope = yield* Effect.scope;
        const reopenResources = (endpoint = "10.0.0.41", hostId: string = gatewayHostId) =>
          Layer.buildWithScope(
            ResourceLayer.pipe(Layer.provide(Layer.merge(Infra, hostLayer(endpoint, hostId)))),
            scope,
          ).pipe(Effect.map((ctx) => Context.get(ctx, BoatResources)));
        yield* Effect.promise(() =>
          run({
            db,
            input,
            allocations,
            executor,
            resourceOwner,
            readiness: Context.get(context, BoatReadiness),
            canonical: captureRepo,
            final: (script) =>
              Effect.gen(function* () {
                const daemon = fakeCaptureDaemon(script);
                const layer = boatFinalCloseLayerNoDeps.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      Layer.succeed(BoatAllocationRepo, repo),
                      Layer.succeed(BoatTunnelRepo, tunnels),
                      Layer.succeed(WorkspaceCaptureDrainRepo, captureRepo),
                      Layer.succeed(WorkspaceRuntimeInstanceRepo, runtimes),
                      Layer.succeed(BoatExecution, executor),
                      Layer.succeed(SealantDB, db),
                      hostLayer(),
                      Layer.succeed(BoatFinalCloseProvider, { api: api.value }),
                      daemon.layer,
                    ),
                  ),
                );
                const built = yield* Layer.buildWithScope(layer, scope);
                return { owner: Context.get(built, BoatFinalClose), daemon };
              }),
            reopenResources,
            tunnels,
            resources,
            gateway,
            repo,
            catalog,
            runtimes,
            executions,
            provider,
            guest,
          }),
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

type AllocationFixture = Parameters<Parameters<typeof test>[0]>[0];
const launched = async (s: AllocationFixture) => {
  const target = await execute(s.allocations.prepare(s.input));
  await execute(
    s.readiness.launch(
      target,
      Redacted.make({
        files: [{ name: "launch", bytes: Buffer.from("launch") }],
        pins: { credentialVersions: [], dotfiles: [] },
      }),
    ),
  );
  return target;
};
const stopLaunched = async (s: AllocationFixture) => {
  const target = await launched(s);
  await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
  s.gateway.allowRemoval = true;
  return target;
};
const tunnelRecord = async (s: AllocationFixture, target: BoatExecutionTarget) => {
  const value = await execute(s.tunnels.get(target.runId));
  if (value === undefined) throw new Error("missing tunnel");
  return value;
};

describe.runIf(databaseUrl !== undefined)("Boat canonical FINAL close", () => {
  it("drains authenticated FINAL, proves exact provider and host cleanup, then reuses only the released port", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const { owner, daemon } = await execute(s.final([savedStatus()]));
      const beforeClose = await tunnelRecord(s, target);
      await expect(execute(s.tunnels.release(beforeClose))).rejects.toThrow("operation-held");
      await expect(
        execute(
          s.tunnels.recordRemoval(beforeClose, {
            id: s.provider.deletionId,
            targetId: target.sandboxId,
            completed: true,
          }),
        ),
      ).rejects.toThrow("binding-conflict");
      expect(await execute(owner.close(target))).toBe("closed");
      expect(daemon.flushRequests[0]?.kind).toBe("final");
      expect(s.provider.deleteCalls).toBe(1);
      expect(s.gateway.removeCalls).toBe(1);
      expect((await execute(s.canonical.getByRunId(target.runId)))?.deletionState).toBe("deleted");
      const terminal = await tunnelRecord(s, target);
      expect(terminal).toMatchObject({
        released: true,
        removal: { id: s.provider.deletionId, completed: true },
        updates: [],
      });
      expect((await execute(s.executions.get(target.runId)))?.phase).toBe("held");
      expect(
        (await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId)))?.removedAt,
      ).not.toBeNull();
      expect(await execute(owner.close(target))).toBe("closed");
      expect(s.provider.deleteCalls).toBe(1);
      expect(s.gateway.removeCalls).toBe(1);
      await expect(execute(s.resourceOwner.prepare(target))).rejects.toThrow("held");
      const prior = await execute(s.executions.get(target.runId));
      if (prior === undefined) throw new Error("missing execution");
      const nextId = `run_${randomUUID()}`;
      const [attempt] = await execute(s.db.select().from(workspaceAttempts));
      if (attempt === undefined) throw new Error("missing attempt");
      await execute(
        s.db.insert(workspaceAttempts).values({ id: nextId, ownerUserId: attempt.ownerUserId }),
      );
      const nextTarget = {
        ...target,
        runId: nextId,
        runtimeInstanceId: nextId,
        sandboxId: "bx_3456789a",
        diskLineage: randomUUID(),
        bootId: randomUUID(),
      };
      const exchange = await execute(
        s.executions.reserve(
          boatExecutionRecordSchema.parse({
            ...prior,
            target: nextTarget,
            phase: "exchange",
            sealedExchange: "test-exchange",
            sealedControl: null,
            admission: null,
            isolation: undefined,
          }),
        ),
      );
      await execute(
        s.executions.advance(exchange, {
          ...exchange,
          phase: "control",
          sealedExchange: null,
          sealedControl: "test-control",
        }),
      );
      const next = await execute(
        s.tunnels.reserve(
          { target: nextTarget, gatewayHostId: terminal.binding.gatewayHostId },
          randomUUID(),
        ),
      );
      expect(next.listenPort).toBe(terminal.listenPort);
      expect(await tunnelRecord(s, target)).toEqual(terminal);
    }));
  it("refuses an active run and a stopped run whose invocation was never positively running", () =>
    test(async (s) => {
      const target = await s.allocations.prepare(s.input).pipe(execute);
      const { owner, daemon } = await execute(s.final([savedStatus()]));
      await expect(execute(owner.close(target))).rejects.toThrow("held");
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      await expect(execute(owner.close(target))).rejects.toThrow("held");
      expect(daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(0);
    }));
  it("retains empty but incomplete FINAL and later retries the same held VM without launching again", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const first = await execute(s.final([captureStatus({ complete: false })]));
      expect(await execute(first.owner.close(target))).toBe("retained");
      expect((await tunnelRecord(s, target)).released).toBeUndefined();
      expect(s.provider.deleteCalls).toBe(0);
      expect((await execute(s.executions.get(target.runId)))?.phase).toBe("held");
      const second = await execute(s.final([savedStatus()]));
      expect(await execute(second.owner.close(target))).toBe("closed");
      expect(s.guest.starts).toBe(1);
    }));
  it("an outstanding host mutation holds custody until that exact request positively returns", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const before = await tunnelRecord(s, target);
      const id = randomUUID();
      expect(await execute(s.tunnels.beginUpdate(before, id))).toBe("issued");
      const { owner, daemon } = await execute(s.final([savedStatus()]));
      await expect(execute(owner.close(target))).rejects.toThrow("unavailable");
      expect(daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(0);
      await execute(s.tunnels.endUpdate(before.binding, id));
      expect(await execute(owner.close(target))).toBe("closed");
    }));
  it("a pending deletion keeps its exact operation and port, then resumes by observation without another DELETE", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      s.provider.deletionCompleted = false;
      const { owner } = await execute(s.final([savedStatus()]));
      await expect(execute(owner.close(target))).rejects.toThrow("pending");
      expect((await execute(s.canonical.getByRunId(target.runId)))?.deletionState).toBe(
        "deleting-issued",
      );
      expect((await tunnelRecord(s, target)).removal).toEqual({
        id: s.provider.deletionId,
        completed: false,
      });
      expect(s.gateway.removeCalls).toBe(0);
      s.provider.deletionUnavailable = true;
      await expect(execute(owner.close(target))).rejects.toThrow("unavailable");
      s.provider.deletionUnavailable = false;
      s.provider.deletionWrongId = true;
      await expect(execute(owner.close(target))).rejects.toThrow("unavailable");
      s.provider.deletionWrongId = false;
      expect((await tunnelRecord(s, target)).removal?.id).toBe(s.provider.deletionId);
      expect(await execute(owner.close(target))).toBe("pending");
      s.provider.deletionCompleted = true;
      const restarted = await execute(s.final(["unreachable"]));
      expect(await execute(restarted.owner.close(target))).toBe("closed");
      expect(restarted.daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(1);
      const completed = await tunnelRecord(s, target);
      expect(
        await execute(
          s.tunnels.recordRemoval(completed, {
            id: s.provider.deletionId,
            targetId: target.sandboxId,
            completed: false,
          }),
        ),
      ).toEqual(completed);
    }));
  it("a lost DELETE response is retried only against the same positively owned sandbox and unchanged evidence", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      s.provider.deleteLost = true;
      const { owner } = await execute(s.final([savedStatus()]));
      await expect(execute(owner.close(target))).rejects.toThrow("unavailable");
      expect((await tunnelRecord(s, target)).removal).toBeUndefined();
      expect((await execute(s.canonical.getByRunId(target.runId)))?.deletionState).toBe(
        "deleting-issued",
      );
      s.provider.deleteLost = false;
      const restarted = await execute(s.final(["unreachable"]));
      expect(await execute(restarted.owner.close(target))).toBe("closed");
      expect(s.provider.deleteCalls).toBe(2);
      expect(restarted.daemon.calls).toEqual([]);
    }));
  it("absence after a lost response never substitutes for exact deletion completion", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      s.provider.deleteLost = true;
      const { owner } = await execute(s.final([savedStatus()]));
      await expect(execute(owner.close(target))).rejects.toThrow("unavailable");
      s.provider.sandboxMissing = true;
      await expect(execute(owner.close(target))).rejects.toThrow("unavailable");
      expect(s.provider.deleteCalls).toBe(1);
      expect(s.gateway.removeCalls).toBe(0);
      expect((await tunnelRecord(s, target)).released).toBeUndefined();
    }));
  it("refuses a foreign deletion target without removing host custody", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      s.provider.deletionForeign = true;
      const { owner } = await execute(s.final([savedStatus()]));
      await expect(execute(owner.close(target))).rejects.toThrow("held");
      expect(s.gateway.removeCalls).toBe(0);
      expect((await tunnelRecord(s, target)).removal).toBeUndefined();
    }));
  it("refuses provider label changes and a newer unsaved observation before issuance", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const { owner } = await execute(s.final([savedStatus()]));
      s.provider.foreign = true;
      await expect(execute(owner.close(target))).rejects.toThrow("held");
      expect(s.provider.deleteCalls).toBe(0);
      s.provider.foreign = false;
      s.provider.beforeSandboxRead = async () => {
        await execute(
          s.canonical.recordStatus({
            runId: target.runId,
            status: { ...captureStatus({ complete: false }) },
            observedAt: new Date(),
          }),
        );
      };
      await expect(execute(owner.close(target))).rejects.toThrow("held");
      expect(s.provider.deleteCalls).toBe(0);
      expect((await tunnelRecord(s, target)).released).toBeUndefined();
    }));
  it("host cleanup failure retains the slot after positive VM deletion and resumes without another FINAL or DELETE", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      s.gateway.removalUnavailable = true;
      const { owner } = await execute(s.final([savedStatus()]));
      await expect(execute(owner.close(target))).rejects.toThrow("unavailable");
      expect((await tunnelRecord(s, target)).released).toBeUndefined();
      expect((await execute(s.canonical.getByRunId(target.runId)))?.deletionState).toBe("deleted");
      s.gateway.removalUnavailable = false;
      const restarted = await execute(s.final(["unreachable"]));
      expect(await execute(restarted.owner.close(target))).toBe("closed");
      expect(restarted.daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(1);
      expect(s.gateway.removeCalls).toBe(2);
    }));
  it("concurrent closes cannot drain or delete twice while the first FINAL is in flight", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const reached = await execute(Deferred.make<void>()),
        open = await execute(Deferred.make<void>());
      const { owner } = await execute(s.final([{ gated: savedStatus(), reached, open }]));
      const first = execute(owner.close(target));
      await execute(Deferred.await(reached));
      try {
        expect(await execute(owner.close(target))).toBe("retained");
      } finally {
        await execute(Deferred.succeed(open, undefined));
      }
      expect(await first).toBe("closed");
      expect(s.provider.deleteCalls).toBe(1);
    }));
});

describe.runIf(databaseUrl !== undefined)(
  "Boat allocation through PostgreSQL and provider HTTP",
  () => {
    it("reconciles installed network custody after reply loss through rebuilt production assemblies", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        expect((await execute(s.resourceOwner.reconcile({ limit: 20 }))).entries).toEqual([
          { runId: target.runId, outcome: "pending" },
        ]);
        expect(s.gateway.requests).toHaveLength(0);
        await execute(
          s.executor.stage(
            target.runId,
            Redacted.make({
              files: [{ name: "launch", bytes: Buffer.from("launch") }],
              pins: { credentialVersions: [], dotfiles: [] },
            }),
          ),
        );
        s.guest.lostIsolation = true;
        expect((await execute(s.resourceOwner.reconcile({ limit: 20 }))).entries[0]?.outcome).toBe(
          "unavailable",
        );
        const frozen = await execute(s.tunnels.get(target.runId));
        expect(frozen?.network).toMatchObject({
          endpoint: "10.0.0.41",
          subnet: "10.98.0.32/27",
          epoch: 1,
        });
        const reopened = await execute(s.reopenResources());
        const result = await execute(reopened.prepare(target));
        expect(result.guest).toMatchObject({ handshake: "unverified", admission: "held" });
        expect(await execute(s.tunnels.get(target.runId))).toEqual(frozen);
        expect(s.gateway.requests[0]?.listenPort).toBe(s.gateway.requests[1]?.listenPort);
        expect(new Set(s.guest.networkBodies).size).toBe(1);
        expect(s.provider.creates).toHaveLength(1);
        expect((await execute(s.executions.get(target.runId)))?.phase).toBe("installed");
        for (const key of [s.gateway.requests[0]?.privateKey])
          if (key !== undefined) expect(JSON.stringify(frozen)).not.toContain(Redacted.value(key));
        for (const changed of [{ bootId: randomUUID() }, { diskLineage: "foreign" }])
          await expect(execute(reopened.prepare({ ...target, ...changed }))).rejects.toThrow(
            "binding-conflict",
          );
        const moved = await execute(s.reopenResources("10.0.0.42"));
        await expect(execute(moved.prepare(target))).rejects.toThrow("binding-conflict");
        const foreignHost = await execute(s.reopenResources("10.0.0.41", randomUUID()));
        await expect(execute(foreignHost.prepare(target))).rejects.toThrow("binding-conflict");
        expect(s.gateway.requests).toHaveLength(2);
      }));
    it("launches only after current isolation and observes authenticated readiness without another invocation", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        const payload = Redacted.make({
          files: [{ name: "launch", bytes: Buffer.from("launch") }],
          pins: { credentialVersions: [], dotfiles: [] },
        });
        expect(await execute(s.readiness.launch(target, payload))).toMatchObject({
          runtimeId: "rt_fixture",
          handshake: "verified",
          admission: "held",
        });
        expect(await execute(s.readiness.observe(target))).toMatchObject({
          invocation: "d".repeat(32),
        });
        expect(s.guest.actions.indexOf("stage")).toBeLessThan(s.guest.actions.indexOf("isolate"));
        expect(s.guest.actions.indexOf("isolate")).toBeLessThan(s.guest.actions.indexOf("permit"));
        expect(s.guest.actions.indexOf("permit")).toBeLessThan(s.guest.actions.indexOf("start"));
        expect(s.guest.starts).toBe(1);
        const before = s.guest.actions.length;
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        await expect(execute(s.readiness.observe(target))).rejects.toThrow("held");
        await expect(execute(s.readiness.launch(target, payload))).rejects.toThrow("held");
        expect(s.guest.actions).toHaveLength(before);
      }));
    it("changed gateway custody during readiness refuses the observation", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        s.guest.beforeReady = async () => {
          s.gateway.receipt = "d".repeat(64);
        };
        await expect(
          execute(
            s.readiness.launch(
              target,
              Redacted.make({
                files: [{ name: "launch", bytes: Buffer.from("launch") }],
                pins: { credentialVersions: [], dotfiles: [] },
              }),
            ),
          ),
        ).rejects.toThrow("held");
        expect(s.guest.starts).toBe(1);
        expect(s.guest.permitCount).toBe(1);
      }));
    it("a stop accepted during authenticated readiness keeps the result held", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        s.guest.beforeReady = () =>
          execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" })).then(
            () => undefined,
          );
        await expect(
          execute(
            s.readiness.launch(
              target,
              Redacted.make({
                files: [{ name: "launch", bytes: Buffer.from("launch") }],
                pins: { credentialVersions: [], dotfiles: [] },
              }),
            ),
          ),
        ).rejects.toThrow("held");
        expect(s.guest.starts).toBe(1);
      }));
    it("a stop accepted during permit delivery prevents invocation issuance", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        s.guest.beforePermit = () =>
          execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" })).then(
            () => undefined,
          );
        await expect(
          execute(
            s.readiness.launch(
              target,
              Redacted.make({
                files: [{ name: "launch", bytes: Buffer.from("launch") }],
                pins: { credentialVersions: [], dotfiles: [] },
              }),
            ),
          ),
        ).rejects.toThrow("held");
        expect(s.guest.permitCount).toBe(1);
        expect(s.guest.starts).toBe(0);
      }));
    it("bounds a stalled gateway and retries only the same durable network intent", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        await execute(
          s.executor.stage(
            target.runId,
            Redacted.make({
              files: [{ name: "launch", bytes: Buffer.from("launch") }],
              pins: { credentialVersions: [], dotfiles: [] },
            }),
          ),
        );
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        s.gateway.beforeReply = async () => {
          entered.resolve();
          await release.promise;
        };
        try {
          const sweep = await execute(
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(s.resourceOwner.reconcile({ limit: 20 }));
              yield* Effect.promise(() => entered.promise);
              yield* TestClock.adjust(120001);
              return yield* Fiber.join(fiber);
            }).pipe(Effect.provide(TestClock.layer())),
          );
          expect(sweep.entries).toEqual([{ runId: target.runId, outcome: "unavailable" }]);
          expect((await execute(s.tunnels.get(target.runId)))?.network).toBeDefined();
        } finally {
          release.resolve();
        }
        s.gateway.beforeReply = async () => {};
        expect((await execute(s.resourceOwner.reconcile({ limit: 20 }))).entries).toEqual([
          { runId: target.runId, outcome: "configured" },
        ]);
        expect(s.gateway.requests[0]?.listenPort).toBe(s.gateway.requests[1]?.listenPort);
        expect(s.guest.networkBodies).toHaveLength(1);
      }));
    it("advances the resource cursor past malformed and pending entries without allocating or issuing", () =>
      test(async (s) => {
        const reserved = await execute(s.repo.reserve(reservation(s.input)));
        await execute(
          corruptBoatAllocation(s.db, s.input.consumer.runId, { ...reserved, phase: "broken" }),
        );
        const second = await execute(seed(s.db, s.catalog));
        await execute(s.repo.reserve(reservation(second)));
        const sweep = await execute(s.resourceOwner.reconcile({ limit: 2 }));
        expect(sweep.entries).toContainEqual({
          runId: s.input.consumer.runId,
          outcome: "unavailable",
        });
        expect(sweep.entries).toContainEqual({ runId: second.consumer.runId, outcome: "pending" });
        expect(sweep.next).toBe([s.input.consumer.runId, second.consumer.runId].toSorted().at(-1));
        if (sweep.next === undefined) throw new Error("missing cursor");
        expect(await execute(s.resourceOwner.reconcile({ limit: 2, after: sweep.next }))).toEqual({
          entries: [],
        });
        expect(s.provider.creates).toHaveLength(0);
        expect(s.gateway.requests).toHaveLength(0);
        expect(s.guest.networkBodies).toHaveLength(0);
      }));
    it("keeps current linked resources reached and applies unlinks without releasing the gateway", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        await execute(
          s.executor.stage(
            target.runId,
            Redacted.make({
              files: [{ name: "launch", bytes: Buffer.from("launch") }],
              pins: { credentialVersions: [], dotfiles: [] },
            }),
          ),
        );
        if (s.input.scope.kind !== "owner") throw new Error("expected owner scope");
        const domainId = `rdm:${randomUUID()}`;
        await execute(
          s.db
            .insert(schema.workspaces)
            .values({ id: target.workspaceId, ownerUserId: s.input.scope.ownerUserId }),
        );
        await execute(
          s.db
            .insert(schema.workspaceRunLinks)
            .values({ workspaceId: target.workspaceId, runId: target.runId }),
        );
        await execute(s.db.insert(schema.resourceDomains).values({ id: domainId, key: domainId }));
        const link = {
          workspaceId: target.workspaceId,
          resourceDomainId: domainId,
          worktreeKey: ResourceWorktreeKey.make("tree"),
          aliases: null,
        };
        await execute(s.resources.link(link));
        const outcome = await execute(
          s.resources.up({
            resourceDomainId: domainId,
            key: ResourceInstanceKey.make("db"),
            spec: postgresSpec({ idleStopAfterSeconds: 1 }),
            cause: "use",
          }),
        );
        if (outcome.kind !== "upserted") throw new Error("resource missing");
        await execute(s.resourceOwner.prepare(target));
        expect(s.gateway.requests.at(-1)?.link).toEqual(link);
        expect(s.gateway.requests.at(-1)?.instances.map((value) => value.id)).toEqual([
          outcome.instance.id,
        ]);
        expect(await execute(s.resourceOwner.reach())).toEqual([link]);
        await execute(
          s.resources.recordObserved(
            outcome.instance.id,
            { kind: "running", since: "2026-01-01T00:00:00Z" },
            { startedAt: new Date("2026-01-01T00:00:00Z") },
          ),
        );
        const stopped: string[] = [];
        const tick = makeResourceReconciler({
          repo: s.resources,
          externalReach: () => execute(s.resourceOwner.reach()),
          runtime: {
            observe: async () =>
              new Map([[outcome.instance.id, { running: true, exitCode: null }]]),
            up: async () => {
              throw new Error("already running");
            },
            stop: async (instance) => {
              stopped.push(instance.id);
            },
            archive: async () => [],
            exec: async () => {
              throw new Error("unused");
            },
            attachExecutor: async () => {
              throw new Error("Boat owns attachments");
            },
            detachExecutor: async () => {
              throw new Error("Boat owns cleanup");
            },
            converge: async ({ liveExecutors, desired }) => {
              expect(liveExecutors).toEqual([]);
              expect(desired).toEqual([]);
            },
          },
        });
        expect(await tick.tick(new Date("2030-01-01T00:00:00Z"))).toMatchObject({
          reached: 1,
          idleStopped: [],
          problems: [],
        });
        expect(stopped).toEqual([]);
        await execute(s.resources.unlink(target.workspaceId));
        await execute(s.resourceOwner.prepare(target));
        expect(s.gateway.requests.at(-1)?.link).toBeUndefined();
        expect(s.gateway.requests.at(-1)?.instances).toEqual([]);
        expect(await execute(s.resourceOwner.reach())).toEqual([]);
        expect((await execute(s.tunnels.get(target.runId)))?.network).toBeDefined();
      }));
    it("retains exact gateway obligations after unknown outcomes and refuses a stop before guest delivery", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        await execute(
          s.executor.stage(
            target.runId,
            Redacted.make({
              files: [{ name: "launch", bytes: Buffer.from("launch") }],
              pins: { credentialVersions: [], dotfiles: [] },
            }),
          ),
        );
        s.gateway.unavailable = true;
        await expect(execute(s.resourceOwner.prepare(target))).rejects.toThrow("unavailable");
        const frozen = await execute(s.tunnels.get(target.runId));
        expect(frozen?.network).toBeDefined();
        expect(s.guest.networkBodies).toHaveLength(0);
        s.gateway.unavailable = false;
        s.gateway.beforeReply = async () => {
          await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        };
        await expect(execute(s.resourceOwner.prepare(target))).rejects.toThrow("held");
        expect(s.guest.networkBodies).toHaveLength(0);
        expect(await execute(s.tunnels.get(target.runId))).toEqual(frozen);
        expect(await execute(s.resourceOwner.reach())).toEqual([]);
      }));
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
