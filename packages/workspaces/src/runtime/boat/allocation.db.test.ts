import { createHash, randomUUID } from "node:crypto";
import http from "node:http";

import { ResourceWorktreeKey, ResourceInstanceKey } from "@sealant/api-contracts";
import {
  CredentialCipher,
  credentialCipherLayer,
  type CredentialCipherError,
} from "@sealant/credentials";
import {
  BoatAllocationRepo,
  BoatControlRequestRepo,
  boatControlRequestRepoLayer,
  BoatAllocationRepoLive,
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  BoatTunnelRepo,
  BoatObservationRepo,
  BoatObservationRepoLive,
  LAUNCH_RETAINED_ERROR_CODE,
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
import {
  backdateAllocation,
  backdateObservation,
  corruptBoatAllocation,
  holdBoatLaunch,
  recordRetainedBoatLaunch,
  restoreUnprogressedCaptureDrain,
  strandBoatLaunch,
} from "@sealant/db/testing/boat-allocations";
import {
  makeParkingActionDue,
  backdateUnenrolledParkingRetention,
} from "@sealant/db/testing/capture-preservation";
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
import { Context, Deferred, Effect, Fiber, Layer, Redacted, ManagedRuntime } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { boatProofConfigSchema } from "../../operator/boat-live-check.js";
import { makeBoatProofCore } from "../../operator/boat-proof-core.js";
import { BoatTunnelError } from "../../resources/boat-tunnel.js";
import { makeResourceReconciler } from "../../resources/reconciler.js";
import { postgresSpec } from "../../resources/resource.fixture.js";
import { BoatParking, BoatParkingProvider, boatParkingLayer } from "../../runtime/boat/parking.js";
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
import { cases as launchCases } from "../docker-runtime-adapter.golden-fixture.js";
import { LaunchRetainedError } from "../launch-retention.js";
import { BoatRuntimeAdapter } from "./adapter.js";
import { ProviderFixture, GuestFixture, GatewayFixture } from "./allocation.fixture.js";
import { BoatAllocation, boatAllocationLayer, boatAllocationLayerNoDeps } from "./allocation.js";
import { HttpBoatApi } from "./api.js";
import { BoatOwnership, BoatSecret } from "./config.js";
import { boatDischargeLayerNoDeps } from "./discharge.js";
import {
  BoatExecution,
  BoatGuestTransportService,
  boatExecutionLayer,
  type BoatLaunchMaterial,
} from "./execution.js";
import {
  BoatFinalClose,
  BoatFinalCloseProvider,
  boatFinalCloseLayerNoDeps,
} from "./final-close.js";
import {
  BoatInteractiveControl,
  boatInteractiveControlLayerNoDeps,
  serveBoatControlRequests,
} from "./interactive-control.js";
import { BoatObserver, boatObserverLayer, boatObserverLayerNoDeps } from "./observation.js";
import { BoatAllocationProvider } from "./provider.js";
import { RecordedBoat } from "./recorded-boat.fixture.js";
import {
  BoatTunnelCarrier,
  boatTunnelCarrierAbsent,
  type BoatTunnelCarrierInput,
} from "./tunnel-carrier.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** The agent manifest digest the seeded publication's receipt records. */
const AGENT_MANIFEST_DIGEST = hash("boat agent manifest");
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
    const runId = randomUUID();
    yield* db
      .insert(user)
      .values({ id: owner, email: `${owner}@example.invalid`, name: "allocation test" });
    yield* db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner });
    const runtime = {
      source: `ghcr.io/sealant-sh/sealantd-next:test@sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
      manifest: "a".repeat(64),
      sealantd: "b".repeat(64),
      sealantctl: "c".repeat(64),
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
    const receipt = JSON.stringify({
      version: 4,
      ownership,
      owner: randomUUID(),
      build: ownership.buildId,
      recipeHash: key.recipeHash,
      assetsHash: key.assetsHash,
      runtime: key.runtime,
      probe,
      agent: { manifestDigest: AGENT_MANIFEST_DIGEST },
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

const test = async (
  run: (s: {
    databaseUrl: string;
    api: HttpBoatApi;
    db: DB;
    input: BoatAllocationInput;
    allocations: BoatAllocation["Service"];
    parking: (
      script: readonly CaptureDaemonScriptEntry[],
      automaticParkingEnabled?: boolean,
    ) => Effect.Effect<BoatParking["Service"], CredentialCipherError>;
    executor: BoatExecution["Service"];
    resourceOwner: BoatResources["Service"];
    readiness: BoatReadiness["Service"];
    canonical: WorkspaceCaptureDrainRepo["Service"];
    final: (
      script: readonly CaptureDaemonScriptEntry[],
      boatApi?: HttpBoatApi,
      deletionWaitMs?: number,
      parksRetained?: boolean,
    ) => Effect.Effect<{
      owner: BoatFinalClose["Service"];
      daemon: ReturnType<typeof fakeCaptureDaemon>;
    }>;
    reopenResources: (
      endpoint?: string,
      gatewayHostId?: string,
      relay?: string,
    ) => Effect.Effect<BoatResources["Service"], CredentialCipherError>;
    /** What a relay-configured host asked its (recording) carrier to keep open. */
    carried: BoatTunnelCarrierInput[];
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
        // A UDP-only host has no relay and the absent carrier; a relay records what it carries.
        const carried: BoatTunnelCarrierInput[] = [];
        const recordingCarrier = Layer.succeed(
          BoatTunnelCarrier,
          BoatTunnelCarrier.of({
            ensure: (carrierInput) => Effect.sync(() => void carried.push(carrierInput)),
            release: () => Effect.void,
            attached: () => Effect.succeed(false),
          }),
        );
        const hostLayer = (
          endpoint = "10.0.0.41",
          hostId: string = gatewayHostId,
          relay?: string,
        ) =>
          Layer.merge(
            relay === undefined ? boatTunnelCarrierAbsent : recordingCarrier,
            Layer.succeed(BoatResourcesHost, {
              ...(relay === undefined ? {} : { relay: { host: relay } }),
              deploymentId: "test",
              gatewayHostId: hostId,
              endpoint,
              subnets: {
                allocate: async () => {
                  await gateway.beforeSubnet();
                  if (gateway.subnetUnavailable) throw new Error("subnet allocator unavailable");
                  return "10.98.0.32/27";
                },
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
            }),
          );
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
          boatAllocationLayer.pipe(Layer.provide(Layer.merge(Exchange, boatObserverLayer))),
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
        const reopenResources = (
          endpoint = "10.0.0.41",
          hostId: string = gatewayHostId,
          relay?: string,
        ) =>
          Layer.buildWithScope(
            ResourceLayer.pipe(
              Layer.provide(Layer.merge(Infra, hostLayer(endpoint, hostId, relay))),
            ),
            scope,
          ).pipe(Effect.map((ctx) => Context.get(ctx, BoatResources)));
        yield* Effect.promise(() =>
          run({
            databaseUrl: url,
            api: api.value,
            db,
            input,
            allocations,
            parking: (script, automaticParkingEnabled = true) =>
              Layer.buildWithScope(
                boatParkingLayer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      Exchange,
                      boatReadinessLayer.pipe(Layer.provide(Layer.merge(ResourceLayer, Exchange))),
                      fakeCaptureDaemon(script).layer,
                      Layer.succeed(BoatParkingProvider, {
                        api: api.value,
                        automaticParkingEnabled,
                        retainedParkingDelaySeconds: 300,
                      }),
                    ),
                  ),
                  Layer.provide(Layer.merge(Infra, hostLayer())),
                ),
                scope,
              ).pipe(Effect.map((ctx) => Context.get(ctx, BoatParking))),
            executor,
            resourceOwner,
            readiness: Context.get(context, BoatReadiness),
            canonical: captureRepo,
            final: (script, boatApi = api.value, deletionWaitMs = 0, parksRetained = false) =>
              Effect.gen(function* () {
                const daemon = fakeCaptureDaemon(script);
                const layer = boatFinalCloseLayerNoDeps.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      Layer.succeed(NativePublicationRepo, catalog),
                      Layer.succeed(BoatAllocationRepo, repo),
                      Layer.succeed(BoatExecutionRepo, executions),
                      Layer.succeed(BoatTunnelRepo, tunnels),
                      Layer.succeed(WorkspaceCaptureDrainRepo, captureRepo),
                      Layer.succeed(WorkspaceRuntimeInstanceRepo, runtimes),
                      Layer.succeed(BoatExecution, executor),
                      Layer.succeed(SealantDB, db),
                      hostLayer(),
                      Layer.succeed(BoatFinalCloseProvider, {
                        api: boatApi,
                        deletionWaitMs,
                        parksRetained,
                      }),
                      BoatObservationRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db))),
                      WorkspaceAttemptRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db))),
                      boatDischargeLayerNoDeps.pipe(
                        Layer.provide(
                          Layer.mergeAll(
                            BoatObservationRepoLive.pipe(
                              Layer.provide(Layer.succeed(SealantDB, db)),
                            ),
                            Layer.succeed(SealantDB, db),
                            Layer.succeed(BoatAllocationRepo, repo),
                            Layer.succeed(BoatTunnelRepo, tunnels),
                            Layer.succeed(BoatExecutionRepo, executions),
                            Layer.succeed(WorkspaceCaptureDrainRepo, captureRepo),
                            Layer.succeed(NativePublicationRepo, catalog),
                            hostLayer(),
                          ),
                        ),
                      ),
                      boatObserverLayerNoDeps.pipe(
                        Layer.provide(
                          Layer.mergeAll(
                            BoatObservationRepoLive.pipe(
                              Layer.provide(Layer.succeed(SealantDB, db)),
                            ),
                            Layer.succeed(BoatAllocationRepo, repo),
                            Layer.succeed(BoatAllocationProvider, {
                              deploymentId: "test",
                              api: boatApi,
                            }),
                          ),
                        ),
                      ),
                      daemon.layer,
                    ),
                  ),
                );
                const built = yield* Layer.buildWithScope(layer, scope);
                return { owner: Context.get(built, BoatFinalClose), daemon };
              }),
            reopenResources,
            carried,
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
    manifestDigest: AGENT_MANIFEST_DIGEST,
    idempotencyKey: randomUUID(),
    diskLineage: randomUUID(),
    phase: "reserved",
    sandboxId: null,
    conflictingSandboxes: [],
    target: null,
    reason: null,
  });

type AllocationFixture = Parameters<Parameters<typeof test>[0]>[0];
/** The launch material a test pushes: a capture-sourced boot environment and no secrets. */
const launchMaterial = (): BoatLaunchMaterial => ({
  bootEnv: { SEALANT_WORKSPACE_SOURCE: "capture" },
  secretEnv: { SEALANT_CAPTURE_TOKEN: "local-proof-token" },
  pins: { credentialVersions: [], dotfiles: [] },
  docker: false,
});
const launched = async (s: AllocationFixture) => {
  const target = await execute(s.allocations.prepare(s.input));
  await execute(s.readiness.launch(target, Redacted.make(launchMaterial())));
  return target;
};
const linkedResource = async (s: AllocationFixture) => {
  if (s.input.scope.kind !== "owner") throw new Error("expected owner scope");
  const domainId = `rdm:${randomUUID()}`;
  await execute(
    s.db.insert(schema.workspaces).values({
      id: s.input.workspaceId,
      ownerUserId: s.input.scope.ownerUserId,
    }),
  );
  await execute(
    s.db.insert(schema.workspaceRunLinks).values({
      workspaceId: s.input.workspaceId,
      runId: s.input.consumer.runId,
    }),
  );
  await execute(s.db.insert(schema.resourceDomains).values({ id: domainId, key: domainId }));
  await execute(
    s.resources.link({
      workspaceId: s.input.workspaceId,
      resourceDomainId: domainId,
      worktreeKey: ResourceWorktreeKey.make("tree"),
      aliases: null,
    }),
  );
  const outcome = await execute(
    s.resources.up({
      resourceDomainId: domainId,
      key: ResourceInstanceKey.make("db"),
      spec: postgresSpec(),
      cause: "use",
    }),
  );
  if (outcome.kind !== "upserted") throw new Error("resource missing");
  return outcome.instance;
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

const adapterFixture = async (s: AllocationFixture) => {
  const close = await execute(s.final([savedStatus()]));
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(BoatAllocation, s.allocations),
      Layer.succeed(BoatReadiness, s.readiness),
      Layer.succeed(BoatExecution, s.executor),
      Layer.succeed(BoatFinalClose, close.owner),
      Layer.succeed(BoatAllocationRepo, s.repo),
      Layer.succeed(WorkspaceRuntimeInstanceRepo, s.runtimes),
    ),
  );
  if (s.input.scope.kind !== "owner") throw new Error("expected owned fixture");
  const input = {
    ...launchCases.capture,
    secretEnvDir: undefined,
    runId: s.input.consumer.runId,
    workspaceId: s.input.workspaceId,
    principalId: s.input.scope.ownerUserId,
    launchId: s.input.launchAttemptId,
    publication: s.input.publication,
    admissionPins: { credentialVersions: [], dotfiles: [] },
  };
  await execute(
    s.runtimes.upsertRuntimeInstance({
      runId: input.runId,
      adapter: "boat",
      status: "pending",
      sourceKind: "capture",
      publication: input.publication,
      imageScope: s.input.scope,
    }),
  );
  const adapter = new BoatRuntimeAdapter({
    deploymentId: "test",
    ownerIds: [input.principalId],
    runtime,
  });
  return { runtime, adapter, input, close };
};

describe.runIf(databaseUrl !== undefined)("Boat ordinary runtime adapter", () => {
  it("closes an allocator failure before gateway dispatch with positive deletion, slot and pin release", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      s.gateway.subnetUnavailable = true;
      s.gateway.allowRemoval = true;
      try {
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        expect(s.gateway.requests).toEqual([]);
        const target = (await execute(s.repo.get(f.input.runId)))?.target;
        if (target == null) throw new Error("missing bound target");
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        expect(await f.adapter.closeCapture({ resourceId: target.sandboxId }, target.runId)).toBe(
          "closed",
        );
        expect(await execute(s.repo.get(target.runId))).toMatchObject({
          phase: "deleted",
          removal: { kind: "operation", completed: true },
        });
        expect(await execute(s.tunnels.get(target.runId))).toMatchObject({ released: true });
        expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.guest.starts).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("fences a legacy undispatched update while its allocator is still pending", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      s.gateway.allowRemoval = true;
      s.gateway.beforeSubnet = async () => {
        entered.resolve();
        await release.promise;
      };
      const launching = f.adapter.launch(f.input).catch((error: unknown) => error);
      try {
        await entered.promise;
        const target = (await execute(s.repo.get(f.input.runId)))?.target;
        if (target == null) throw new Error("missing bound target");
        const before = await tunnelRecord(s, target);
        // The previous worker issued an update before allocating/configuring its subnet.
        await execute(s.tunnels.beginUpdate(before, randomUUID()));
        expect((await tunnelRecord(s, target)).network).toBeUndefined();
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        expect(await f.adapter.closeCapture({ resourceId: target.sandboxId }, target.runId)).toBe(
          "closed",
        );
        release.resolve();
        expect(await launching).toBeInstanceOf(LaunchRetainedError);
        expect(s.gateway.requests).toEqual([]);
        expect(await tunnelRecord(s, target)).toMatchObject({ updates: [], released: true });
        expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
        expect(s.provider.deleteCalls).toBe(1);
      } finally {
        release.resolve();
        await launching;
        await f.runtime.dispose();
      }
    }));
  it("waits for the exact dispatched gateway setup before removing it and releasing custody", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      s.gateway.allowRemoval = true;
      s.gateway.beforeReply = async () => {
        entered.resolve();
        await release.promise;
      };
      const launching = f.adapter.launch(f.input).catch((error: unknown) => error);
      try {
        await entered.promise;
        const target = (await execute(s.repo.get(f.input.runId)))?.target;
        if (target == null) throw new Error("missing bound target");
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        await expect(
          f.adapter.closeCapture({ resourceId: target.sandboxId }, target.runId),
        ).rejects.toThrow("unavailable");
        expect(s.gateway.removeCalls).toBe(0);
        expect(s.provider.deleteCalls).toBe(0);
        release.resolve();
        expect(await launching).toBeInstanceOf(LaunchRetainedError);
        expect(await f.adapter.closeCapture({ resourceId: target.sandboxId }, target.runId)).toBe(
          "closed",
        );
        expect(s.gateway.removeCalls).toBe(1);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await tunnelRecord(s, target)).toMatchObject({ updates: [], released: true });
        expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
      } finally {
        release.resolve();
        await launching;
        await f.runtime.dispose();
      }
    }));
  it.each([false, true])(
    "closes an orphaned dispatched gateway update after failure, provider absent=%s",
    (absent) =>
      test(async (s) => {
        const f = await adapterFixture(s);
        s.gateway.allowRemoval = true;
        s.gateway.unavailable = true;
        try {
          await execute(
            s.canonical.storeCaptureToken({
              runId: f.input.runId,
              sealed: "local-pre-launch-token",
            }),
          );
          await expect(f.adapter.launch(f.input)).rejects.toThrow("configure-gateway");
          const allocation = await execute(s.repo.get(f.input.runId));
          const target = allocation?.target;
          if (target == null) throw new Error("missing bound target");
          expect(await tunnelRecord(s, target)).toMatchObject({ updates: [expect.any(String)] });
          // The real run's VM was removed out of band. Canonical reconciliation must still remove
          // the owned host endpoint and release its port and publication pin on an exact 404.
          await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
          s.provider.sandboxMissing = absent;
          const result = await f.runtime.runPromise(
            Effect.flatMap(BoatFinalClose, (close) => close.reconcile({ limit: 20 })),
          );
          expect(result.entries).toContainEqual({ runId: target.runId, outcome: "closed" });
          expect(s.gateway.removeCalls).toBe(1);
          expect(s.provider.deleteCalls).toBe(absent ? 0 : 1);
          expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
            state: "gone",
            retainedAt: null,
            captureTokenSealed: null,
            lastStatus: null,
            completionAttestedAt: null,
          });
          expect(await tunnelRecord(s, target)).toMatchObject({
            updates: [],
            released: true,
            absent: true,
          });
          expect((await execute(s.repo.get(target.runId)))?.phase).toBe("deleted");
          expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe(
            "released",
          );
          expect(await f.adapter.closeCapture({ resourceId: target.sandboxId }, target.runId)).toBe(
            "closed",
          );
        } finally {
          await f.runtime.dispose();
        }
      }),
  );
  it("waits for an accepted clone to finish provisioning without issuing another create", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      let observations = 0;
      s.provider.state = "cloning";
      s.provider.hydrated = false;
      s.provider.beforeSandboxRead = async () => {
        if (++observations >= 3) {
          s.provider.state = "idle";
          s.provider.hydrated = true;
        }
      };
      try {
        expect(await f.adapter.launch(f.input)).toMatchObject({ status: "ready" });
        expect(s.provider.creates).toHaveLength(1);
        expect(s.provider.commands).toHaveLength(1);
        expect(observations).toBeGreaterThanOrEqual(3);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("keeps the exact observed state and failure code on a terminal pre-bind refusal", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      s.provider.state = "error";
      try {
        await expect(f.adapter.launch(f.input)).rejects.toThrow(
          /observe-sandbox.*allocation-pending.*error/,
        );
        expect(s.provider.commands).toHaveLength(0);
        expect(s.provider.creates).toHaveLength(1);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("closes a created but unbound allocation and preserves the launch failure", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        s.provider.bootReadUnavailable = true;
        await expect(f.adapter.launch(f.input)).rejects.toThrow(/read-boot-id.*execute.*503/);
        expect(await execute(s.repo.get(f.input.runId))).toMatchObject({
          phase: "allocated",
          target: null,
          sandboxId: "bx_23456789",
        });
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        expect(await f.adapter.closeCapture({ resourceId: "bx_23456789" }, f.input.runId)).toBe(
          "closed",
        );
        expect(await f.adapter.closeCapture({ resourceId: "bx_23456789" }, f.input.runId)).toBe(
          "closed",
        );
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.guest.starts).toBe(0);
        expect(await execute(s.repo.get(f.input.runId))).toMatchObject({
          phase: "deleted",
          target: null,
        });
        expect(await execute(s.runtimes.getRuntimeInstanceByRunId(f.input.runId))).toMatchObject({
          status: "stopped",
          removedAt: expect.any(Date),
        });
        expect(await execute(nativeConsumerRows(s.db, f.input.runId))).toMatchObject([
          { state: "released" },
        ]);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("reconciles an unbound VM already removed by the operator", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const token = await execute(
          Effect.flatMap(CredentialCipher, (cipher) => cipher.encrypt("local-capture-only")).pipe(
            Effect.provide(credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") })),
          ),
        );
        await execute(
          s.canonical.storeCaptureToken({ runId: f.input.runId, sealed: token.sealed }),
        );
        s.provider.bootReadUnavailable = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        s.provider.sandboxMissing = true;
        expect(await execute(f.close.owner.reconcile({ limit: 10 }))).toMatchObject({
          entries: [{ runId: f.input.runId, outcome: "closed" }],
        });
        expect(s.provider.deleteCalls).toBe(0);
        expect(await execute(s.repo.get(f.input.runId))).toMatchObject({ phase: "deleted" });
        expect(await execute(s.canonical.getByRunId(f.input.runId))).toMatchObject({
          state: "gone",
          retainedAt: null,
          captureTokenSealed: null,
          lastStatus: null,
          completionAttestedAt: null,
        });
        expect((await execute(nativeConsumerRows(s.db, f.input.runId)))[0]?.state).toBe("released");
        // Reconstruct the old worker's terminal allocation with its untouched pre-launch drain.
        await execute(restoreUnprogressedCaptureDrain(s.db, f.input.runId, token.sealed));
        expect(await execute(f.close.owner.reconcile({ limit: 10 }))).toMatchObject({
          entries: [{ runId: f.input.runId, outcome: "closed" }],
        });
        expect(await execute(s.canonical.getByRunId(f.input.runId))).toMatchObject({
          state: "gone",
          retainedAt: null,
          captureTokenSealed: null,
          lastStatus: null,
          completionAttestedAt: null,
        });
        expect(s.provider.deleteCalls).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("fences exchange failures, deletes the bound guest and releases its pin, including exact operator absence", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        s.guest.fail = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        const allocation = await execute(s.repo.get(f.input.runId));
        expect(allocation?.phase).toBe("bound");
        const target = allocation?.target;
        if (target == null) throw new Error("missing target");
        expect((await execute(s.executions.get(f.input.runId)))?.phase).toBe("exchange");
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        if (allocation === undefined) throw new Error("missing allocation");
        await expect(
          execute(
            s.repo.advance(allocation, {
              ...allocation,
              phase: "deleting",
              removal: { kind: "issued", token: randomUUID(), at: new Date().toISOString() },
            }),
          ),
        ).rejects.toThrow("binding-conflict");
        // Run 7: operator already deleted the exact VM. Reconcile must settle without DELETE.
        s.provider.sandboxMissing = true;
        expect(await execute(f.close.owner.reconcile({ limit: 10 }))).toMatchObject({
          entries: [{ outcome: "closed" }],
        });
        expect(await execute(s.executions.get(f.input.runId))).toMatchObject({
          phase: "aborted",
          target,
        });
        expect(s.provider.deleteCalls).toBe(0);
        expect(await f.adapter.closeCapture({ resourceId: target.sandboxId }, f.input.runId)).toBe(
          "closed",
        );
        expect((await execute(nativeConsumerRows(s.db, f.input.runId)))[0]?.state).toBe("released");
        expect(await execute(s.allocations.reconcile({ limit: 10 }))).toMatchObject({
          entries: [{ outcome: "deleted" }],
        });
        expect(await execute(s.resourceOwner.reconcile({ limit: 10 }))).toMatchObject({
          entries: [{ outcome: "closed" }],
        });
        s.guest.fail = false;
        await expect(execute(s.executor.exchange(target))).rejects.toThrow("invocation-held");
        await expect(execute(s.executor.launch(target.runtimeInstanceId))).rejects.toThrow();
        expect(s.guest.starts).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("positively deletes a pre-issued guest, then retries host cleanup before releasing the slot and pin", () =>
    test(async (s) => {
      const target = await execute(s.allocations.prepare(s.input));
      await execute(s.executor.stage(target.runtimeInstanceId, Redacted.make(launchMaterial())));
      await execute(s.resourceOwner.prepare(target));
      expect((await execute(s.executions.get(target.runId)))?.phase).toBe("installed");
      const { owner, daemon } = await execute(s.final([]));
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      s.gateway.allowRemoval = true;
      s.gateway.removalUnavailable = true;
      // Boat removed the VM: the runtime reads stopped now; only host cleanup is retried.
      expect(await execute(owner.close(target))).toBe("pending");
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
        status: "stopped",
        removedAt: expect.any(Date),
      });
      expect((await execute(s.repo.get(target.runId)))?.phase).toBe("deleted");
      expect((await execute(s.tunnels.get(target.runId)))?.released).toBeUndefined();
      expect(await execute(s.resourceOwner.reconcile({ limit: 10 }))).toMatchObject({
        entries: [{ outcome: "held" }],
      });
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("pending");
      s.gateway.removalUnavailable = false;
      expect(await execute(owner.close(target))).toBe("closed");
      expect(s.provider.deleteCalls).toBe(1);
      expect((await execute(s.tunnels.get(target.runId)))?.released).toBe(true);
      expect(await execute(s.resourceOwner.reconcile({ limit: 10 }))).toMatchObject({
        entries: [{ outcome: "closed" }],
      });
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
      expect(daemon.calls).toEqual([]);
      expect(s.guest.starts).toBe(0);
    }));
  it("fences a delayed exchange reply and refuses deletion when invocation issuance already won", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      const { promise: reachedHost, resolve: observeHost } = Promise.withResolvers<void>();
      const { promise: hostReply, resolve: releaseHost } = Promise.withResolvers<void>();
      s.guest.beforeHost = async () => {
        observeHost();
        await hostReply;
      };
      const launch = f.adapter.launch(f.input).catch((error: unknown) => error);
      try {
        await reachedHost;
        const record = await execute(s.executions.get(f.input.runId));
        if (record === undefined) throw new Error("missing execution");
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        expect(
          await f.adapter.closeCapture({ resourceId: record.target.sandboxId }, f.input.runId),
        ).toBe("closed");
        releaseHost();
        expect(await launch).toBeInstanceOf(LaunchRetainedError);
        expect((await execute(s.executions.get(f.input.runId)))?.phase).toBe("aborted");
        expect(s.guest.starts).toBe(0);
      } finally {
        releaseHost();
        await launch;
        await f.runtime.dispose();
      }
    }));
  it("keeps a durably issued invocation in custody even before readiness", () =>
    test(async (s) => {
      const target = await execute(s.allocations.prepare(s.input));
      await execute(s.executor.stage(target.runtimeInstanceId, Redacted.make(launchMaterial())));
      const stored = await execute(s.executions.get(target.runId));
      if (stored === undefined) throw new Error("missing execution");
      // Models the durable issuance boundary before its network response, using the real repository CAS.
      await execute(s.executions.advance(stored, { ...stored, phase: "issued" }));
      await expect(execute(s.executions.abort(target))).rejects.toThrow("stale-transition");
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      const { owner } = await execute(s.final([]));
      await expect(execute(owner.close(target))).rejects.toThrow();
      expect(s.provider.deleteCalls).toBe(0);
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("pending");
    }));
  it("polls an accepted unbound deletion across restarts without another DELETE", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        s.provider.bootReadUnavailable = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        s.provider.deletionCompleted = false;
        expect(await f.adapter.closeCapture({ resourceId: "bx_23456789" }, f.input.runId)).toBe(
          "pending",
        );
        expect((await execute(nativeConsumerRows(s.db, f.input.runId)))[0]?.state).toBe("pending");
        const restarted = await execute(s.final([]));
        s.provider.deletionUnavailable = true;
        await expect(
          execute(restarted.owner.closeUnbound(f.input.runId, "bx_23456789")),
        ).rejects.toThrow("unavailable");
        expect(s.provider.deleteCalls).toBe(1);
        s.provider.deletionUnavailable = false;
        s.provider.deletionCompleted = true;
        expect(await execute(restarted.owner.closeUnbound(f.input.runId, "bx_23456789"))).toBe(
          "closed",
        );
        expect(s.provider.deleteCalls).toBe(1);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("retains a lost unbound DELETE response and recovers from exact absence", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        s.provider.bootReadUnavailable = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        s.provider.deleteLost = true;
        await expect(
          f.adapter.closeCapture({ resourceId: "bx_23456789" }, f.input.runId),
        ).rejects.toThrow("unavailable");
        expect(await f.adapter.closeCapture({ resourceId: "bx_23456789" }, f.input.runId)).toBe(
          "pending",
        );
        expect(s.provider.deleteCalls).toBe(1);
        expect((await execute(nativeConsumerRows(s.db, f.input.runId)))[0]?.state).toBe("pending");
        s.provider.sandboxMissing = true;
        expect(await execute(f.close.owner.reconcile({ limit: 10 }))).toMatchObject({
          entries: [{ outcome: "closed" }],
        });
        expect(s.provider.deleteCalls).toBe(1);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("refuses active or foreign unbound guests, and fences stale binding before deleting", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        s.provider.bootReadUnavailable = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        const previous = await execute(s.repo.get(f.input.runId));
        if (previous === undefined) throw new Error("missing allocation");
        await expect(
          execute(f.close.owner.closeUnbound(f.input.runId, "bx_23456789")),
        ).rejects.toThrow("held");
        expect(s.provider.deleteCalls).toBe(0);
        // Reconciliation must also find failed launches whose stop worker has not run.
        await execute(s.runtimes.upsertRuntimeInstance({ runId: f.input.runId, status: "failed" }));
        s.provider.foreign = true;
        expect(await execute(f.close.owner.reconcile({ limit: 10 }))).toMatchObject({
          entries: [{ outcome: "held" }],
        });
        expect(s.provider.deleteCalls).toBe(0);
        await expect(
          execute(s.catalog.release(s.input.consumer, s.input.publication.publicationId)),
        ).rejects.toThrow("consumer-conflict");
        s.provider.foreign = false;
        s.provider.bootReadUnavailable = false;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("allocation-held");
        await expect(
          execute(
            s.repo.advance(previous, { ...previous, phase: "held", reason: "lifetime-unverified" }),
          ),
        ).rejects.toThrow("stale-transition");
        expect(await execute(f.close.owner.closeUnbound(f.input.runId, "bx_23456789"))).toBe(
          "pending",
        );
        expect(s.guest.starts).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("retries an unknown unbound DELETE only after its lease and a fresh ownership observation", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        s.provider.bootReadUnavailable = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        s.provider.deleteLost = true;
        await expect(
          execute(f.close.owner.closeUnbound(f.input.runId, "bx_23456789")),
        ).rejects.toThrow("unavailable");
        const issued = await execute(s.repo.get(f.input.runId));
        if (issued?.removal?.kind !== "issued") throw new Error("missing deletion lease");
        const retryAt = Date.parse(issued.removal.at) + 180_001;
        s.provider.deleteLost = false;
        s.provider.foreign = true;
        const retry = () =>
          Effect.gen(function* () {
            yield* TestClock.setTime(retryAt);
            return yield* f.close.owner.closeUnbound(f.input.runId, "bx_23456789");
          }).pipe(Effect.provide(TestClock.layer()));
        await expect(execute(retry())).rejects.toThrow("held");
        expect(s.provider.deleteCalls).toBe(1);
        s.provider.foreign = false;
        expect(await execute(retry())).toBe("closed");
        expect(s.provider.deleteCalls).toBe(2);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("shares one unbound deletion between concurrent stop and reconciliation", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      try {
        s.provider.bootReadUnavailable = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        s.provider.beforeDeletion = async () => {
          entered.resolve();
          await release.promise;
        };
        const first = f.adapter.closeCapture({ resourceId: "bx_23456789" }, f.input.runId);
        await entered.promise;
        expect(await execute(f.close.owner.reconcile({ limit: 10 }))).toMatchObject({
          entries: [{ outcome: "pending" }],
        });
        release.resolve();
        expect(await first).toBe("closed");
        expect(s.provider.deleteCalls).toBe(1);
      } finally {
        release.resolve();
        await f.runtime.dispose();
      }
    }));
  it("launches through the durable owners with complete boot facts, then FINAL closes and releases its slot", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      const hooks: string[] = [];
      try {
        const result = await f.adapter.launch(f.input, {
          onStarted: async (identity) => {
            hooks.push("started");
            expect(s.guest.starts).toBe(0);
            await execute(
              s.runtimes.upsertRuntimeInstance({
                runId: f.input.runId,
                ...identity,
                status: "running",
              }),
            );
          },
          onReady: async (identity) => {
            hooks.push("ready");
            await execute(
              s.runtimes.upsertRuntimeInstance({
                runId: f.input.runId,
                ...identity,
                status: "ready",
              }),
            );
          },
        });
        expect(result).toMatchObject({
          adapter: "boat",
          resourceId: "bx_23456789",
          reference: f.input.runId,
          status: "ready",
        });
        expect(hooks).toEqual(["started", "ready"]);
        expect(s.guest.launches).toHaveLength(1);
        expect(s.guest.launches[0]).toMatchObject({ version: 1, runId: f.input.runId });
        expect(s.guest.launches[0]?.bootEnv).toMatchObject({
          SEALANT_OS_FAMILY: "ubuntu",
          SEALANT_LOGIN_SHELL_PATH: "/bin/bash",
          SEALANT_BASH_SHELL_PATH: "/bin/bash",
          SEALANT_WORKSPACE_SOURCE: "capture",
          SEALANT_SECRET_ENV_FILE: "/run/sealant/secrets/env.json",
        });
        expect(s.provider.creates).toHaveLength(1);
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        s.gateway.allowRemoval = true;
        expect(await f.adapter.closeCapture(result, f.input.runId)).toBe("closed");
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.gateway.removeCalls).toBe(1);
        expect(await execute(s.tunnels.get(f.input.runId))).toMatchObject({ released: true });
        expect(await execute(s.runtimes.getRuntimeInstanceByRunId(f.input.runId))).toMatchObject({
          status: "stopped",
        });
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("refuses a different owner before allocation and leaves unknown boot outcomes in exact custody", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        await expect(
          f.adapter.launch({ ...f.input, principalId: "not-allowlisted" }),
        ).rejects.toThrow("admission-refused");
        expect(s.provider.creates).toHaveLength(0);
        s.guest.fail = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        expect(await f.adapter.locate({ runId: f.input.runId })).toMatchObject({
          resourceId: "bx_23456789",
          reference: f.input.runId,
        });
        expect(s.provider.creates).toHaveLength(1);
        expect(s.provider.deleteCalls).toBe(0);
        await expect(
          f.adapter.closeCapture({ resourceId: "bx_3456789a" }, f.input.runId),
        ).rejects.toThrow("target-mismatch");
        expect(s.provider.deleteCalls).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("retains a created VM if a launch hook fails, without replaying user execution", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        await expect(
          f.adapter.launch(f.input, {
            onStarted: async () => {
              throw new Error("local persistence failed");
            },
          }),
        ).rejects.toBeInstanceOf(LaunchRetainedError);
        expect(s.provider.creates).toHaveLength(1);
        expect(s.guest.starts).toBe(0);
        expect(s.provider.deleteCalls).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }));
});

const interactiveFixture = async (s: AllocationFixture) => {
  const target = await launched(s);
  await execute(
    s.runtimes.upsertRuntimeInstance({
      runId: target.runId,
      adapter: "boat",
      status: "ready",
      resourceId: target.sandboxId,
    }),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      boatInteractiveControlLayerNoDeps,
      Layer.succeed(BoatExecution, s.executor),
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(BoatAllocationRepo, s.repo),
          Layer.succeed(WorkspaceRuntimeInstanceRepo, s.runtimes),
          Layer.succeed(WorkspaceCaptureDrainRepo, s.canonical),
          credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") }).pipe(Layer.orDie),
          boatControlRequestRepoLayer.pipe(Layer.provide(Layer.succeed(SealantDB, s.db))),
        ),
      ),
    ),
  );
  return {
    runtime,
    target,
    control: await runtime.runPromise(BoatInteractiveControl),
    requests: await runtime.runPromise(BoatControlRequestRepo),
    cipher: await runtime.runPromise(CredentialCipher),
  };
};
const pendingRequests = async (requests: BoatControlRequestRepo["Service"], count: number) => {
  await expect.poll(async () => (await execute(requests.pending())).length).toBe(count);
  return execute(requests.pending());
};

describe.runIf(databaseUrl !== undefined)("Boat interactive control fencing", () => {
  it("rejects swapped and corrupt encrypted replies and removes both callers' requests", () =>
    test(async (s) => {
      const f = await interactiveFixture(s);
      try {
        const first = f.control.connectMaterial(f.target.runId, f.target.sandboxId).then(
          () => "accepted",
          () => "refused",
        );
        const second = f.control.connectMaterial(f.target.runId, f.target.sandboxId).then(
          () => "accepted",
          () => "refused",
        );
        const rows = await pendingRequests(f.requests, 2);
        const a = rows[0],
          b = rows[1];
        if (a === undefined || b === undefined) throw new Error("missing requests");
        const sealed = await execute(
          f.cipher.encrypt(
            JSON.stringify({
              context: { id: b.id, target: b.target, purpose: "interactive-control" },
              value: {
                url: "wss://fixture.example/control",
                auth: { bearerToken: "a".repeat(64) },
                headers: {},
              },
            }),
          ),
        );
        await execute(f.requests.complete(a, sealed.sealed));
        await execute(f.requests.complete(b, "corrupt"));
        expect(await Promise.all([first, second])).toEqual(["refused", "refused"]);
        expect(await execute(f.requests.get(a.id))).toBeUndefined();
        expect(await execute(f.requests.get(b.id))).toBeUndefined();
        expect(s.provider.creates).toHaveLength(1);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("does not publish refreshed hosted access if Stop wins during the refresh", () =>
    test(async (s) => {
      const f = await interactiveFixture(s);
      try {
        const result = f.control.connectMaterial(f.target.runId, f.target.sandboxId).then(
          () => "accepted",
          () => "refused",
        );
        const rows = await pendingRequests(f.requests, 1);
        const request = rows[0];
        if (request === undefined) throw new Error("missing request");
        s.guest.beforeHost = () =>
          execute(s.runtimes.markStopRequested({ runId: f.target.runId, stopReason: "user" }));
        await f.runtime.runPromise(serveBoatControlRequests);
        expect((await execute(f.requests.get(request.id)))?.sealedAccess).toBeNull();
        await execute(f.requests.remove(request.id));
        expect(await result).toBe("refused");
        await expect(f.control.connectMaterial(f.target.runId, "bx_3456789a")).rejects.toThrow(
          "unavailable",
        );
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("refuses a changed runtime and an expired request instead of using historical authority", () =>
    test(async (s) => {
      const f = await interactiveFixture(s);
      try {
        const result = f.control.connectMaterial(f.target.runId, f.target.sandboxId).then(
          () => "accepted",
          () => "refused",
        );
        const rows = await pendingRequests(f.requests, 1);
        const request = rows[0];
        if (request === undefined) throw new Error("missing request");
        await execute(s.db.update(schema.boatControlRequests).set({ expiresAt: new Date(0) }));
        expect(await result).toBe("refused");
        expect(await execute(f.requests.get(request.id))).toBeUndefined();
        await execute(
          s.runtimes.upsertRuntimeInstance({
            runId: f.target.runId,
            adapter: "boat",
            status: "ready",
            resourceId: "bx_3456789a",
          }),
        );
        await expect(f.control.connectMaterial(f.target.runId, f.target.sandboxId)).rejects.toThrow(
          "unavailable",
        );
        expect(await execute(f.requests.pending())).toEqual([]);
      } finally {
        await f.runtime.dispose();
      }
    }));
});

describe.runIf(databaseUrl !== undefined)("Boat canonical FINAL close", () => {
  it("keeps ready allocations current and serves fresh sealed interactive access without exposing the provider key", () =>
    test(async (s) => {
      const target = await launched(s);
      await execute(
        s.runtimes.upsertRuntimeInstance({
          runId: target.runId,
          adapter: "boat",
          status: "ready",
          resourceId: target.sandboxId,
        }),
      );
      expect(await execute(s.repo.isActive(target.runId))).toBe(true);
      const runtime = ManagedRuntime.make(
        Layer.mergeAll(
          boatInteractiveControlLayerNoDeps,
          Layer.succeed(BoatExecution, s.executor),
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(BoatAllocationRepo, s.repo),
              Layer.succeed(WorkspaceRuntimeInstanceRepo, s.runtimes),
              Layer.succeed(WorkspaceCaptureDrainRepo, s.canonical),
              credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") }).pipe(
                Layer.orDie,
              ),
              boatControlRequestRepoLayer.pipe(Layer.provide(Layer.succeed(SealantDB, s.db))),
            ),
          ),
        ),
      );
      try {
        const control = await runtime.runPromise(BoatInteractiveControl);
        const pending = control.connectMaterial(target.runId, target.sandboxId);
        const requests = await runtime.runPromise(BoatControlRequestRepo);
        const rows = await pendingRequests(requests, 1);
        expect(rows).toHaveLength(1);
        await runtime.runPromise(serveBoatControlRequests);
        const stored = await execute(requests.get(rows[0]?.id ?? ""));
        expect(stored?.sealedAccess).toBeTypeOf("string");
        expect(stored?.sealedAccess).not.toContain("test-cookie-local-only");
        const material = await pending;
        expect(material).toMatchObject({
          url: "wss://fixture-8080.on.boat.dev/sealant/control",
          auth: { bearerToken: "a".repeat(64) },
          headers: { Cookie: "_port_auth=test-cookie-local-only" },
        });
        expect(await execute(requests.get(rows[0]?.id ?? ""))).toBeUndefined();
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        expect(await execute(s.repo.isActive(target.runId))).toBe(false);
        await expect(control.connectMaterial(target.runId, target.sandboxId)).rejects.toThrow(
          "unavailable",
        );
        expect(await execute(requests.pending())).toEqual([]);
        expect(s.provider.creates).toHaveLength(1);
      } finally {
        await runtime.dispose();
      }
    }));

  it("reconciles only stopped current runtimes on this gateway host and resumes after the page cursor", () =>
    test(async (s) => {
      const target = await launched(s);
      const { owner, daemon } = await execute(s.final([savedStatus()]));
      expect((await execute(owner.reconcile({ limit: 1 }))).entries).toEqual([
        { runId: target.runId, outcome: "skipped" },
      ]);
      expect(daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(0);
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      s.gateway.allowRemoval = true;
      const result = await execute(owner.reconcile({ limit: 1 }));
      expect(result).toEqual({
        entries: [{ runId: target.runId, outcome: "closed" }],
        next: target.runId,
      });
      expect(await execute(owner.reconcile({ limit: 1, after: target.runId }))).toEqual({
        entries: [],
      });
      expect((await execute(owner.reconcile({ limit: 1 }))).entries).toEqual([
        { runId: target.runId, outcome: "closed" },
      ]);
      expect(s.provider.deleteCalls).toBe(1);
      for (const limit of [0, -1, 21, 1.5])
        await expect(execute(owner.reconcile({ limit }))).rejects.toThrow("held");
    }));
  it("keeps pending, ended and unresolved capture-only recovery in custody without FINAL or deletion", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const { owner, daemon } = await execute(s.final([savedStatus()]));
      // A restarted recovery boot is pending; the typed refusals (another boot, a parked disk,
      // an agent that did not launch this boot) keep the VM too, never read as nothing to save.
      for (const state of [
        "restarted",
        "recover-new-boot",
        "recover-state-unknown",
        "recover-binding-conflict",
        "parked",
      ] as const) {
        s.guest.recovery = state;
        expect(await execute(owner.close(target))).toBe("retained");
        expect(daemon.calls).toEqual([]);
        expect(s.provider.deleteCalls).toBe(0);
        expect((await tunnelRecord(s, target)).released).toBeUndefined();
      }
      s.guest.recovery = "running";
      s.guest.malformedRecovery = true;
      await expect(execute(owner.close(target))).rejects.toThrow("unavailable");
      expect(daemon.calls).toEqual([]);
      s.guest.malformedRecovery = false;
      expect(await execute(owner.close(target))).toBe("closed");
      expect(s.guest.starts).toBe(1);
    }));
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
      await expect(execute(s.catalog.release(s.input.consumer, target.sourceId))).rejects.toThrow(
        "consumer-conflict",
      );
      expect(await execute(owner.close(target))).toBe("closed");
      await execute(s.catalog.release(s.input.consumer, target.sourceId));
      await expect(
        execute(s.catalog.markConsumer(s.input.consumer, target.sourceId, "live")),
      ).rejects.toThrow("consumer-released");
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
      const nextId = randomUUID();
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
  it("refuses an active run and closes its stopped guest when no invocation was issued", () =>
    test(async (s) => {
      const target = await s.allocations.prepare(s.input).pipe(execute);
      const { owner, daemon } = await execute(s.final([savedStatus()]));
      await expect(execute(owner.close(target))).rejects.toThrow("held");
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      expect(await execute(owner.close(target))).toBe("closed");
      expect(daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(1);
    }));
  it("reconciles publication release after a crash between terminal runtime writes and pin release", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const { owner } = await execute(s.final([savedStatus()]));
      expect(await execute(owner.close(target))).toBe("closed");
      // Reconstruct the durable boundary immediately before catalog.release.
      await execute(
        s.db.update(schema.nativePublicationConsumers).set({ state: "live", releasedAt: null }),
      );
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("live");
      expect((await execute(owner.reconcile({ limit: 20 }))).entries).toContainEqual({
        runId: target.runId,
        outcome: "closed",
      });
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
      expect(s.provider.deleteCalls).toBe(1);
      expect(s.gateway.removeCalls).toBe(1);
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
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const active = execute(
        s.tunnels.withHostLock(
          before.binding,
          Effect.gen(function* () {
            expect(yield* s.tunnels.beginUpdate(before, id)).toBe("issued");
            entered.resolve();
            yield* Effect.promise(() => release.promise);
            yield* s.tunnels.endUpdate(before.binding, id);
          }),
        ),
      );
      await entered.promise;
      const { owner, daemon } = await execute(s.final([savedStatus()]));
      try {
        await expect(execute(owner.close(target))).rejects.toThrow("unavailable");
        expect(daemon.calls).toEqual([]);
        expect(s.provider.deleteCalls).toBe(0);
      } finally {
        release.resolve();
        await active;
      }
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
  it("a lost DELETE reply is answered by observing the VM absent (audit S7)", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      s.provider.deleteLost = true;
      const { owner } = await execute(s.final([savedStatus()]));
      await expect(execute(owner.close(target))).rejects.toThrow("unavailable");
      // Boat carried the DELETE out; its reply carrying the operation id never arrived.
      s.provider.sandboxMissing = true;
      expect(await execute(owner.close(target))).toBe("closed");
      expect(s.provider.deleteCalls).toBe(1);
      expect(s.gateway.removeCalls).toBe(1);
      expect((await tunnelRecord(s, target)).released).toBe(true);
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        deletionState: "deleted",
        state: "stopped",
        retainedAt: null,
        captureTokenSealed: null,
      });
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
        status: "stopped",
        removedAt: expect.any(Date),
      });
      expect((await execute(s.repo.get(target.runId)))?.phase).toBe("deleted");
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
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
      expect(await execute(owner.close(target))).toBe("pending");
      expect((await tunnelRecord(s, target)).released).toBeUndefined();
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("pending");
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
        // The close in flight decides; the one it turned away keeps nothing on record.
        expect((await execute(s.canonical.getByRunId(target.runId)))?.retainedAt).toBeNull();
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
        await execute(s.executor.stage(target.runId, Redacted.make(launchMaterial())));
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
    it("carries the tunnel when the host has a relay and the agent can: the carrier gets the gateway's port", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        await execute(s.executor.stage(target.runId, Redacted.make(launchMaterial())));
        const original = s.guest.request.bind(s.guest);
        s.guest.request = async (...args) => {
          const reply = await original(...args);
          return args[2] === "network-status"
            ? {
                ...reply,
                body: {
                  ...z.object({}).passthrough().parse(reply.body),
                  carriers: ["udp", "websocket"],
                },
              }
            : reply;
        };
        const relayed = await execute(s.reopenResources("10.0.0.41", undefined, "127.0.0.1"));
        const result = await execute(relayed.prepare(target));
        expect(result.guest.carrier).toBe("websocket");
        const body = JSON.parse(s.guest.networkBodies.at(-1) ?? "{}") as Record<string, unknown>;
        expect(body).toMatchObject({ carrier: "websocket" });
        expect(body).not.toHaveProperty("endpoint");
        expect(s.carried).toHaveLength(1);
        expect(s.carried[0]).toMatchObject({
          runId: target.runId,
          gateway: { host: "127.0.0.1", port: s.gateway.requests.at(-1)?.listenPort },
        });
        const connection = Redacted.value(
          await execute(s.carried[0]?.connection ?? Effect.die("")),
        );
        expect(connection.url).toMatch(/\/sealant\/tunnel$/);
      }));
    const parkingSource = async (
      s: Parameters<Parameters<typeof test>[0]>[0],
      script: readonly CaptureDaemonScriptEntry[] = [
        captureStatus({ complete: false, incompleteReason: "ship-failed", pending: 1 }),
        captureStatus({ epoch: 2 }),
      ],
    ) => {
      s.provider.parking = true;
      const target = await execute(s.allocations.prepare(s.input));
      const launch = {
        format: "sealant-daemon-launch-v1",
        boot_env: {
          SEALANT_WORKSPACE_SOURCE: "capture",
          SEALANT_CAPTURE_ENDPOINT: "https://capture.invalid/session",
          SEALANT_CAPTURE_WORKTREE_ID: "wt_1",
          SEALANT_CAPTURE_LAUNCH_ID: "parking-launch",
          SEALANT_LIFECYCLE_SETUP_JSON: "[]",
          SEALANT_LIFECYCLE_STARTUP_JSON: "[]",
          SEALANT_FOREGROUND_COMMAND: "sleep infinity",
        },
      };
      await execute(
        s.readiness.launch(
          target,
          Redacted.make({
            bootEnv: launch.boot_env,
            secretEnv: { SEALANT_CAPTURE_TOKEN: "local-proof-token" },
            pins: { credentialVersions: [], dotfiles: [] },
            docker: false,
          }),
        ),
      );
      const parking = await execute(s.parking(script));
      await execute(parking.retain(target));
      await execute(backdateUnenrolledParkingRetention(s.db, target.runId));
      s.gateway.allowRemoval = true;
      const custody = await execute(s.canonical.preservation);
      return { target, parking, custody };
    };
    it("observes a lost save reply and a pending removal without issuing another save or delete", () =>
      test(async (s) => {
        const { target, parking, custody } = await parkingSource(s);
        s.provider.saveLost = true;
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("unavailable");
        expect(s.provider.saves).toBe(1);
        expect(s.provider.deleteCalls).toBe(0);
        s.provider.saveLost = false;
        s.provider.deletionCompleted = false;
        await execute(makeParkingActionDue(s.db, target.runId));
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("pending");
        expect(await execute(custody.read(target.runId))).toMatchObject({ snapshotOnly: false });
        await expect(execute(parking.park(target))).rejects.toThrow("pending");
        s.provider.deletionCompleted = true;
        expect(await execute(parking.park(target))).toBe("parked");
        expect(s.provider.saves).toBe(1);
        expect(s.provider.deleteCalls).toBe(1);
      }));
    it("keeps the source VM and slot when immutable snapshot bytes fail verification", () =>
      test(async (s) => {
        const { target, parking, custody } = await parkingSource(s);
        s.provider.corruptCapsule = true;
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("unavailable");
        expect(s.provider.deleteCalls).toBe(0);
        expect((await execute(s.tunnels.get(target.runtimeInstanceId)))?.released).not.toBe(true);
        expect(await execute(custody.read(target.runId))).toMatchObject({ snapshotOnly: false });
        s.provider.corruptCapsule = false;
        expect(await execute(parking.park(target))).toBe("parked");
        expect(await execute(parking.park(target))).toBe("parked");
        expect(s.provider.saves).toBe(1);
      }));
    it("finishes custody for an early resume request and adopts the same child after its create reply is lost", () =>
      test(async (s) => {
        const { target, parking, custody } = await parkingSource(s);
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("pending");
        await execute(s.canonical.requestRecovery(target.runId));
        await execute(makeParkingActionDue(s.db, target.runId));
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("parked");
        s.provider.recoveryCreateLost = true;
        await expect(execute(parking.resume(target.runId))).rejects.toThrow("unavailable");
        s.provider.recoveryCreateLost = false;
        const restored = await execute(
          Effect.gen(function* () {
            yield* TestClock.setTime(Date.now() + 60_000);
            return yield* parking.resume(target.runId);
          }).pipe(Effect.provide(TestClock.layer())),
        );
        expect(await execute(parking.resume(target.runId))).toEqual(restored);
        expect(await execute(custody.read(target.runId))).toMatchObject({
          state: "active",
          snapshotOnly: false,
        });
        expect(await execute(custody.resolveExecution(target.runId))).toEqual(restored);
        expect(s.provider.creates).toHaveLength(2);
        expect(s.provider.saves).toBe(1);
        expect(s.provider.deleteCalls).toBe(1);
      }));
    it("retires parked snapshots and releases the publication only after canonical owner discard", () =>
      test(async (s) => {
        const { target, parking, custody } = await parkingSource(s);
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("pending");
        expect(await execute(parking.park(target))).toBe("parked");
        expect(s.provider.retirements).toBe(0);
        await execute(
          s.canonical.requestDiscard({ runId: target.runId, requestedBy: "local-owner" }),
        );
        expect(await execute(parking.park(target))).toBe("parked");
        expect(s.provider.retirements).toBe(1);
        expect(await execute(custody.read(target.runId))).toMatchObject({
          state: "closed",
          snapshotOnly: false,
          snapshots: [{ state: "removed" }],
        });
        expect(await execute(custody.resolveExecution(target.runId))).toBeUndefined();
        expect(await execute(s.canonical.requestRecovery(target.runId))).toBeUndefined();
        expect(
          (await execute(s.executions.get(target.runtimeInstanceId)))?.admission
            ?.sealedResumeEnvelope,
        ).toBeUndefined();
      }));
    it("discharges a completed authenticated FINAL without requiring owner discard", () =>
      test(async (s) => {
        const { target, parking, custody } = await parkingSource(s, [savedStatus()]);
        await execute(parking.reconcile());
        expect(await execute(parking.park(target))).toBe("parked");
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.provider.retirements).toBe(1);
        expect(await execute(custody.read(target.runId))).toMatchObject({ state: "closed" });
      }));
    it("retains an unknown snapshot deletion and never invents completion from absence", () =>
      test(async (s) => {
        const { target, parking, custody } = await parkingSource(s);
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("pending");
        expect(await execute(parking.park(target))).toBe("parked");
        await execute(
          s.canonical.requestDiscard({ runId: target.runId, requestedBy: "local-owner" }),
        );
        s.provider.retirementLost = true;
        await expect(execute(parking.park(target))).rejects.toThrow("unavailable");
        await expect(execute(parking.park(target))).rejects.toThrow("pending");
        expect(s.provider.retirements).toBe(1);
        expect(await execute(custody.read(target.runId))).toMatchObject({
          snapshots: [{ state: "retiring" }],
        });
      }));
    it("automatically saves an idle session, positively removes its VM and resumes a fresh current incarnation", () =>
      test(async (s) => {
        s.provider.parking = true;
        const target = await execute(s.allocations.prepare(s.input));
        const launch = {
          format: "sealant-daemon-launch-v1",
          boot_env: {
            SEALANT_WORKSPACE_SOURCE: "capture",
            SEALANT_CAPTURE_ENDPOINT: "https://capture.invalid/session",
            SEALANT_CAPTURE_WORKTREE_ID: "wt_1",
            SEALANT_CAPTURE_LAUNCH_ID: "parking-launch",
            SEALANT_LIFECYCLE_SETUP_JSON: "[]",
            SEALANT_LIFECYCLE_STARTUP_JSON: "[]",
            SEALANT_FOREGROUND_COMMAND: "sleep infinity",
          },
        };
        await execute(
          s.readiness.launch(
            target,
            Redacted.make({
              bootEnv: launch.boot_env,
              secretEnv: { SEALANT_CAPTURE_TOKEN: "local-proof-token" },
              pins: { credentialVersions: [], dotfiles: [] },
              docker: false,
            }),
          ),
        );
        const parking = await execute(
          s.parking([
            captureStatus({ complete: false, incompleteReason: "ship-failed", pending: 1 }),
            captureStatus({ epoch: 2 }),
          ]),
        );
        await execute(parking.retain(target));
        await execute(backdateUnenrolledParkingRetention(s.db, target.runId));
        s.gateway.allowRemoval = true;
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("pending");
        const custody = await execute(s.canonical.preservation);
        expect(await execute(custody.read(target.runId))).toMatchObject({ state: "parking" });
        // Advance the database policy clock using the existing test-only due helper and episode.
        await execute(makeParkingActionDue(s.db, target.runId));
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("parked");
        expect(await execute(parking.park(target))).toBe("parked");
        expect(s.provider.saves).toBe(1);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await execute(s.tunnels.get(target.runtimeInstanceId))).toMatchObject({
          released: true,
          removal: { completed: true },
        });
        expect(await execute(custody.read(target.runId))).toMatchObject({
          state: "parked",
          snapshotOnly: true,
        });
        await execute(s.canonical.requestRecovery(target.runId));
        const restored = await execute(
          Effect.gen(function* () {
            yield* TestClock.setTime(Date.now() + 60_000);
            return yield* parking.resume(target.runId);
          }).pipe(Effect.provide(TestClock.layer())),
        );
        expect(restored.runtimeInstanceId).not.toBe(target.runtimeInstanceId);
        expect(restored.sandboxId).toBe("bx_3456789a");
        expect(await execute(custody.resolveExecution(target.runId))).toEqual(restored);
        expect(
          (await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId)))?.resourceId,
        ).toBe(target.sandboxId);
        expect(s.provider.creates).toHaveLength(2);
        await expect(execute(s.resourceOwner.prepare(target))).rejects.toThrow("held");
      }));
    /** A capture session whose Stop could not confirm its FINAL saved (Mend refused uploads). */
    const keptByStop = async (
      s: Parameters<Parameters<typeof test>[0]>[0],
      automaticParkingEnabled = true,
    ) => {
      s.provider.parking = true;
      const target = await execute(s.allocations.prepare(s.input));
      await execute(
        s.readiness.launch(
          target,
          Redacted.make({
            bootEnv: {
              SEALANT_WORKSPACE_SOURCE: "capture",
              SEALANT_CAPTURE_ENDPOINT: "https://capture.invalid/session",
              SEALANT_CAPTURE_WORKTREE_ID: "wt_1",
              SEALANT_CAPTURE_LAUNCH_ID: "parking-launch",
            },
            secretEnv: { SEALANT_CAPTURE_TOKEN: "local-proof-token" },
            pins: { credentialVersions: [], dotfiles: [] },
            docker: false,
          }),
        ),
      );
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      s.gateway.allowRemoval = true;
      const { owner } = await execute(
        s.final([captureStatus({ complete: false, incompleteReason: "ship-failed" })]),
      );
      expect(await execute(owner.close(target))).toBe("retained");
      const parking = await execute(
        s.parking(
          [
            captureStatus({ complete: false, incompleteReason: "ship-failed", pending: 1 }),
            captureStatus({ epoch: 2 }),
          ],
          automaticParkingEnabled,
        ),
      );
      return { target, owner, parking, custody: await execute(s.canonical.preservation) };
    };
    it("records the retention of a Stop that kept the VM, so parking enrolls it, never before the parking delay (harness: park and resume)", () =>
      test(async (s) => {
        const { target, owner, parking, custody } = await keptByStop(s);
        const root = await execute(s.canonical.getByRunId(target.runId));
        expect(root?.retainedAt).toBeInstanceOf(Date);
        expect(root?.retainedReason).toMatch(/^FINAL not saved · unconfirmed/);
        expect(await execute(parking.reconcile())).toEqual([]);
        const enrolled = await execute(custody.read(target.runId));
        expect(enrolled).toMatchObject({ state: "retained", parkingDelaySeconds: 300 });
        expect(Date.parse(enrolled?.retainedSince ?? "")).toBe(root?.retainedAt?.getTime());
        expect(Date.parse(enrolled?.parkingEligibleAt ?? "")).toBe(
          (root?.retainedAt?.getTime() ?? 0) + 300_000,
        );
        // Parking owns the lineage now: the lifecycle sweep no longer retries the close.
        expect((await execute(owner.reconcile({ limit: 20 }))).entries).toContainEqual({
          runId: target.runId,
          outcome: "skipped",
        });
        // Due on the action clock, but the retention is younger than the delay: nothing is saved.
        await execute(makeParkingActionDue(s.db, target.runId));
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("held");
        expect(s.provider.saves).toBe(0);
        expect(s.provider.deleteCalls).toBe(0);
      }));
    it("with automatic parking off, leaves a session its Stop kept to the lifecycle sweep, which closes it once its FINAL saves", () =>
      test(async (s) => {
        const { target, owner, parking, custody } = await keptByStop(s, false);
        expect((await execute(s.canonical.getByRunId(target.runId)))?.retainedAt).toBeInstanceOf(
          Date,
        );
        // Not enrolled: custody could release the source only by parking it, which is off.
        expect(await execute(parking.reconcile())).toEqual([]);
        expect((await execute(s.canonical.getByRunId(target.runId)))?.custodyContract).toBeNull();
        expect(await execute(custody.read(target.runId))).toBeUndefined();
        // The owner asks to recover it; the lifecycle sweep keeps retrying its FINAL meanwhile.
        expect(await execute(s.canonical.requestRecovery(target.runId))).toMatchObject({
          custodyContract: null,
        });
        expect((await execute(owner.reconcile({ limit: 20 }))).entries).toContainEqual({
          runId: target.runId,
          outcome: "retained",
        });
        expect(s.provider.deleteCalls).toBe(0);
        // Mend accepts the uploads again: the next pass saves the FINAL and closes the session.
        const saved = await execute(s.final([savedStatus()]));
        expect((await execute(saved.owner.reconcile({ limit: 20 }))).entries).toContainEqual({
          runId: target.runId,
          outcome: "closed",
        });
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.provider.saves).toBe(0);
        expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
          state: "stopped",
          retainedAt: null,
        });
      }));
    it("a close in flight keeps parking from enrolling the session, so with parking on a recorded retention is left to parking (harness: park and resume, P1b)", () =>
      test(async (s) => {
        const { target, parking } = await keptByStop(s);
        const contract = async () =>
          (await execute(s.canonical.getByRunId(target.runId)))?.custodyContract;
        // The next close of the kept session, its FINAL still in flight while the parking sweep
        // runs: the guard refuses to enroll a row a drain holds.
        const reached = await execute(Deferred.make<void>()),
          open = await execute(Deferred.make<void>());
        const draining = await execute(
          s.final([
            {
              gated: captureStatus({ complete: false, incompleteReason: "ship-failed" }),
              reached,
              open,
            },
          ]),
        );
        const inFlight = execute(draining.owner.close(target));
        await execute(Deferred.await(reached));
        expect((await execute(s.canonical.getByRunId(target.runId)))?.leaseOwner).not.toBeNull();
        expect(await execute(parking.reconcile())).toEqual([]);
        expect(await contract()).toBeNull();
        await execute(Deferred.succeed(open, undefined));
        expect(await inFlight).toBe("retained");
        // With parking on the close leaves a recorded retention alone: no FINAL, no lease.
        const leaving = await execute(
          s.final(
            [captureStatus({ complete: false, incompleteReason: "ship-failed" })],
            undefined,
            0,
            true,
          ),
        );
        expect(await execute(leaving.owner.close(target))).toBe("retained");
        expect(leaving.daemon.calls).toEqual([]);
        expect((await execute(s.canonical.getByRunId(target.runId)))?.leaseOwner).toBeNull();
        expect(await execute(parking.reconcile())).toEqual([]);
        expect(await contract()).toBe(3);
        // Nothing was removed on the way: the VM is parking's to save.
        expect(s.provider.deleteCalls).toBe(0);
      }));
    it("never hands a retained Boat session to the legacy recovery sweep, with parking on or off (P1b)", () =>
      test(async (s) => {
        const { target } = await keptByStop(s, false);
        expect((await execute(s.canonical.getByRunId(target.runId)))?.retainedAt).toBeInstanceOf(
          Date,
        );
        expect(
          (await execute(s.canonical.listRetainedDue({ limit: 100 }))).map((row) => row.runId),
        ).not.toContain(target.runId);
        expect(
          await execute(s.canonical.listRetainedDue({ limit: 100, runIds: [target.runId] })),
        ).toEqual([]);
      }));
    it("parks a session its Stop kept once the parking delay has passed (harness: park and resume)", () =>
      test(async (s) => {
        const { target, parking, custody } = await keptByStop(s);
        // The Stop recorded the retention; here it is moved back past the delay.
        expect((await execute(s.canonical.getByRunId(target.runId)))?.retainedAt).toBeInstanceOf(
          Date,
        );
        await execute(backdateUnenrolledParkingRetention(s.db, target.runId));
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("pending");
        await execute(makeParkingActionDue(s.db, target.runId));
        expect((await execute(parking.reconcile()))[0]?.outcome).toBe("parked");
        expect(s.provider.saves).toBe(1);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await execute(custody.read(target.runId))).toMatchObject({
          state: "parked",
          snapshotOnly: true,
        });
      }));
    it("parks the resumed child after its own idle delay and discharges every saved ancestor on discard", () =>
      test(async (s) => {
        const { target, parking, custody } = await parkingSource(s, [
          captureStatus({ complete: false, incompleteReason: "ship-failed", pending: 1 }),
          captureStatus({ epoch: 2 }),
          captureStatus({ epoch: 2, complete: false, incompleteReason: "ship-failed", pending: 1 }),
        ]);
        await execute(parking.reconcile());
        expect(await execute(parking.park(target))).toBe("parked");
        await execute(s.canonical.requestRecovery(target.runId));
        const restored = await execute(
          Effect.gen(function* () {
            yield* TestClock.setTime(Date.now() + 60_000);
            return yield* parking.resume(target.runId);
          }).pipe(Effect.provide(TestClock.layer())),
        );
        await execute(parking.retain(restored));
        // The original episode has expired, but this incarnation's retention delay has not.
        await expect(execute(parking.park(restored))).rejects.toThrow("held");
        expect(s.provider.saves).toBe(1);
        await execute(makeParkingActionDue(s.db, target.runId));
        expect(await execute(parking.park(restored))).toBe("pending");
        expect(await execute(parking.park(restored))).toBe("parked");
        expect(s.provider.saves).toBe(2);
        expect(s.provider.deleteCalls).toBe(2);
        expect(await execute(custody.read(target.runId))).toMatchObject({
          state: "parked",
          snapshotOnly: true,
        });
        expect((await execute(s.tunnels.get(restored.runtimeInstanceId)))?.released).toBe(true);
        await execute(
          s.canonical.requestDiscard({ runId: target.runId, requestedBy: "local-owner" }),
        );
        expect(await execute(parking.park(restored))).toBe("parked");
        expect(s.provider.retirements).toBe(2);
        expect(s.provider.savedRecords.size).toBe(0);
        expect(await execute(custody.read(target.runId))).toMatchObject({
          state: "closed",
          snapshots: [{ state: "removed" }, { state: "removed" }],
        });
      }));
    it("repeated FINAL of an early-aborted resource failure stays closed without resource setup", () =>
      test(async (s) => {
        const resource = await linkedResource(s);
        await execute(
          s.resources.setDesired(resource.id, {
            kind: "stop",
            reason: { kind: "person", by: "boat-check" },
          }),
        );
        const target = await execute(s.allocations.prepare(s.input));
        s.guest.lostIsolation = true;
        await expect(
          execute(s.readiness.launch(target, Redacted.make(launchMaterial()))),
        ).rejects.toThrow("unavailable");
        // Gateway setup settled normally before guest isolation failed. FINAL needs no
        // resource setup or manual settlement to close this pre-invocation execution.
        expect((await tunnelRecord(s, target)).updates).toEqual([]);
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        await execute(
          s.canonical.storeCaptureToken({ runId: target.runId, sealed: "local-sealed-capture" }),
        );
        s.gateway.allowRemoval = true;
        const { owner, daemon } = await execute(s.final([]));
        expect(await execute(owner.close(target))).toBe("closed");
        expect(await execute(owner.close(target))).toBe("closed");
        expect(await execute(owner.reconcile({ limit: 20 }))).toMatchObject({
          entries: [{ runId: target.runId, outcome: "closed" }],
        });
        expect(await execute(s.resourceOwner.reconcile({ limit: 20 }))).toMatchObject({
          entries: [{ runId: target.runId, outcome: "closed" }],
        });
        expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
        expect(daemon.calls).toEqual([]);
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.gateway.removeCalls).toBe(1);
      }));
    it("identifies a gateway failure within readiness without exposing arbitrary error text", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        s.gateway.unavailable = true;
        try {
          await execute(s.readiness.launch(target, Redacted.make(launchMaterial())));
          throw new Error("expected gateway refusal");
        } catch (error) {
          expect(error).toMatchObject({
            diagnostic: {
              step: "readiness",
              errorClass: "BoatTunnelError",
              code: "gateway-unavailable",
              resourceOperation: "configure-gateway",
            },
          });
          expect(String(error)).not.toContain("unknown gateway outcome");
        }
      }));
    it.each([
      { absent: false, capture: false },
      { absent: false, capture: true },
      { absent: true, capture: false },
      { absent: true, capture: true },
    ])(
      "the proof accepts only a settled early abort, absent=$absent capture=$capture",
      ({ absent, capture }) =>
        test(async (s) => {
          const target = await execute(s.allocations.prepare(s.input));
          await execute(s.executor.stage(target.runId, Redacted.make(launchMaterial())));
          await execute(s.resourceOwner.prepare(target));
          if (capture)
            await execute(
              s.canonical.storeCaptureToken({
                runId: target.runId,
                sealed: "local-sealed-capture",
              }),
            );
          if (s.input.scope.kind !== "owner") throw new Error("expected owner scope");
          const core = makeBoatProofCore({
            config: boatProofConfigSchema.parse({
              origin: "https://mend.example.invalid",
              projectId: "proof",
              ownerId: s.input.scope.ownerUserId,
              deploymentId: "test",
              resourceHost: "db",
              resourcePort: 5432,
            }),
            databaseUrl: s.databaseUrl,
            builderOwner: "local",
            journalDirectory: "/unused",
            api: s.api,
          });
          const session = {
            id: "session",
            projectId: "proof",
            worktree: "proof",
            worktreeId: "tree",
            status: "stopped",
            idleStoppedAt: null,
            sealantRunId: target.runId,
            sealantWorkspaceId: target.workspaceId,
          } as const;
          try {
            expect(await core.runtime(session)).toMatchObject({ closed: false });
            await execute(
              s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }),
            );
            s.gateway.allowRemoval = true;
            s.gateway.removalUnavailable = true;
            s.provider.sandboxMissing = absent;
            const { owner } = await execute(s.final([]));
            expect(await execute(owner.close(target))).toBe("pending");
            expect(await core.runtime(session)).toMatchObject({ ready: false, closed: false });
            s.gateway.removalUnavailable = false;
            expect(await execute(owner.close(target))).toBe("closed");
            expect(await core.runtime(session)).toMatchObject({
              runId: target.runId,
              ready: false,
              closed: true,
            });
            expect((await execute(s.tunnels.get(target.runId)))?.removal).toBeUndefined();
            expect(
              (await execute(s.canonical.getByRunId(target.runId)))?.deletionState ?? null,
            ).toBeNull();
            expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe(
              "released",
            );
          } finally {
            await core.dispose();
          }
        }),
    );
    it("launches only after current isolation and observes authenticated readiness without another invocation", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        const payload = Redacted.make(launchMaterial());
        expect(await execute(s.readiness.launch(target, payload))).toMatchObject({
          runtimeId: "rt_fixture",
          handshake: "verified",
          admission: "held",
        });
        expect(await execute(s.readiness.observe(target))).toMatchObject({
          bootId: target.bootId,
        });
        // The exchange proves the bearer on health; the tunnel is configured before the launch is
        // pushed; readiness reads health, then the tunnel's handshake, after it.
        const launchAt = s.guest.actions.indexOf("launch");
        expect(s.guest.actions[0]).toBe("health");
        expect(s.guest.actions.indexOf("network")).toBeLessThan(launchAt);
        expect(s.guest.actions.indexOf("health", launchAt)).toBeGreaterThan(launchAt);
        expect(s.guest.actions.indexOf("network-status", launchAt)).toBeGreaterThan(
          s.guest.actions.indexOf("health", launchAt),
        );
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
          execute(s.readiness.launch(target, Redacted.make(launchMaterial()))),
        ).rejects.toThrow("held");
        expect(s.guest.starts).toBe(1);
        expect(s.guest.launches).toHaveLength(1);
      }));
    it("a stop accepted during authenticated readiness keeps the result held", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        s.guest.beforeReady = () =>
          execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" })).then(
            () => undefined,
          );
        await expect(
          execute(s.readiness.launch(target, Redacted.make(launchMaterial()))),
        ).rejects.toThrow("held");
        expect(s.guest.starts).toBe(1);
      }));
    it("a stop accepted during network setup prevents the launch push", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        s.guest.beforeIsolate = () =>
          execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" })).then(
            () => undefined,
          );
        await expect(
          execute(s.readiness.launch(target, Redacted.make(launchMaterial()))),
        ).rejects.toThrow("held");
        expect(s.guest.networkBodies).toHaveLength(1);
        expect(s.guest.starts).toBe(0);
      }));
    it("bounds a stalled gateway and retries only the same durable network intent", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        await execute(s.executor.stage(target.runId, Redacted.make(launchMaterial())));
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
          await expect(
            execute(s.tunnels.freeze(await tunnelRecord(s, target), randomUUID())),
          ).rejects.toThrow("operation-held");
        } finally {
          release.resolve();
        }
        // The timed-out caller left the actual host call under the layer-owned fence.
        // Wait for its positive return to settle the durable dispatch before retrying.
        await vi.waitFor(async () => {
          expect((await execute(s.tunnels.get(target.runId)))?.updates).toEqual([]);
        });
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
        await execute(s.executor.stage(target.runId, Redacted.make(launchMaterial())));
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
        await execute(s.executor.stage(target.runId, Redacted.make(launchMaterial())));
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
        // The create reply is lost and Boat's inventory stays unreachable, so the launch gives up.
        s.provider.lostCreate = true;
        s.provider.inventoryUnavailable = true;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow(
          "provider-unavailable",
        );
        s.provider.inventoryUnavailable = false;
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "issued",
          sandboxId: null,
        });
        const swept = await execute(s.allocations.reconcile({ limit: 20 }));
        expect(swept.entries).toEqual([{ runId: s.input.consumer.runId, outcome: "bound" }]);
        expect(s.provider.creates).toHaveLength(1);
        expect(s.guest.targets).toHaveLength(1);
      }));
    it("resolves an issued create with no VM identity by replaying it under the same key (audit S4)", () =>
      test(async (s) => {
        const record = await execute(s.repo.reserve(reservation(s.input)));
        const issued = await execute(s.repo.advance(record, { ...record, phase: "issued" }));
        // An inventory Boat cannot list proves nothing: no replay, the pin stays.
        s.provider.inventoryUnavailable = true;
        expect((await execute(s.allocations.reconcile({ limit: 20 }))).entries[0]?.outcome).toBe(
          "unavailable",
        );
        expect(s.provider.creates).toHaveLength(0);
        await expect(
          execute(s.catalog.release(s.input.consumer, s.input.publication.publicationId)),
        ).rejects.toThrow("consumer-conflict");
        // An empty inventory: the create was lost before Boat accepted it, or Boat has not listed
        // it yet. Replaying it under the same idempotency key yields a positive identity.
        s.provider.inventoryUnavailable = false;
        expect((await execute(s.allocations.reconcile({ limit: 20 }))).entries[0]?.outcome).toBe(
          "bound",
        );
        expect(s.provider.creates).toHaveLength(1);
        expect(s.provider.creates[0]?.key).toBe(issued.idempotencyKey);
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "bound",
          sandboxId: "bx_23456789",
        });
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
        // The one issuer's key is the only one Boat ever sees.
        expect(s.provider.creates.map((create) => create.key)).toEqual([record.idempotencyKey]);
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
    it("adopts the matching worker pending row without replacing its launch lease", () =>
      test(async (s) => {
        const owner = randomUUID();
        const before = await execute(
          s.runtimes.upsertRuntimeInstance({
            runId: s.input.consumer.runId,
            adapter: "boat",
            status: "pending",
            publication: s.input.publication,
            imageScope: s.input.scope,
            sourceKind: "capture",
            launchOwner: owner,
            launchLeaseMs: 300_000,
          }),
        );
        const record = await execute(s.repo.reserve(reservation(s.input)));
        expect(await execute(s.repo.reserve(record))).toEqual(record);
        const after = await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId));
        expect(after).toEqual(before);
        expect(after?.launchOwner).toBe(owner);
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
        // The create reply is lost and Boat's inventory stays unreachable, so the launch gives up.
        s.provider.lostCreate = true;
        s.provider.inventoryUnavailable = true;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow(
          "provider-unavailable",
        );
        s.provider.inventoryUnavailable = false;
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
        // The create reply is lost and Boat's inventory stays unreachable, so the launch gives up.
        s.provider.lostCreate = true;
        s.provider.inventoryUnavailable = true;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow(
          "provider-unavailable",
        );
        s.provider.inventoryUnavailable = false;
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
        s.provider.inventoryUnavailable = true;
        const sweep = await execute(s.allocations.reconcile({ limit: 2 }));
        expect(sweep.entries).toContainEqual({
          runId: s.input.consumer.runId,
          outcome: "unavailable",
        });
        expect(sweep.entries).toContainEqual({
          runId: nextInput.consumer.runId,
          outcome: "unavailable",
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
        s.provider.inventoryUnavailable = true;
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

/** Observed presence against a Boat fake that keeps the recorded asynchronous create. */
const observedLaunch = async (
  s: AllocationFixture,
  options: { readonly boat?: (boat: RecordedBoat) => void } = {},
) => {
  const boat = new RecordedBoat();
  options.boat?.(boat);
  const api = HttpBoatApi.create({
    credential: secret("test-provider-key-local-only"),
    baseUrl: await boat.listen(),
    timeoutMs: 1000,
  });
  if (!api.ok) throw api.error;
  const observations = await execute(
    Effect.gen(function* () {
      return yield* BoatObservationRepo;
    }).pipe(
      Effect.provide(BoatObservationRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, s.db)))),
    ),
  );
  const observer = await execute(
    Effect.gen(function* () {
      return yield* BoatObserver;
    }).pipe(
      Effect.provide(
        boatObserverLayerNoDeps.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(BoatObservationRepo, observations),
              Layer.succeed(BoatAllocationProvider, { deploymentId: "test", api: api.value }),
            ),
          ),
        ),
      ),
    ),
  );
  const reserved = await execute(s.repo.reserve(reservation(s.input)));
  const issued = await execute(s.repo.advance(reserved, { ...reserved, phase: "issued" }));
  const ownership = BoatOwnership.parse({
    ...s.input,
    ...s.input.consumer,
    sourceId: s.input.publication.publicationId,
  });
  if (!ownership.ok) throw ownership.error;
  const created = await api.value.create({
    idempotencyKey: issued.idempotencyKey,
    ownership: ownership.value,
    lifetime: { kind: "production-session" },
    from: s.input.publication.snapshot.identity.name,
  });
  if (!created.ok) throw created.error;
  expect(created.value.state).toBe("provisioned");
  const allocation = await execute(
    s.repo.advance(issued, { ...issued, phase: "allocated", sandboxId: created.value.id }),
  );
  await execute(
    recordRetainedBoatLaunch(s.db, {
      runId: s.input.consumer.runId,
      sandboxId: created.value.id,
      errorCode: LAUNCH_RETAINED_ERROR_CODE,
    }),
  );
  /** Read until Boat reports creation finished (`provisioned`, `cloning`, then `idle`). */
  const readUntilCreated = async () => {
    for (let read = 0; read < 3; read += 1)
      expect(await execute(observer.observe(allocation))).toMatchObject({ kind: "present" });
    expect(await execute(observations.get(s.input.consumer.runtimeInstanceId))).toMatchObject({
      providerState: "idle",
      createdObservedAt: expect.any(Date),
    });
  };
  return {
    boat,
    api: api.value,
    observer,
    allocation,
    sandboxId: created.value.id,
    observations,
    readUntilCreated,
  };
};

describe.runIf(databaseUrl !== undefined)("Boat observed presence", () => {
  it("never reads a 404 straight after create as absence", () =>
    test(async (s) => {
      const o = await observedLaunch(s, {
        boat: (boat) => {
          boat.unreadableAfterCreate = 1;
        },
      });
      try {
        expect(await execute(o.observer.observe(o.allocation))).toMatchObject({
          kind: "unknown",
          reason: "creating",
        });
        expect(
          await execute(o.observations.get(s.input.consumer.runtimeInstanceId)),
        ).toBeUndefined();
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
        ).toMatchObject({
          status: "failed",
          removedAt: null,
        });
        expect(await execute(o.observer.observe(o.allocation))).toMatchObject({ kind: "present" });
      } finally {
        await o.boat.close();
      }
    }));

  it("never takes a 404 for absence while Boat has only reported the VM provisioning, however long ago it was issued", () =>
    test(async (s) => {
      const o = await observedLaunch(s, {
        boat: (boat) => {
          boat.stuckProvisioning = true;
        },
      });
      try {
        // Read once in `provisioned`: present, but its creation is not finished.
        expect(await execute(o.observer.observe(o.allocation))).toMatchObject({ kind: "present" });
        // Reviewer's repro: issuance long past, the VM still provisioning, and Boat answers 404.
        await execute(
          backdateAllocation(s.db, s.input.consumer.runtimeInstanceId, 24 * 60 * 60_000),
        );
        o.boat.unreadableAfterCreate = 10;
        expect(await execute(o.observer.observe(o.allocation))).toMatchObject({
          kind: "unknown",
          reason: "creating",
        });
        const { owner } = await execute(s.final([], o.api));
        expect(await execute(owner.closeUnbound(s.input.consumer.runId, o.sandboxId))).toBe(
          "pending",
        );
        expect(o.boat.requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
        expect(o.boat.vms.has(o.sandboxId)).toBe(true);
        expect(await execute(o.observations.get(s.input.consumer.runtimeInstanceId))).toMatchObject(
          {
            presence: "present",
            createdObservedAt: null,
          },
        );
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
        ).toMatchObject({
          status: "failed",
          removedAt: null,
        });
      } finally {
        await o.boat.close();
      }
    }));

  it("records absence once Boat reported the VM created and then no longer has it; the runtime reads stopped with its launch error kept", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        await o.readUntilCreated();
        o.boat.removeOutOfBand(o.sandboxId);
        expect(await execute(o.observer.observe(o.allocation))).toEqual({
          kind: "absent",
          basis: "not-found",
        });
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
        ).toMatchObject({
          status: "stopped",
          stopReason: "failed",
          removedAt: expect.any(Date),
          errorCode: LAUNCH_RETAINED_ERROR_CODE,
        });
        // Absent is terminal: Boat is not asked again and nothing revives the VM.
        const reads = o.boat.requests.length;
        expect(await execute(o.observer.observe(o.allocation))).toMatchObject({ kind: "absent" });
        expect(o.boat.requests).toHaveLength(reads);
        await expect(
          execute(
            o.observations.recordPresent({
              runtimeInstanceId: s.input.consumer.runtimeInstanceId,
              deploymentId: "test",
              sandboxId: o.sandboxId,
              providerState: "idle",
              created: true,
            }),
          ),
        ).resolves.toMatchObject({ presence: "absent" });
      } finally {
        await o.boat.close();
      }
    }));

  it("lets an absence committed during an overlapping read win over that read", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        await o.readUntilCreated();
        // Boat completes this VM's deletion (another owner records it) while a read is in flight;
        // the read was answered before the VM went.
        o.boat.beforeRead = async () => {
          o.boat.beforeRead = async () => {};
          await execute(o.observer.deletionCompleted(o.allocation, o.sandboxId));
        };
        expect(await execute(o.observer.observe(o.allocation))).toEqual({
          kind: "absent",
          basis: "deletion-completed",
        });
        expect(await execute(o.observations.get(s.input.consumer.runtimeInstanceId))).toMatchObject(
          {
            presence: "absent",
          },
        );
      } finally {
        await o.boat.close();
      }
    }));

  it("never takes a transport failure or a foreign VM for absence", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        await o.readUntilCreated();
        o.boat.unreachable = true;
        expect(await execute(o.observer.observe(o.allocation))).toMatchObject({
          kind: "unknown",
          reason: "unreadable",
        });
        o.boat.unreachable = false;
        const vm = o.boat.vms.get(o.sandboxId);
        if (vm === undefined) throw new Error("missing VM");
        o.boat.vms.set(o.sandboxId, { ...vm, labels: { ...vm.labels, "sealant-run": "other" } });
        expect(await execute(o.observer.observe(o.allocation))).toEqual({
          kind: "unknown",
          reason: "foreign",
        });
        expect(await execute(o.observations.get(s.input.consumer.runtimeInstanceId))).toMatchObject(
          {
            presence: "present",
          },
        );
      } finally {
        await o.boat.close();
      }
    }));

  it("closes an unbound VM only on absence Boat can vouch for, never on a 404 straight after create", () =>
    test(async (s) => {
      const o = await observedLaunch(s, {
        boat: (boat) => {
          boat.unreadableAfterCreate = 2;
        },
      });
      try {
        const { owner } = await execute(s.final([], o.api));
        expect(await execute(owner.closeUnbound(s.input.consumer.runId, o.sandboxId))).toBe(
          "pending",
        );
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "deleting",
        });
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
        ).toMatchObject({
          removedAt: null,
        });
        expect(o.boat.vms.has(o.sandboxId)).toBe(true);
      } finally {
        await o.boat.close();
      }
    }));

  it("ends retention and the capture token once FINAL removed the VM (audit S2)", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      await execute(s.canonical.storeCaptureToken({ runId: target.runId, sealed: "sealed-token" }));
      await execute(s.canonical.markRetained({ runId: target.runId, reason: "executor exited" }));
      const { owner } = await execute(s.final([savedStatus()]));
      expect(await execute(owner.close(target))).toBe("closed");
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        state: "stopped",
        retainedAt: null,
        captureTokenSealed: null,
        nextRecoveryAt: null,
      });
      expect((await execute(s.repo.get(target.runId)))?.phase).toBe("deleted");
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
      // The sealed copy of the launch payload kept for resume is erased with the VM.
      const execution = await execute(s.executions.get(target.runId));
      expect(execution?.admission).not.toBeNull();
      expect(execution?.admission?.sealedResumeEnvelope).toBeUndefined();
      // The deleted VM is no longer driven as if it were current.
      expect(await execute(s.allocations.reconcile({ limit: 10 }))).toMatchObject({
        entries: [{ runId: target.runId, outcome: "deleted" }],
      });
    }));

  it("ends a ready VM's execution when Boat no longer has it, reporting its work lost (audit S6)", () =>
    test(async (s) => {
      const target = await launched(s);
      await execute(
        s.runtimes.upsertRuntimeInstance({
          runId: target.runId,
          adapter: "boat",
          status: "ready",
          resourceId: target.sandboxId,
        }),
      );
      await execute(s.canonical.storeCaptureToken({ runId: target.runId, sealed: "sealed-token" }));
      const { owner, daemon } = await execute(s.final([]));
      s.gateway.allowRemoval = true;
      expect(await execute(owner.reconcile({ limit: 10 }))).toMatchObject({
        entries: [{ runId: target.runId, outcome: "skipped" }],
      });
      // A person deletes the VM in Boat's console; no stop was ever requested.
      s.provider.sandboxMissing = true;
      await execute(backdateObservation(s.db, target.runtimeInstanceId, 120_000));
      expect(await execute(owner.reconcile({ limit: 10 }))).toMatchObject({
        entries: [{ runId: target.runId, outcome: "closed" }],
      });
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
        status: "stopped",
        stopReason: "failed",
        removedAt: expect.any(Date),
      });
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        state: "gone",
        retainedAt: null,
        captureTokenSealed: null,
      });
      expect((await tunnelRecord(s, target)).released).toBe(true);
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
      expect(s.provider.deleteCalls).toBe(0);
      expect(daemon.calls).toEqual([]);
    }));

  it("adopts a launch whose worker died as failed and closes it (audit S3)", () =>
    test(async (s) => {
      const target = await launched(s);
      await execute(strandBoatLaunch(s.db, { runId: target.runId, sandboxId: target.sandboxId }));
      const { owner, daemon } = await execute(s.final([savedStatus()]));
      s.gateway.allowRemoval = true;
      expect(await execute(owner.reconcile({ limit: 10 }))).toMatchObject({
        entries: [{ runId: target.runId, outcome: "closed" }],
      });
      expect(daemon.flushRequests[0]?.kind).toBe("final");
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
        status: "stopped",
        stopReason: "failed",
        removedAt: expect.any(Date),
        launchOwner: null,
      });
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        state: "stopped",
        retainedAt: null,
      });
      expect(s.provider.deleteCalls).toBe(1);
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
    }));

  it("never reports saved work after a newer unsaved answer when Boat loses the VM (review of #494)", () =>
    test(async (s) => {
      const target = await launched(s);
      await execute(
        s.runtimes.upsertRuntimeInstance({
          runId: target.runId,
          adapter: "boat",
          status: "ready",
          resourceId: target.sandboxId,
        }),
      );
      // An earlier FINAL was saved, then the daemon reported unsaved work again.
      await execute(
        s.canonical.recordStatus({
          runId: target.runId,
          status: { ...savedStatus() },
          observedAt: new Date(),
        }),
      );
      await execute(
        s.canonical.recordObservation({
          runId: target.runId,
          state: "saved",
          detail: "earlier FINAL",
        }),
      );
      await execute(
        s.canonical.recordStatus({
          runId: target.runId,
          status: { ...captureStatus({ complete: false }) },
          observedAt: new Date(),
        }),
      );
      s.provider.sandboxMissing = true;
      s.gateway.allowRemoval = true;
      await execute(backdateObservation(s.db, target.runtimeInstanceId, 120_000));
      const { owner } = await execute(s.final([]));
      await execute(owner.reconcile({ limit: 20 }));
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        state: "gone",
        retainedAt: null,
      });
    }));

  it("recovers a lost create reply Boat has not listed yet by replaying the same key, with no second VM (audit S4)", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        const allocations = await recordedAllocations(s, o);
        // A second launch whose create reply is lost and which Boat does not list yet.
        const input = await execute(seed(s.db, s.catalog));
        const reserved = await execute(s.repo.reserve(reservation(input)));
        o.boat.savedSnapshots.set(input.publication.snapshot.identity.name, {
          ...input.publication.snapshot.identity,
          status: "ready",
        });
        o.boat.loseCreateReply = true;
        o.boat.outageAfterLostCreate = true;
        await expect(execute(allocations.prepare(input))).rejects.toThrow();
        o.boat.outageAfterLostCreate = false;
        o.boat.unreachable = false;
        expect(await execute(s.repo.get(input.consumer.runId))).toMatchObject({
          phase: "issued",
          sandboxId: null,
        });
        const accepted = [...o.boat.vms.values()].filter(
          (vm) => vm.key === reserved.idempotencyKey,
        );
        expect(accepted).toHaveLength(1);
        o.boat.loseCreateReply = false;
        o.boat.unlisted = true;
        await execute(allocations.reconcile({ limit: 20 }));
        expect(await execute(s.repo.get(input.consumer.runId))).toMatchObject({
          phase: "allocated",
          sandboxId: accepted[0]?.id,
        });
        expect(
          [...o.boat.vms.values()].filter((vm) => vm.key === reserved.idempotencyKey),
        ).toHaveLength(1);
      } finally {
        await o.boat.close();
      }
    }));

  it("takes a definite create refusal as proof Boat holds no VM and discharges the launch (audit S4)", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        const allocations = await recordedAllocations(s, o);
        const input = await execute(seed(s.db, s.catalog));
        const reserved = await execute(s.repo.reserve(reservation(input)));
        await execute(s.repo.advance(reserved, { ...reserved, phase: "issued" }));
        await execute(
          s.runtimes.upsertRuntimeInstance({
            runId: input.consumer.runId,
            adapter: "boat",
            status: "failed",
          }),
        );
        // Unknown outcomes never settle it: Boat is unreachable, then busy with the same key.
        o.boat.unlisted = true;
        o.boat.rejectCreate = { status: 409, code: "idempotency_in_progress" };
        await execute(allocations.reconcile({ limit: 20 }));
        expect((await execute(s.repo.get(input.consumer.runId)))?.phase).toBe("issued");
        o.boat.rejectCreate = { status: 402, code: "insufficient_balance" };
        await execute(allocations.reconcile({ limit: 20 }));
        expect(await execute(s.repo.get(input.consumer.runId))).toMatchObject({
          phase: "deleted",
          sandboxId: null,
          removal: { kind: "never-created" },
        });
        const { owner } = await execute(s.final([], o.api));
        const sweep = await execute(owner.reconcile({ limit: 20 }));
        expect(sweep.entries).toContainEqual({ runId: input.consumer.runId, outcome: "closed" });
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(input.consumer.runId)),
        ).toMatchObject({
          status: "stopped",
          removedAt: expect.any(Date),
        });
        expect((await execute(nativeConsumerRows(s.db, input.consumer.runId)))[0]?.state).toBe(
          "released",
        );
      } finally {
        await o.boat.close();
      }
    }));

  it("never replays a create past Boat's key retention; an unlisted VM stays held until discovery finds it (review of #495)", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        const allocations = await recordedAllocations(s, o);
        const { input, key } = await lostCreate(s, o);
        const posts = () => o.boat.requests.filter((r) => r === "POST /api/v1/sandboxes").length;
        const created = posts();
        // 25 hours pass: Boat has forgotten the key and does not list the VM yet.
        await agedIssuance(s, input.consumer.runtimeInstanceId);
        o.boat.elapse(25 * HOUR);
        o.boat.unlisted = true;
        await execute(allocations.reconcile({ limit: 20 }));
        expect(await execute(s.repo.get(input.consumer.runId))).toMatchObject({
          phase: "held",
          reason: "create-unresolved",
          sandboxId: null,
        });
        expect(vmsFor(o, key)).toHaveLength(1);
        expect(posts()).toBe(created);
        // Nothing concludes absence: the pin stays and the lifecycle only holds it.
        await execute(
          s.runtimes.markStopRequested({ runId: input.consumer.runId, stopReason: "failed" }),
        );
        const { owner } = await execute(s.final([], o.api));
        for (let pass = 0; pass < 3; pass += 1) await execute(owner.reconcile({ limit: 20 }));
        expect(vmsFor(o, key)).toHaveLength(1);
        expect((await execute(nativeConsumerRows(s.db, input.consumer.runId)))[0]?.state).toBe(
          "pending",
        );
        // Boat lists the VM again: discovery adopts it and the lifecycle closes it.
        o.boat.unlisted = false;
        await execute(allocations.reconcile({ limit: 20 }));
        expect(await execute(s.repo.get(input.consumer.runId))).toMatchObject({
          phase: "allocated",
          reason: null,
        });
        for (let pass = 0; pass < 3; pass += 1) await execute(owner.reconcile({ limit: 20 }));
        expect(vmsFor(o, key)).toHaveLength(0);
        expect(posts()).toBe(created);
      } finally {
        await o.boat.close();
      }
    }));

  it("never takes a refusal past Boat's key retention as proof that no VM exists (review of #495)", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        const allocations = await recordedAllocations(s, o);
        const { input, key } = await lostCreate(s, o);
        await agedIssuance(s, input.consumer.runtimeInstanceId);
        o.boat.elapse(25 * HOUR);
        o.boat.unlisted = true;
        o.boat.rejectCreate = { status: 402, code: "insufficient_balance" };
        await execute(allocations.reconcile({ limit: 20 }));
        const { owner } = await execute(s.final([], o.api));
        await execute(owner.reconcile({ limit: 20 }));
        expect((await execute(s.repo.get(input.consumer.runId)))?.phase).toBe("held");
        expect(await execute(o.observations.get(input.consumer.runtimeInstanceId))).toBeUndefined();
        expect(vmsFor(o, key)).toHaveLength(1);
        expect((await execute(nativeConsumerRows(s.db, input.consumer.runId)))[0]?.state).toBe(
          "pending",
        );
      } finally {
        await o.boat.close();
      }
    }));

  it("ends an unresolved create's session on the owner's discard without concluding absence (review of #495)", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        const allocations = await recordedAllocations(s, o);
        const { input } = await lostCreate(s, o);
        await agedIssuance(s, input.consumer.runtimeInstanceId);
        o.boat.elapse(25 * HOUR);
        o.boat.unlisted = true;
        await execute(allocations.reconcile({ limit: 20 }));
        await execute(
          s.canonical.requestDiscard({ runId: input.consumer.runId, requestedBy: "usr_owner" }),
        );
        const { owner } = await execute(s.final([], o.api));
        expect((await execute(owner.reconcile({ limit: 20 }))).entries).toContainEqual({
          runId: input.consumer.runId,
          outcome: "held",
        });
        expect(await execute(s.canonical.getByRunId(input.consumer.runId))).toMatchObject({
          state: "discarded",
        });
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(input.consumer.runId)),
        ).toMatchObject({ status: "stopped", removedAt: null });
        expect((await execute(s.repo.get(input.consumer.runId)))?.phase).toBe("held");
      } finally {
        await o.boat.close();
      }
    }));

  it("never creates again after a crash between recording no VM and terminalizing the allocation (review of #495)", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        const input = await execute(seed(s.db, s.catalog));
        const reserved = await execute(s.repo.reserve(reservation(input)));
        await execute(
          s.repo.advance(reserved, {
            ...reserved,
            phase: "issued",
            issuedAt: new Date().toISOString(),
          }),
        );
        o.boat.savedSnapshots.set(input.publication.snapshot.identity.name, {
          ...input.publication.snapshot.identity,
          status: "ready",
        });
        const interrupted = await recordedAllocations(
          {
            ...s,
            repo: {
              ...s.repo,
              advance: (a, b) =>
                b.phase === "deleted" && b.removal?.kind === "never-created"
                  ? Effect.interrupt
                  : s.repo.advance(a, b),
            },
          },
          o,
        );
        o.boat.rejectCreate = { status: 402, code: "insufficient_balance" };
        await execute(interrupted.reconcile({ limit: 20 })).catch(() => undefined);
        expect(
          (await execute(o.observations.get(input.consumer.runtimeInstanceId)))?.presence,
        ).toBe("absent");
        expect((await execute(s.repo.get(input.consumer.runId)))?.phase).toBe("issued");
        o.boat.rejectCreate = undefined;
        const allocations = await recordedAllocations(s, o);
        await execute(allocations.reconcile({ limit: 20 }));
        expect(await execute(s.repo.get(input.consumer.runId))).toMatchObject({
          phase: "deleted",
          removal: { kind: "never-created" },
        });
        expect(vmsFor(o, reserved.idempotencyKey)).toHaveLength(0);
      } finally {
        await o.boat.close();
      }
    }));

  it("honors the owner's discard on Boat: no guest must answer before the VM is removed (audit S8)", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      await execute(s.canonical.requestDiscard({ runId: target.runId, requestedBy: "usr_owner" }));
      // The guest cannot answer at all.
      const { owner, daemon } = await execute(s.final(["unreachable"]));
      expect(await execute(owner.close(target))).toBe("closed");
      expect(daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(1);
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        state: "discarded",
        retainedAt: null,
        captureTokenSealed: null,
      });
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
        status: "stopped",
        removedAt: expect.any(Date),
      });
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
    }));

  it("honors an attested sealed FINAL on Boat without asking the guest (audit S8)", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      await execute(
        s.canonical.attestCompletion({
          runId: target.runId,
          executorId: target.sandboxId,
          epoch: 1,
          captureN: 3,
          attestedBy: "mend",
        }),
      );
      const { owner, daemon } = await execute(s.final(["unreachable"]));
      expect(await execute(owner.close(target))).toBe("closed");
      expect(daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(1);
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
    }));

  it("fences an issued start whose reply never came, keeps its VM, and lets discard remove it (audit S5)", () =>
    test(async (s) => {
      const target = await execute(s.allocations.prepare(s.input));
      await execute(s.executor.stage(target.runtimeInstanceId, Redacted.make(launchMaterial())));
      await execute(s.resourceOwner.prepare(target));
      const installed = await execute(s.executions.get(target.runId));
      if (installed === undefined) throw new Error("missing execution");
      // Core durably issued start; the guest's reply never came.
      await execute(s.executions.advance(installed, { ...installed, phase: "issued" }));
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      s.gateway.allowRemoval = true;
      const { owner } = await execute(s.final(["unreachable"]));
      // Work may exist and nothing proves it saved: the VM is kept, never deleted on a guess.
      await execute(owner.close(target)).catch(() => "kept");
      expect(s.provider.deleteCalls).toBe(0);
      // The start is fenced: Core can never send it again.
      expect((await execute(s.executions.get(target.runId)))?.phase).toBe("held");
      await expect(execute(s.executor.launch(target.runtimeInstanceId))).rejects.toThrow(
        "invocation-held",
      );
      await execute(s.canonical.requestDiscard({ runId: target.runId, requestedBy: "usr_owner" }));
      expect(await execute(owner.close(target))).toBe("closed");
      expect(s.provider.deleteCalls).toBe(1);
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        state: "discarded",
      });
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
    }));

  it("retries an attested deletion whose reply was lost, through an identical re-attestation and a later discard (review of #496)", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const seal = {
        runId: target.runId,
        executorId: target.sandboxId,
        epoch: 1,
        captureN: 3,
        attestedBy: "mend",
      };
      await execute(s.canonical.attestCompletion(seal));
      s.provider.deleteLost = true;
      const { owner } = await execute(s.final(["unreachable"]));
      await expect(execute(owner.close(target))).rejects.toThrow();
      expect(s.provider.deleteCalls).toBe(1);
      s.provider.deleteLost = false;
      // The caller retries its attestation after the lost reply: the same seal, not new evidence.
      const before = (await execute(s.canonical.getByRunId(target.runId)))?.evidenceVersion;
      await execute(s.canonical.attestCompletion(seal));
      expect((await execute(s.canonical.getByRunId(target.runId)))?.evidenceVersion).toBe(before);
      const outcomes = [];
      for (let attempt = 0; attempt < 3; attempt += 1)
        outcomes.push(await execute(owner.close(target)).catch((error: unknown) => String(error)));
      await execute(s.canonical.requestDiscard({ runId: target.runId, requestedBy: "usr_owner" }));
      const discard = await execute(owner.close(target)).catch((error: unknown) => String(error));
      expect({ outcomes, discard, deletes: s.provider.deleteCalls }).toEqual({
        outcomes: ["closed", "closed", "closed"],
        discard: "closed",
        deletes: 2,
      });
    }));

  it("completes an authorized removal when newer evidence authorizes the same removal (review of #496)", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      await execute(
        s.canonical.attestCompletion({
          runId: target.runId,
          executorId: target.sandboxId,
          epoch: 1,
          captureN: 3,
          attestedBy: "mend",
        }),
      );
      s.provider.deleteLost = true;
      const { owner } = await execute(s.final(["unreachable"]));
      await expect(execute(owner.close(target))).rejects.toThrow();
      s.provider.deleteLost = false;
      // Newer evidence that authorizes the same removal: a later sealed FINAL is attested.
      const before = (await execute(s.canonical.getByRunId(target.runId)))?.evidenceVersion ?? 0;
      await execute(
        s.canonical.attestCompletion({
          runId: target.runId,
          executorId: target.sandboxId,
          epoch: 1,
          captureN: 4,
          attestedBy: "mend",
        }),
      );
      expect((await execute(s.canonical.getByRunId(target.runId)))?.evidenceVersion).toBe(
        before + 1,
      );
      expect(await execute(owner.close(target))).toBe("closed");
      expect(s.provider.deleteCalls).toBe(2);
    }));

  it("reports an attested saved FINAL as saved after the VM is removed (review of #496)", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      await execute(
        s.canonical.attestCompletion({
          runId: target.runId,
          executorId: target.sandboxId,
          epoch: 1,
          captureN: 3,
          attestedBy: "mend",
        }),
      );
      const { owner } = await execute(s.final(["unreachable"]));
      expect(await execute(owner.close(target))).toBe("closed");
      expect(s.provider.deleteCalls).toBe(1);
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        state: "stopped",
        retainedAt: null,
        captureTokenSealed: null,
      });
    }));

  it("closes a start whose reply was lost once its worker is gone and the guest answers again (review of #494)", () =>
    test(async (s) => {
      const target = await execute(s.allocations.prepare(s.input));
      await execute(s.executor.stage(target.runtimeInstanceId, Redacted.make(launchMaterial())));
      const prepared = await execute(s.resourceOwner.prepare(target));
      await execute(
        s.executor.recordIsolation(target, {
          resourceReceipt: prepared.guest.receipt,
          tunnelReceipt: prepared.gateway.receipt,
        }),
      );
      // The agent accepts the launch; its reply never reaches Core.
      s.guest.lostLaunchReply = true;
      await expect(execute(s.executor.launch(target.runId))).rejects.toThrow();
      expect((await execute(s.executions.get(target.runId)))?.phase).toBe("issued");
      expect(s.guest.starts).toBe(1);
      // The launching worker is lost; connectivity returns.
      await execute(strandBoatLaunch(s.db, { runId: target.runId, sandboxId: target.sandboxId }));
      s.gateway.allowRemoval = true;
      const { owner } = await execute(s.final([savedStatus()]));
      await execute(owner.reconcile({ limit: 20 }));
      const second = await execute(owner.reconcile({ limit: 20 }));
      expect(second.entries).toContainEqual({ runId: target.runId, outcome: "closed" });
      expect(s.guest.starts).toBe(1);
      expect(s.provider.deleteCalls).toBe(1);
      expect((await execute(s.canonical.getByRunId(target.runId)))?.state).toBe("stopped");
    }));

  it("leaves a launch in flight its allocation: a sweep during a slow first bind changes nothing (harness R1)", () =>
    test(async (s) => {
      // The build worker writes the pending row and its launch ownership before allocating.
      await execute(
        s.runtimes.upsertRuntimeInstance({
          runId: s.input.consumer.runId,
          adapter: "boat",
          status: "pending",
          sourceKind: "capture",
          publication: s.input.publication,
          imageScope: s.input.scope,
        }),
      );
      await execute(holdBoatLaunch(s.db, s.input.consumer.runId));
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let binds = 0;
      s.guest.beforeBind = async () => {
        binds += 1;
        if (binds > 1) return;
        reached.resolve();
        await release.promise;
      };
      const launch = execute(s.allocations.prepare(s.input));
      await reached.promise;
      // The worker's sweep runs while the launch's first bind is still in flight.
      expect(await execute(s.repo.launchInFlight(s.input.consumer.runId))).toBe(true);
      await execute(s.allocations.reconcile({ limit: 20 }));
      await execute(s.resourceOwner.reconcile({ limit: 20 }));
      const { owner } = await execute(s.final([]));
      await execute(owner.reconcile({ limit: 20 }));
      expect(binds).toBe(1);
      release.resolve();
      const target = await launch;
      expect(target.runId).toBe(s.input.consumer.runId);
      expect((await execute(s.executions.get(target.runId)))?.phase).toBe("control");
      // Once the launch's ownership lapses, the sweep owns the allocation again.
      await execute(strandBoatLaunch(s.db, { runId: target.runId, sandboxId: target.sandboxId }));
      expect((await execute(s.allocations.reconcile({ limit: 20 }))).entries).toContainEqual({
        runId: target.runId,
        outcome: "bound",
      });
    }));

  it("continues a launch through a lost create reply by finding the VM Boat accepted (harness: create reply lost)", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        const allocations = await recordedAllocations(s, o);
        const input = await execute(seed(s.db, s.catalog));
        const reserved = await execute(s.repo.reserve(reservation(input)));
        o.boat.savedSnapshots.set(input.publication.snapshot.identity.name, {
          ...input.publication.snapshot.identity,
          status: "ready",
        });
        // One network blip: Boat accepts the create and the reply is lost.
        let lost = false;
        o.boat.loseCreateReply = true;
        const original = o.boat.beforeRead;
        o.boat.beforeRead = async () => {
          if (!lost) {
            lost = true;
            o.boat.loseCreateReply = false;
          }
          await original();
        };
        // The launch goes on past create. This fake runs no guest commands, so the launch stops
        // at its first one, the boot ID read, holding the VM Boat accepted.
        const failure = await execute(allocations.prepare(input)).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(String(failure)).toMatch(/read-boot-id/);
        const accepted = vmsFor(o, reserved.idempotencyKey);
        expect(accepted).toHaveLength(1);
        expect(await execute(s.repo.get(input.consumer.runId))).toMatchObject({
          phase: "allocated",
          sandboxId: accepted[0]?.id,
        });
      } finally {
        await o.boat.close();
      }
    }));

  it("records a failed launch's removal in the close that deleted it, not a later sweep (harness C1)", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        await o.readUntilCreated();
        // Boat completes the deletion while it is polled, as recorded.
        o.boat.deletionPolls = 2;
        const { owner } = await execute(s.final([], o.api, 10_000));
        expect(await execute(owner.closeUnbound(s.input.consumer.runId, o.sandboxId))).toBe(
          "closed",
        );
        expect(o.boat.vms.has(o.sandboxId)).toBe(false);
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "deleted",
        });
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
        ).toMatchObject({ status: "stopped", removedAt: expect.any(Date) });
        expect(
          o.boat.requests.filter((r) => r === `DELETE /api/v1/sandboxes/${o.sandboxId}`),
        ).toHaveLength(1);
      } finally {
        await o.boat.close();
      }
    }));

  it("removes a launch that failed while Boat was still cloning in one sweep, so it reads stopped, not retained (harness: provisioning never finishes)", () =>
    test(async (s) => {
      // Boat accepts the create but never finishes provisioning; the launch gives up and records
      // the VM it holds as a retained launch.
      const o = await observedLaunch(s, {
        boat: (boat) => {
          boat.stuckProvisioning = true;
        },
      });
      try {
        expect(await execute(o.observer.observe(o.allocation))).toMatchObject({ kind: "present" });
        o.boat.deletionPolls = 2;
        const { owner } = await execute(s.final([], o.api, 10_000));
        // One sweep closes it and records the removal Boat completed.
        expect((await execute(owner.reconcile({ limit: 20 }))).entries).toContainEqual({
          runId: s.input.consumer.runId,
          outcome: "closed",
        });
        expect(o.boat.vms.has(o.sandboxId)).toBe(false);
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
        ).toMatchObject({ status: "stopped", removedAt: expect.any(Date) });
        expect(await execute(s.canonical.getByRunId(s.input.consumer.runId))).toMatchObject({
          state: "gone",
        });
        expect((await execute(nativeConsumerRows(s.db, s.input.consumer.runId)))[0]?.state).toBe(
          "released",
        );
      } finally {
        await o.boat.close();
      }
    }));

  it("finishes a never-ready VM's recorded deletion after a restart, from Boat's operation, not its 404 (review of #508)", () =>
    test(async (s) => {
      const o = await observedLaunch(s, {
        boat: (boat) => {
          boat.stuckProvisioning = true;
        },
      });
      try {
        // Boat finishes the deletion on its own while this worker is not polling (it restarts).
        o.boat.completeDeletionsIndependently = true;
        const first = await execute(s.final([], o.api, 0));
        expect(await execute(first.owner.closeUnbound(s.input.consumer.runId, o.sandboxId))).toBe(
          "pending",
        );
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "deleting",
          removal: { kind: "operation", completed: false },
        });
        expect(o.boat.vms.has(o.sandboxId)).toBe(false);
        // The restarted worker: the VM reads 404 and was never seen created, so only Boat's
        // recorded operation can say the removal finished.
        const restarted = await execute(s.final([], o.api, 20_000));
        expect(
          await execute(restarted.owner.closeUnbound(s.input.consumer.runId, o.sandboxId)),
        ).toBe("closed");
        expect((await execute(s.repo.get(s.input.consumer.runId)))?.phase).toBe("deleted");
        expect((await execute(nativeConsumerRows(s.db, s.input.consumer.runId)))[0]?.state).toBe(
          "released",
        );
      } finally {
        await o.boat.close();
      }
    }));

  it("resumes an interrupted deletion poll of a never-ready VM after a restart (review of #508)", () =>
    test(async (s) => {
      const o = await observedLaunch(s, {
        boat: (boat) => {
          boat.stuckProvisioning = true;
        },
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const read = o.api.getDeletion.bind(o.api);
      o.api.getDeletion = async (id) => {
        entered.resolve();
        await release.promise;
        return read(id);
      };
      try {
        const { owner } = await execute(s.final([], o.api, 20_000));
        await execute(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              owner.closeUnbound(s.input.consumer.runId, o.sandboxId),
            );
            yield* Effect.promise(() => entered.promise);
            yield* Fiber.interrupt(fiber);
          }),
        );
        expect(await execute(s.repo.get(s.input.consumer.runId))).toMatchObject({
          phase: "deleting",
          removal: { kind: "operation", completed: false },
        });
        release.resolve();
        o.api.getDeletion = read;
        // Boat finishes the deletion while no worker polls it.
        o.boat.finishDeletions();
        expect(o.boat.vms.has(o.sandboxId)).toBe(false);
        const restarted = await execute(s.final([], o.api, 20_000));
        expect(
          await execute(restarted.owner.closeUnbound(s.input.consumer.runId, o.sandboxId)),
        ).toBe("closed");
        expect(
          o.boat.requests.filter((r) => r.startsWith("DELETE /api/v1/sandboxes/")),
        ).toHaveLength(1);
      } finally {
        release.resolve();
        await o.boat.close();
      }
    }));

  it(
    "keeps a blocked deletion pending even when the VM already reads 404, then finishes it (review of #508)",
    () =>
      test(async (s) => {
        const o = await observedLaunch(s, {
          boat: (boat) => {
            boat.stuckProvisioning = true;
          },
        });
        try {
          o.boat.blockDeletions = true;
          // Long enough for each close to poll the operation once (polls are 1 s apart).
          const { owner } = await execute(s.final([], o.api, 1_100));
          const polls = () =>
            o.boat.requests.filter((r) => r.startsWith("GET /api/v1/deletion-operations/")).length;
          expect(await execute(owner.closeUnbound(s.input.consumer.runId, o.sandboxId))).toBe(
            "pending",
          );
          expect(await execute(owner.closeUnbound(s.input.consumer.runId, o.sandboxId))).toBe(
            "pending",
          );
          // Boat was asked, and answered blocked each time; the 404 VM never stood in for completion.
          expect(polls()).toBeGreaterThanOrEqual(2);
          expect(
            await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
          ).toMatchObject({ removedAt: null });
          o.boat.unblockDeletions();
          expect(await execute(owner.closeUnbound(s.input.consumer.runId, o.sandboxId))).toBe(
            "closed",
          );
        } finally {
          await o.boat.close();
        }
      }),
    15_000,
  );

  it(
    "bounds the deletion wait even when a deletion read stalls (review of #508)",
    () =>
      test(async (s) => {
        const o = await observedLaunch(s);
        try {
          await o.readUntilCreated();
          o.boat.deletionPolls = 1_000;
          const read = o.api.getDeletion.bind(o.api);
          o.api.getDeletion = async (id) => {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            return read(id);
          };
          const { owner } = await execute(s.final([], o.api, 1_000));
          const started = Date.now();
          expect(await execute(owner.closeUnbound(s.input.consumer.runId, o.sandboxId))).toBe(
            "pending",
          );
          expect(Date.now() - started).toBeLessThan(1_500);
        } finally {
          await o.boat.close();
        }
      }),
    15_000,
  );

  it("releases the consumer pin of a launch whose native build failed, once the run is over (harness: snapshot save fails)", () =>
    test(async (s) => {
      // The launch pinned its publication, the build failed (no allocation was ever made), and
      // the run ended. Nothing else holds the pin.
      const runId = s.input.consumer.runId;
      await execute(
        s.runtimes.upsertRuntimeInstance({
          runId,
          adapter: "boat",
          status: "pending",
          sourceKind: "capture",
          publication: s.input.publication,
          imageScope: s.input.scope,
        }),
      );
      await execute(holdBoatLaunch(s.db, runId));
      const { owner } = await execute(s.final([]));
      // While the launch is in flight its pin is its own.
      await execute(owner.reconcile({ limit: 20 }));
      expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("pending");
      await execute(
        s.runtimes.upsertRuntimeInstance({
          runId,
          status: "failed",
          releaseLaunch: true,
          errorCode: "mechanism-failed",
          errorMessage: "native build failed at install-recipe",
        }),
      );
      await execute(owner.reconcile({ limit: 20 }));
      expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("released");
      // Idempotent, and the owner's discard (a stopped run) settles the same way.
      await execute(s.runtimes.markStopped({ runId, stopReason: "user" }));
      await execute(owner.reconcile({ limit: 20 }));
      expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("released");
    }));

  it("releases the pins of launches whose publication build failed, after the owner's discard (harness: publication-build-attempts-exhausted)", () =>
    test(async (s) => {
      if (s.input.scope.kind !== "owner") throw new Error("expected owner scope");
      const ownerUserId = s.input.scope.ownerUserId;
      // An environment that has never been published, so each launch reserves its build.
      const key = nativePublicationKeySchema.parse({
        deploymentId: "test",
        scope: { kind: "owner", ownerUserId },
        recipeHash: "9".repeat(64),
        assetsHash: "f".repeat(64),
        platform: "linux/amd64",
        runtime: {
          source: `ghcr.io/sealant-sh/sealantd-next:test@sha256:${"a".repeat(64)}`,
          platform: "linux/amd64",
          manifest: "a".repeat(64),
          sealantd: "b".repeat(64),
          sealantctl: "c".repeat(64),
        },
      });
      const launch = async () => {
        const runId = randomUUID();
        await execute(s.db.insert(workspaceAttempts).values({ id: runId, ownerUserId }));
        const consumer = boatAllocationInputSchema.shape.consumer.parse({
          runId,
          runtimeInstanceId: runId,
        });
        const reserved = await execute(s.catalog.reserve(key, consumer));
        return { runId, reserved };
      };
      const buildFails = async (publicationId: string) => {
        const claim = await execute(s.catalog.claim(publicationId, "build", 60_000));
        if (claim === undefined) throw new Error("no build claim");
        // Boat's install-recipe command timed out: a retryable cause, quarantined.
        await execute(s.catalog.quarantine(claim, "native-provider-transport_error"));
      };
      // The first build fails; the next launch retries it and fails too; after that every launch
      // pins the exhausted build and fails at once.
      const first = await launch();
      expect(first.reserved.buildAttempt).toBe(1);
      await buildFails(first.reserved.ownership.publicationId);
      const second = await launch();
      expect(second.reserved.buildAttempt).toBe(2);
      await buildFails(second.reserved.ownership.publicationId);
      const third = await launch();
      expect(third.reserved.ownership.publicationId).toBe(second.reserved.ownership.publicationId);
      expect(third.reserved.state).toBe("quarantined");
      const runs = [first, second, third];
      for (const { runId } of runs) {
        await execute(
          s.runtimes.upsertRuntimeInstance({
            runId,
            adapter: "boat",
            status: "failed",
            sourceKind: "capture",
            imageScope: s.input.scope,
            errorCode: "mechanism-failed",
            errorMessage: "Native catalog: publication-build-attempts-exhausted",
          }),
        );
        // The owner discards the failed launch.
        await execute(s.runtimes.markStopped({ runId, stopReason: "user" }));
        expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("pending");
      }
      const { owner } = await execute(s.final([]));
      await execute(owner.reconcile({ limit: 20 }));
      for (const { runId } of runs)
        expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("released");
    }));

  it("leaves the pin of a run with an allocation to the lifecycle that owns that VM", () =>
    test(async (s) => {
      const runId = s.input.consumer.runId;
      // The allocation exists but Boat has not been asked for a VM yet; it is not discharged.
      await execute(s.repo.reserve(reservation(s.input)));
      await execute(s.runtimes.upsertRuntimeInstance({ runId, adapter: "boat", status: "failed" }));
      const { owner } = await execute(s.final([]));
      await execute(owner.reconcile({ limit: 20 }));
      expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("pending");
    }));
});

const HOUR = 60 * 60_000;
const vmsFor = (o: Awaited<ReturnType<typeof observedLaunch>>, key: string) =>
  [...o.boat.vms.values()].filter((vm) => vm.key === key);

/** A second launch whose create Boat accepted but whose reply was lost. */
const lostCreate = async (s: AllocationFixture, o: Awaited<ReturnType<typeof observedLaunch>>) => {
  const allocations = await recordedAllocations(s, o);
  const input = await execute(seed(s.db, s.catalog));
  const reserved = await execute(s.repo.reserve(reservation(input)));
  o.boat.savedSnapshots.set(input.publication.snapshot.identity.name, {
    ...input.publication.snapshot.identity,
    status: "ready",
  });
  // The reply is lost and Boat stays unreachable, so the launch gives up.
  o.boat.loseCreateReply = true;
  o.boat.outageAfterLostCreate = true;
  await expect(execute(allocations.prepare(input))).rejects.toThrow();
  o.boat.loseCreateReply = false;
  o.boat.outageAfterLostCreate = false;
  o.boat.unreachable = false;
  expect(vmsFor(o, reserved.idempotencyKey)).toHaveLength(1);
  return { input, key: reserved.idempotencyKey };
};

/** Core's record of when create was issued, 25 hours ago. */
const agedIssuance = async (s: AllocationFixture, id: string) => {
  const record = await execute(s.repo.get(id));
  if (record === undefined) throw new Error("missing allocation");
  await execute(
    corruptBoatAllocation(s.db, id, {
      ...record,
      issuedAt: new Date(Date.now() - 25 * HOUR).toISOString(),
    }),
  );
};

/** Allocation driven against the recorded-facts Boat fake. */
const recordedAllocations = (s: AllocationFixture, o: Awaited<ReturnType<typeof observedLaunch>>) =>
  execute(
    Effect.gen(function* () {
      return yield* BoatAllocation;
    }).pipe(
      Effect.provide(
        boatAllocationLayerNoDeps.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(BoatAllocationRepo, s.repo),
              Layer.succeed(BoatObserver, o.observer),
              Layer.succeed(BoatAllocationProvider, { deploymentId: "test", api: o.api }),
              Layer.succeed(BoatExecution, s.executor),
            ),
          ),
        ),
      ),
    ),
  );
