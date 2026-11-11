import { createHash, randomUUID } from "node:crypto";
import http from "node:http";

import { ResourceWorktreeKey, ResourceInstanceKey } from "@sealant/api-contracts";
import {
  CredentialCipher,
  credentialCipherLayer,
  type CredentialCipherError,
} from "@sealant/credentials";
import {
  BoatRunRepo,
  BoatRunRepoLive,
  BoatTunnelRepo,
  DatabaseTransactionLive,
  LAUNCH_RETAINED_ERROR_CODE,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  boatTunnelRepoLayer,
  ResourceInstanceRepo,
  ResourceInstanceRepoLive,
  NativePublicationRepo,
  NativePublicationRepoLive,
  SealantDB,
  ConnectedAccountRepoLive,
  WorkspaceRepoLive,
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
  backdateBoatCreate,
  claimBoatDeletionAgo,
  corruptBoatRun,
  holdBoatLaunch,
  lapseCaptureDeletionHold,
  recordRetainedBoatLaunch,
  restoreUnprogressedCaptureDrain,
  seedBoatRun,
  strandBoatLaunch,
} from "@sealant/db/testing/boat-runs";
import {
  boatTunnelLockWaiters,
  corruptBoatTunnel,
  releaseBoatTunnelHolding,
} from "@sealant/db/testing/boat-tunnels";
import { nativeConsumerRows } from "@sealant/db/testing/native-publications";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import { closeJobQueueSingleton, getJobQueueSingleton } from "@sealant/jobs";
import {
  boatRunInputSchema,
  boatRunLaunchPhase,
  boatRunVmPhase,
  nativePublicationKeySchema,
  nativePublicationSchema,
  type BoatExecutionTarget,
  type BoatRun,
  type BoatRunInput,
} from "@sealant/validators";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Redacted,
  ManagedRuntime,
  Result,
  Scope,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { boatProofConfigSchema } from "../../operator/boat-live-check.js";
import { makeBoatProofCore } from "../../operator/boat-proof-core.js";
import {
  boatResourceLinkQueue,
  consumeBoatResourceLinkJobs,
  publishBoatResourceLinkChanged,
} from "../../queue/boat-resource-link-queue.js";
import { BoatTunnelError } from "../../resources/boat-tunnel.js";
import { makeResourceReconciler } from "../../resources/reconciler.js";
import { postgresSpec } from "../../resources/resource.fixture.js";
import { SealantRuntime, TransportError } from "../../sealantd/runtime.js";
import { adoptStrandedLaunchesEffect } from "../../worker/adopt-stranded-launches.js";
import {
  boatVmWorkerLayer,
  boatSealedExecutionLayer,
  boatReadinessWorkerLayer,
  boatConvergenceWorkerLayer,
  verifyBoatBearers,
} from "../../worker/boat-allocation.js";
import { BoatReadiness, boatReadinessLayer } from "../../worker/boat-readiness.js";
import {
  BOAT_RESOURCE_PASS,
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
import { databaseCaptureDrainLedger } from "../../worker/capture-drain-ledger.js";
import { DEFAULT_CAPTURE_DRAIN_SETTINGS, notifyingRetention } from "../../worker/capture-drain.js";
import {
  processWorkspaceStopEffect,
  type WorkspaceStopOutcome,
} from "../../worker/process-workspace-stop.js";
import { reconcileRuntimeExitsEffect } from "../../worker/reconcile-runtime-exits.js";
import { recoverRetainedExecutorsEffect } from "../../worker/recover-retained-executors.js";
import { cases as launchCases } from "../docker-runtime-adapter.golden-fixture.js";
import { LaunchRetainedError } from "../launch-retention.js";
import {
  isRemovalPending,
  isRemovalRefusal,
  selectRuntimeAdapter,
  type RuntimeAdapterLifecycle,
} from "../runtime-adapter.js";
import {
  BOAT_GATEWAY_UNAVAILABLE_MESSAGE,
  BOAT_INSPECT_READ_MS,
  BOAT_INSPECT_STOPPING_READ_MS,
  BoatAdapterError,
  BoatRuntimeAdapter,
  type BoatAdapterServices,
} from "./adapter.js";
import { ProviderFixture, GuestFixture, GatewayFixture } from "./allocation.fixture.js";
import { HttpBoatApi } from "./api.js";
import { BoatOwnership, BoatSecret } from "./config.js";
import {
  BoatControlError,
  BoatControlMaterial,
  boatConnectMaterial,
  boatControlMaterialLayer,
  boatControlMaterialLayerNoDeps,
  boatDrainConnectMaterial,
} from "./control-material.js";
import {
  BOAT_KEPT_REPORT_MS,
  BoatConvergence,
  boatConvergenceLayerNoDeps,
  type BoatConvergenceSweep,
} from "./convergence.js";
import {
  BoatExecution,
  BoatGuestTransportService,
  boatExecutionLayer,
  type BoatLaunchMaterial,
} from "./execution.js";
import { BoatAllocationProvider } from "./provider.js";
import { RecordedBoat } from "./recorded-boat.fixture.js";
import {
  BOAT_REMOVAL_CLAIM_MS,
  BoatRemoval,
  BoatRemovalProvider,
  boatRemovalLayerNoDeps,
} from "./removal.js";
import { BoatTunnelCarrier, type BoatTunnelCarrierInput } from "./tunnel-carrier.js";
import { BoatVm, boatVmLayer, boatVmLayerNoDeps } from "./vm.js";

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
    const consumer = boatRunInputSchema.shape.consumer.parse({
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
    return boatRunInputSchema.parse({
      deploymentId: "test",
      workspaceId: "workspace",
      consumer,
      launchAttemptId: randomUUID(),
      publication,
      scope: key.scope,
      sourceKind: "capture",
    });
  });

/** The capture token every fixture launch carries, as the recovery sweep unseals it. */
const CAPTURE_TOKEN = "local-proof-token";
const cipherLayer = credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") });

/**
 * The worker's shared paths for a Boat run, over the test database and the fixtures: what the
 * worker runs for every runtime (`processWorkspaceStop`, the recovery sweep, the exit reconciler)
 * with the Boat adapter registered, and Boat's own convergence sweep with the shared stop as its
 * nudge. The daemon is scripted, and reached the way the worker's drains reach one: through the
 * drain connect material, which refuses a run with no launched daemon and a VM whose labels are
 * not the run's.
 *
 * Every call moves the adapter's clock past its `inspect` pacing first, so each pass reads Boat
 * as a later tick would.
 */
/**
 * Every line logged at warning level or above, as `LEVEL message`: by the shared paths, by Boat's
 * sweep, and by the adapter's own runtime (the removal, the observer, the discharge).
 */
const logRecorder = () => {
  const logged: string[] = [];
  const recorder = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Error" || logLevel === "Fatal" || logLevel === "Warn")
        logged.push(`${logLevel} ${Array.isArray(message) ? message.join(" ") : String(message)}`);
    }),
  ]);
  return { logged, recorder };
};

const sharedPaths = (input: {
  readonly log: ReturnType<typeof logRecorder>;
  readonly db: DB;
  readonly adapter: BoatRuntimeAdapter;
  readonly runtime: ManagedRuntime.ManagedRuntime<BoatAdapterServices, never>;
  readonly clock: { now: number };
  readonly daemon: ReturnType<typeof fakeCaptureDaemon>;
  readonly removal: BoatRemoval["Service"];
  readonly vm: BoatVm["Service"];
  readonly convergence: BoatConvergence["Service"];
  readonly control: BoatControlMaterial["Service"];
  readonly canonical: WorkspaceCaptureDrainRepo["Service"];
  readonly runtimes: WorkspaceRuntimeInstanceRepo["Service"];
}) =>
  Effect.gen(function* () {
    const { db, adapter, clock, daemon, canonical, runtimes } = input;
    const hooks = {
      /** Runs when the adapter's `stop` has returned and the shared path has recorded nothing yet. */
      afterAdapterStop: async (): Promise<void> => {},
      /**
       * Runs when a shared path has recorded the run stopped: the stop's removal is still
       * recorded as issued, and its capture record does not say `stopped` yet.
       */
      afterStopRecorded: async (): Promise<void> => {},
      /**
       * Runs when a pass has read a removal as issued and is about to settle it from what the
       * runtime says: between its read of the record and its write.
       */
      beforeSettleIssued: async (): Promise<void> => {},
      /**
       * How far the adapter's clock moves before each shared path call: a whole `inspect` period,
       * so each pass reads Boat as a later tick would. `0`: the pass follows the last read of the
       * VM at once, inside its pacing window.
       */
      elapseMs: BOAT_INSPECT_READ_MS,
    };
    // The adapter as the shared paths hold it: every method the Boat adapter's own.
    const lifecycle: RuntimeAdapterLifecycle = {
      id: adapter.id,
      stopRequestBeforeDrain: adapter.stopRequestBeforeDrain,
      reportsMissingAsLost: adapter.reportsMissingAsLost,
      recoverAnswersUnstarted: adapter.recoverAnswersUnstarted,
      supports: (support) => adapter.supports(support),
      stop: async (stopInput) => {
        const stopped = await adapter.stop(stopInput);
        await hooks.afterAdapterStop();
        return stopped;
      },
      inspect: (inspectInput) => adapter.inspect(inspectInput),
      recover: (recoverInput) => adapter.recover(recoverInput),
      locate: (locateInput) => adapter.locate(locateInput),
    };
    const { logged, recorder } = input.log;
    const scripted = Context.get(yield* Layer.build(daemon.layer), SealantRuntime);
    /** The runs whose daemon a drain reached, by connection: none for a VM nothing launched on. */
    const connects: string[] = [];
    const reached = Layer.succeed(SealantRuntime, {
      ...scripted,
      connect: (target) =>
        Effect.gen(function* () {
          if (target.kind === "websocket" && target.prepare !== undefined) {
            const prepare = target.prepare;
            yield* Effect.tryPromise({
              try: prepare,
              catch: (cause) =>
                new TransportError({
                  operation: "open",
                  message: cause instanceof Error ? cause.message : "connect material refused",
                  cause,
                }),
            });
          }
          return yield* scripted.connect(target);
        }),
    });
    const retained: string[] = [];
    const recorded = notifyingRetention(
      databaseCaptureDrainLedger({ db, owner: `paths-${randomUUID()}`, leaseMs: 60_000 }),
      (runId) => retained.push(runId),
    );
    const ledger: typeof recorded = {
      ...recorded,
      reconcileIssuedDeletion: (...settlement) =>
        Effect.promise(() => hooks.beforeSettleIssued()).pipe(
          Effect.andThen(recorded.reconcileIssuedDeletion(...settlement)),
        ),
    };
    const cipher = Context.get(yield* Layer.build(cipherLayer), CredentialCipher);
    const settings = { ...DEFAULT_CAPTURE_DRAIN_SETTINGS, pollIntervalMs: 5 };
    const options = {
      runtimeAdapters: [lifecycle],
      targetOptions: {
        boatConnectMaterial: async (runId: string, sandboxId: string) => {
          connects.push(runId);
          return Effect.runPromise(input.control.drainMaterial(runId, sandboxId));
        },
        boatEndpointOptional: true,
      },
    };
    const layer = Layer.mergeAll(
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        ...runtimes,
        markStopped: (stopped) =>
          runtimes
            .markStopped(stopped)
            .pipe(Effect.tap(() => Effect.promise(() => hooks.afterStopRecorded()))),
      }),
      Layer.mergeAll(
        WorkspaceRepoLive,
        WorkspaceAttemptRepoLive,
        WorkspaceCaptureDrainRepoLive,
        ConnectedAccountRepoLive,
        DatabaseTransactionLive,
      ).pipe(Layer.provide(Layer.succeed(SealantDB, db))),
      reached,
      recorder,
    );
    const tick = Effect.sync(() => {
      clock.now += hooks.elapseMs;
    });
    /** The shared stop alone, as one lifecycle message or one reaper tick runs it. */
    const stopOnly = (
      run: { readonly runId: string },
      stopReason: "user" | "expired" | "failed" = "user",
    ) =>
      tick.pipe(
        Effect.andThen(
          processWorkspaceStopEffect({
            runId: run.runId,
            stopReason,
            ...options,
            captureDrain: { ledger, settings, budgetMs: 250, label: "test stop" },
          }),
        ),
        Effect.provide(layer),
      );
    /** One recovery attempt of the run's retained executor, due now, with its capture token. */
    const recover = (runId: string) =>
      Effect.gen(function* () {
        yield* tick;
        const record = yield* canonical.getByRunId(runId);
        // Every capture launch keeps its sealed token before it starts (the build job does).
        if (record !== undefined && record.captureTokenSealed === null) {
          const sealed = yield* cipher.encrypt(
            JSON.stringify({ SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN }),
          );
          yield* canonical.storeCaptureToken({ runId, sealed: sealed.sealed });
        }
        yield* canonical.requestRecovery(runId);
        const outcomes = yield* recoverRetainedExecutorsEffect({
          ...options,
          runIds: [runId],
          credentialCipher: cipher,
          captureDrain: { ledger, settings, budgetMs: 250 },
        }).pipe(Effect.provide(layer));
        return outcomes.get(runId);
      });
    /**
     * A stop as the worker carries it out: the shared stop, and, when that stop recorded the
     * run's executor retained, the recovery attempt the worker starts at once for it. `stopped`
     * once the VM is gone by either; otherwise what the stop answered.
     */
    const stop = (
      run: { readonly runId: string },
      stopReason: "user" | "expired" | "failed" = "user",
    ): Effect.Effect<WorkspaceStopOutcome, unknown> =>
      Effect.gen(function* () {
        retained.length = 0;
        const outcome = yield* stopOnly(run, stopReason);
        const record = yield* canonical.getByRunId(run.runId);
        if (outcome !== "kept" || record?.retainedAt == null) return outcome;
        const recovered = yield* recover(run.runId);
        return recovered === "released" || recovered === "lost" ? ("stopped" as const) : outcome;
      });
    /** One pass of Boat's convergence sweep, its nudge the stop above. */
    const sweep = (page: { readonly limit: number; readonly after?: string }) =>
      tick.pipe(
        Effect.andThen(
          input.convergence.reconcile({
            ...page,
            stop: ({ runId, stopReason }) => Effect.runPromise(stop({ runId }, stopReason)),
          }),
        ),
        Effect.provide(recorder),
      );
    /** One poll of the exit reconciler: how many exits it recorded. */
    const reconcileExits = () =>
      tick.pipe(
        Effect.andThen(
          reconcileRuntimeExitsEffect({ ...options, captureDrain: { ledger, settings } }),
        ),
        Effect.provide(layer),
      );
    const row = (runId: string) => runtimes.getRuntimeInstanceByRunId(runId);
    const paths = {
      adapter,
      runtime: input.runtime,
      clock,
      daemon,
      hooks,
      logged,
      /** The lines logged as errors: an ordinary stop logs none. */
      errors: () => logged.filter((line) => line.startsWith("Error") || line.startsWith("Fatal")),
      connects,
      removal: input.removal,
      vm: input.vm,
      ledger,
      stop,
      stopOnly,
      recover,
      sweep,
      reconcileExits,
      row,
    };
    // `paths` names the whole set where a test also takes the daemon out of it.
    return { ...paths, paths };
  });
type SharedPaths = Effect.Success<ReturnType<typeof sharedPaths>>;

const test = async (
  run: (s: {
    databaseUrl: string;
    api: HttpBoatApi;
    db: DB;
    input: BoatRunInput;
    allocations: BoatVm["Service"];
    executor: BoatExecution["Service"];
    resourceOwner: BoatResources["Service"];
    readiness: BoatReadiness["Service"];
    canonical: WorkspaceCaptureDrainRepo["Service"];
    /**
     * The worker's shared paths over this run's fixtures, with the Boat adapter: the shared stop,
     * the recovery sweep, the exit reconciler and Boat's convergence sweep, and the daemon they
     * drain. `script`: what that daemon answers.
     */
    final: (
      script: readonly CaptureDaemonScriptEntry[],
      boatApi?: HttpBoatApi,
      deletionWaitMs?: number,
      /** `false`: the paths of a deployment that has no resource gateway. */
      resourceGateway?: boolean,
      /** How long a removal waits for the gateway host lock. Default: it does not wait. */
      freeze?: { readonly waitMs: number; readonly pollMs: number },
    ) => Effect.Effect<SharedPaths>;
    reopenResources: (
      gatewayHostId?: string,
      relay?: string,
    ) => Effect.Effect<BoatResources["Service"], CredentialCipherError>;
    /** What the host asked its (recording) carrier to keep open. */
    carried: BoatTunnelCarrierInput[];
    /** The runs whose carrier the host asked its (recording) carrier to release, in order. */
    releasedCarriers: string[];
    tunnels: BoatTunnelRepo["Service"];
    resources: ResourceInstanceRepo["Service"];
    gateway: GatewayFixture;
    /** Runs when a release of what an absent VM held is about to release its publication pin. */
    pin: { beforeRelease: () => Promise<void> };
    repo: BoatRunRepo["Service"];
    catalog: NativePublicationRepo["Service"];
    runtimes: WorkspaceRuntimeInstanceRepo["Service"];
    provider: ProviderFixture;
    guest: GuestFixture;
  }) => Promise<void>,
  options: {
    /** The run is launched without resources: frozen on its allocation input. */
    readonly resources?: "none";
    /** `false`: the deployment has no resource gateway. */
    readonly resourceGateway?: boolean;
  } = {},
) => {
  if (databaseUrl === undefined) throw new Error("SEALANT_TEST_DATABASE_URL required");
  await withWorkspaceJobTestDatabase(databaseUrl, async (url) => {
    const DBLayer = makeSealantDBLayer(url);
    const Repos = Layer.mergeAll(
      NativePublicationRepoLive,
      BoatRunRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
      boatTunnelRepoLayer,
      WorkspaceCaptureDrainRepoLive,
    ).pipe(Layer.provideMerge(DBLayer));
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* SealantDB;
        const catalog = yield* NativePublicationRepo;
        const repo = yield* BoatRunRepo;
        const runtimes = yield* WorkspaceRuntimeInstanceRepo;
        const tunnels = yield* BoatTunnelRepo;
        const captureRepo = yield* WorkspaceCaptureDrainRepo;
        const seeded = yield* seed(db, catalog);
        const input =
          options.resources === undefined
            ? seeded
            : boatRunInputSchema.parse({ ...seeded, resources: options.resources });
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
        const Root: Layer.Layer<BoatVm, CredentialCipherError> = boatVmWorkerLayer.pipe(
          Layer.provide(Infra),
        );
        yield* Layer.build(Root);
        const Exchange = boatExecutionLayer.pipe(
          Layer.provide(Layer.succeed(BoatGuestTransportService, guest)),
        );
        const gateway = new GatewayFixture();
        const pin = { beforeRelease: async (): Promise<void> => {} };
        const gatewayHostId = randomUUID();
        // Every tunnel is carried: the carrier records what the host asked it to keep open.
        const carried: BoatTunnelCarrierInput[] = [];
        const releasedCarriers: string[] = [];
        const recordingCarrier = Layer.succeed(
          BoatTunnelCarrier,
          BoatTunnelCarrier.of({
            ensure: (carrierInput) => Effect.sync(() => void carried.push(carrierInput)),
            release: (runId) => Effect.sync(() => void releasedCarriers.push(runId)),
            attached: () => Effect.succeed(false),
            settled: () => Effect.void,
          }),
        );
        const hostLayer = (
          hostId: string = gatewayHostId,
          relay = "127.0.0.1",
          resourceGateway = options.resourceGateway !== false,
        ) =>
          Layer.merge(
            recordingCarrier,
            Layer.succeed(BoatResourcesHost, {
              deploymentId: "test",
              ...(resourceGateway
                ? {
                    gateway: {
                      hostId,
                      relay: { host: relay },
                      subnets: {
                        allocate: async () => {
                          gateway.subnetCalls++;
                          await gateway.beforeSubnet();
                          if (gateway.subnetUnavailable)
                            throw new Error("subnet allocator unavailable");
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
                    },
                  }
                : {}),
            }),
          );
        const ResourceLayer = boatResourcesLayer.pipe(Layer.provide(Exchange));
        const ResourceRoot: Layer.Layer<
          BoatVm | BoatResources | BoatReadiness | BoatConvergence,
          CredentialCipherError
        > = Layer.mergeAll(
          boatReadinessWorkerLayer,
          boatConvergenceWorkerLayer,
          boatVmWorkerLayer,
          boatResourcesLayer.pipe(Layer.provide(boatSealedExecutionLayer)),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              Infra,
              hostLayer(),
              Layer.succeed(BoatRemovalProvider, { api: api.value }),
            ),
          ),
        );
        yield* Layer.build(ResourceRoot);
        const Test = Layer.mergeAll(
          boatVmLayer.pipe(Layer.provide(Exchange)),
          ResourceLayer,
          boatReadinessLayer.pipe(Layer.provide(Layer.merge(ResourceLayer, Exchange))),
          Exchange,
          ResourceInstanceRepoLive,
        ).pipe(Layer.provide(Layer.merge(Infra, hostLayer())));
        const context = yield* Layer.build(Test);
        const allocations = Context.get(context, BoatVm);
        const executor = Context.get(context, BoatExecution);
        const resourceOwner = Context.get(context, BoatResources);
        const resources = Context.get(context, ResourceInstanceRepo);
        const readiness = Context.get(context, BoatReadiness);
        const scope = yield* Effect.scope;
        const reopenResources = (hostId: string = gatewayHostId, relay?: string) =>
          Layer.buildWithScope(
            ResourceLayer.pipe(Layer.provide(Layer.merge(Infra, hostLayer(hostId, relay)))),
            scope,
          ).pipe(Effect.map((ctx) => Context.get(ctx, BoatResources)));
        yield* Effect.promise(() =>
          run({
            databaseUrl: url,
            api: api.value,
            db,
            input,
            allocations,
            executor,
            resourceOwner,
            readiness,
            canonical: captureRepo,
            final: (
              script,
              boatApi = api.value,
              deletionWaitMs = 0,
              resourceGateway,
              freeze = { waitMs: 0, pollMs: 10 },
            ) =>
              Effect.gen(function* () {
                const daemon = fakeCaptureDaemon(script);
                const pathsHost = hostLayer(gatewayHostId, "127.0.0.1", resourceGateway);
                const stores = Layer.mergeAll(
                  Layer.succeed(NativePublicationRepo, {
                    ...catalog,
                    release: (consumer, publicationId) =>
                      Effect.promise(() => pin.beforeRelease()).pipe(
                        Effect.andThen(catalog.release(consumer, publicationId)),
                      ),
                  }),
                  Layer.succeed(BoatRunRepo, repo),
                  Layer.succeed(BoatTunnelRepo, tunnels),
                  Layer.succeed(WorkspaceCaptureDrainRepo, captureRepo),
                  Layer.succeed(WorkspaceRuntimeInstanceRepo, runtimes),
                  Layer.succeed(BoatExecution, executor),
                  Layer.succeed(SealantDB, db),
                  pathsHost,
                  Layer.succeed(BoatRemovalProvider, { api: boatApi, deletionWaitMs, freeze }),
                  Layer.succeed(BoatAllocationProvider, { deploymentId: "test", api: boatApi }),
                );
                // The VM owner is built once and shared by the removal and the adapter, as the
                // production assembly shares it.
                const owners = Layer.mergeAll(
                  boatVmLayerNoDeps,
                  boatControlMaterialLayerNoDeps,
                ).pipe(Layer.provideMerge(stores));
                const layer = boatConvergenceLayerNoDeps.pipe(
                  Layer.provideMerge(boatRemovalLayerNoDeps.pipe(Layer.provideMerge(owners))),
                );
                const built = yield* Layer.buildWithScope(layer, scope);
                const removal = Context.get(built, BoatRemoval);
                const vm = Context.get(built, BoatVm);
                const clock = { now: Date.now() };
                const log = logRecorder();
                const runtime = ManagedRuntime.make(
                  Layer.mergeAll(
                    log.recorder,
                    Layer.succeed(BoatVm, vm),
                    Layer.succeed(BoatReadiness, readiness),
                    Layer.succeed(BoatExecution, executor),
                    Layer.succeed(BoatRemoval, removal),
                    Layer.succeed(BoatRunRepo, repo),
                    Layer.succeed(WorkspaceCaptureDrainRepo, captureRepo),
                    Layer.succeed(WorkspaceRuntimeInstanceRepo, runtimes),
                  ),
                );
                yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
                const adapter = new BoatRuntimeAdapter({
                  deploymentId: "test",
                  runtime,
                  now: () => clock.now,
                  ...(resourceGateway === undefined ? {} : { resourceGateway }),
                });
                return yield* sharedPaths({
                  log,
                  db,
                  adapter,
                  runtime,
                  clock,
                  daemon,
                  removal,
                  vm,
                  convergence: Context.get(built, BoatConvergence),
                  control: Context.get(built, BoatControlMaterial),
                  canonical: captureRepo,
                  runtimes,
                });
              }).pipe(Effect.provideService(Scope.Scope, scope), Effect.orDie),
            reopenResources,
            carried,
            releasedCarriers,
            tunnels,
            resources,
            gateway,
            pin,
            repo,
            catalog,
            runtimes,
            provider,
            guest,
          }),
        );
      }).pipe(Effect.provide(Repos), Effect.scoped),
    );
  });
};
const execute = Effect.runPromise;
/** A removal whose caller holds what authorizes deleting a VM a daemon may have run on. */
const AUTHORIZED = { authorized: Effect.succeed(true) };
type AllocationFixture = Parameters<Parameters<typeof test>[0]>[0];
/** How many times the VM's agent was asked to recover. */
const recovers = (s: AllocationFixture) =>
  s.guest.actions.filter((action) => action === "recover").length;
/** The stored row of a run. */
const runOf = async (s: AllocationFixture, runId: string): Promise<BoatRun> => {
  const run = await execute(s.repo.get(runId));
  if (run === undefined) throw new Error("missing run");
  return run;
};
/**
 * A run's row in the words these assertions use, each read from the row: how far its VM is
 * (`phase`), why it is held (`reason`), and what is recorded of its deletion (`removal`: the claim
 * on the first DELETE, Boat's deletion operation, or how Core knows Boat holds no VM).
 */
const vmView = (run: BoatRun) => {
  const removal =
    run.absentBasis === "never-created"
      ? ({ kind: "never-created", completed: true } as const)
      : run.sandboxId === null
        ? undefined
        : run.deletionOperationId !== null && run.deletionCompletedAt !== null
          ? ({
              kind: "operation",
              id: run.deletionOperationId,
              targetId: run.sandboxId,
              completed: true,
            } as const)
          : run.absentAt !== null
            ? ({ kind: "absent", targetId: run.sandboxId, completed: true } as const)
            : run.deletionOperationId !== null
              ? ({
                  kind: "operation",
                  id: run.deletionOperationId,
                  targetId: run.sandboxId,
                  completed: false,
                } as const)
              : run.deletionClaimedAt !== null
                ? ({ kind: "issued", at: run.deletionClaimedAt } as const)
                : undefined;
  return {
    phase: boatRunVmPhase(run),
    sandboxId: run.sandboxId,
    target: run.target,
    resources: run.resources,
    reason: run.heldReason,
    conflictingSandboxes: run.conflictingSandboxes,
    ...(removal === undefined ? {} : { removal }),
  };
};
const vmOf = async (s: AllocationFixture, runId: string) => vmView(await runOf(s, runId));
/** The same for the run's launch: how far it is, and what it was isolated under. */
const launchOf = async (s: AllocationFixture, runId: string) => {
  const run = await runOf(s, runId);
  return { phase: boatRunLaunchPhase(run), target: run.target, isolation: run.isolation };
};
/** What the run's row records of Boat's own word on its VM: seen past creation, and gone. */
const observedOf = async (s: AllocationFixture, runId: string) => {
  const run = await runOf(s, runId);
  return {
    presence: run.absentAt === null ? ("present" as const) : ("absent" as const),
    basis: run.absentBasis,
    createdObservedAt: run.createdSeenAt,
    sandboxId: run.sandboxId,
  };
};
/**
 * What every run's row records of Boat's word on its VM, for the runs it has said anything of:
 * `present` once Boat reported the VM past creation, `absent` once it no longer has it.
 */
const observedAll = async (s: AllocationFixture) =>
  (await execute(s.db.select().from(schema.boatRuns))).flatMap((row) =>
    row.absentAt !== null ? ["absent"] : row.createdSeenAt !== null ? ["present"] : [],
  );
/** As straight after create: nothing on record says Boat ever reported the VM past creation. */
const forgetCreationSeen = (s: AllocationFixture) =>
  s.db.update(schema.boatRuns).set({ createdSeenAt: null });
/** A column value the table's checks let through and the repository's parser refuses. */
const MALFORMED = { conflictingSandboxes: ["not-a-sandbox"] };
/** The receipts a launch with a tunnel is isolated under, where a test freezes them itself. */
const ISOLATION = { resourceReceipt: "e".repeat(64), tunnelReceipt: "f".repeat(64) };
/** How far the run's VM is, as its row says (`boatRunVmPhase`). */
const vmPhase = async (s: AllocationFixture, runId: string) => {
  const run = await execute(s.repo.get(runId));
  return run === undefined ? undefined : boatRunVmPhase(run);
};
/** How far the run's launch is, as its row says (`boatRunLaunchPhase`). */
const launchPhase = async (s: AllocationFixture, runId: string) => {
  const run = await execute(s.repo.get(runId));
  return run === undefined ? undefined : boatRunLaunchPhase(run);
};
/** What a stop that must not resolve rejected with. */
const stopFailure = (stop: Promise<unknown>) =>
  stop.then(
    () => {
      throw new Error("stop resolved");
    },
    (error: unknown) => error,
  );
/** Reserves the run's row, as a launch does before it issues create. */
const reserve = (s: AllocationFixture) => execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));

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
/** The agent's health while sealantd is still booting: booted, its control socket not up yet. */
const controlSocketPending = { status: 503, body: { booted: true, controlSocket: false } };
/** How many health observations the agent has answered. */
const healthPolls = (s: AllocationFixture) =>
  s.guest.actions.filter((action) => action === "health").length;
const realPause = () => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
/**
 * Launches on the test clock. A second passes each time the agent has answered a readiness poll
 * and the launch waits for the next one, so a long wait runs at once. Says how long it took.
 */
const launchOnTestClock = (s: AllocationFixture, target: BoatExecutionTarget) =>
  execute(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      const started = yield* Clock.currentTimeMillis;
      const fiber = yield* Effect.forkChild(
        Effect.result(s.readiness.launch(target, Redacted.make(launchMaterial()))),
      );
      let answered = healthPolls(s);
      while (fiber.pollUnsafe() === undefined) {
        yield* realPause();
        if (healthPolls(s) === answered) continue;
        answered = healthPolls(s);
        // The answer reaches the launch, which then sleeps until the next poll.
        yield* realPause();
        yield* TestClock.adjust("1 second");
      }
      const outcome = yield* Fiber.join(fiber);
      return { outcome, elapsedMs: (yield* Clock.currentTimeMillis) - started };
    }).pipe(Effect.provide(TestClock.layer())),
  );
/** Runs a stop to its end, whatever that is, and says how long it took. */
const timed = async <A>(stop: Effect.Effect<A, unknown>) => {
  const started = Date.now();
  const outcome = await execute(Effect.result(stop));
  return { outcome, elapsedMs: Date.now() - started };
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

const adapterFixture = async (
  s: AllocationFixture,
  options: {
    /** The workspace's stored spec says it is never linked to resources. */
    readonly resources?: "none";
    /** `false`: the deployment has no resource gateway. */
    readonly resourceGateway?: boolean;
    /** How long a removal waits for Boat's deletion operation. Default: it does not wait. */
    readonly deletionWaitMs?: number;
  } = {},
) => {
  const close = await execute(
    s.final([savedStatus()], undefined, options.deletionWaitMs, options.resourceGateway),
  );
  const { runtime, adapter } = close;
  if (s.input.scope.kind !== "owner") throw new Error("expected owned fixture");
  const input = {
    ...launchCases.capture,
    ...(options.resources === undefined
      ? {}
      : {
          blueprint: {
            ...launchCases.capture.blueprint,
            runtime: { ...launchCases.capture.blueprint.runtime, resources: options.resources },
          },
        }),
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
      // What the build job records of a Boat launch's daemon, from its publication.
      daemonImage: input.publication.evidence.runtime.source,
      daemonRecoveryBoot: input.publication.evidence.daemonRecovery === "supported",
    }),
  );
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
        expect(await execute(f.close.stop({ runId: target.runId }))).toBe("stopped");
        expect(await vmOf(s, target.runId)).toMatchObject({
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
        expect(await execute(f.close.stop({ runId: target.runId }))).toBe("stopped");
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
        // The gateway host is mid-mutation for this run: nothing is asked of Boat, the VM is kept.
        expect(await execute(f.close.stop({ runId: target.runId }))).toBe("kept");
        expect(s.gateway.removeCalls).toBe(0);
        expect(s.provider.deleteCalls).toBe(0);
        release.resolve();
        expect(await launching).toBeInstanceOf(LaunchRetainedError);
        expect(await execute(f.close.stop({ runId: target.runId }))).toBe("stopped");
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
          const result = await execute(f.close.sweep({ limit: 20 }));
          expect(result.entries).toContainEqual({ runId: target.runId, outcome: "stopped" });
          expect(s.gateway.removeCalls).toBe(1);
          expect(s.provider.deleteCalls).toBe(absent ? 0 : 1);
          // A VM Boat lost is reported lost; one no launch was pushed to had nothing to save.
          expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
            state: absent ? "gone" : "stopped",
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
          expect(await vmPhase(s, target.runId)).toBe("deleted");
          expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe(
            "released",
          );
          expect(await execute(f.close.stop({ runId: target.runId }))).toBe("stopped");
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
        expect(await vmOf(s, f.input.runId)).toMatchObject({
          phase: "allocated",
          target: null,
          sandboxId: "bx_23456789",
        });
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        expect(await execute(f.close.stop({ runId: f.input.runId }))).toBe("stopped");
        expect(await execute(f.close.stop({ runId: f.input.runId }))).toBe("stopped");
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.guest.starts).toBe(0);
        expect(await vmOf(s, f.input.runId)).toMatchObject({
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
        expect(await execute(f.close.sweep({ limit: 10 }))).toMatchObject({
          entries: [{ runId: f.input.runId, outcome: "stopped" }],
        });
        expect(s.provider.deleteCalls).toBe(0);
        expect(await vmOf(s, f.input.runId)).toMatchObject({ phase: "deleted" });
        expect(await execute(s.canonical.getByRunId(f.input.runId))).toMatchObject({
          state: "gone",
          retainedAt: null,
          captureTokenSealed: null,
          lastStatus: null,
          completionAttestedAt: null,
        });
        expect((await execute(nativeConsumerRows(s.db, f.input.runId)))[0]?.state).toBe("released");
        // Reconstruct the old worker's terminal allocation with its untouched pre-launch drain:
        // the exit reconciler's sweep of ended executors nothing settled reports it gone.
        await execute(restoreUnprogressedCaptureDrain(s.db, f.input.runId, token.sealed));
        // Boat's own sweep has nothing left of the run: it is settled, and not in its page.
        expect(await execute(f.close.sweep({ limit: 10 }))).toEqual({ entries: [] });
        await execute(f.close.reconcileExits());
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
        expect(await vmPhase(s, f.input.runId)).toBe("bound");
        const target = (await runOf(s, f.input.runId)).target;
        if (target === null) throw new Error("missing target");
        expect(await launchPhase(s, f.input.runId)).toBe("exchange");
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        // The first DELETE of a bound VM is claimed only once nothing can start on it.
        await expect(
          execute(s.repo.claimDeletion(f.input.runId, BOAT_REMOVAL_CLAIM_MS)),
        ).rejects.toThrow("binding-conflict");
        // Run 7: operator already deleted the exact VM. Reconcile must settle without DELETE.
        s.provider.sandboxMissing = true;
        expect(await execute(f.close.sweep({ limit: 10 }))).toMatchObject({
          entries: [{ outcome: "stopped" }],
        });
        // A VM Boat no longer has needs no fence: nothing can start on it, and its allocation
        // ends below, which refuses every later launch.
        expect(await launchOf(s, f.input.runId)).toMatchObject({
          phase: "exchange",
          target,
        });
        expect(s.provider.deleteCalls).toBe(0);
        expect(await execute(f.close.stop({ runId: f.input.runId }))).toBe("stopped");
        expect((await execute(nativeConsumerRows(s.db, f.input.runId)))[0]?.state).toBe("released");
        // A run Boat no longer has a VM for is not in the VM sweep's page.
        expect(await execute(s.allocations.reconcile({ limit: 10 }))).toEqual({ entries: [] });
        expect(await execute(s.resourceOwner.reconcile({ limit: 10 }))).toMatchObject({
          entries: [{ outcome: "closed" }],
        });
        s.guest.fail = false;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("allocation-held");
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
      expect(await launchPhase(s, target.runId)).toBe("installed");
      const { paths, daemon } = await execute(s.final([]));
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      s.gateway.allowRemoval = true;
      s.gateway.removalUnavailable = true;
      // Boat removed the VM: the stop is done and the runtime reads stopped; only host cleanup
      // is left, and Boat's convergence sweep retries it.
      expect(await execute(paths.stop(target))).toBe("stopped");
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
        status: "stopped",
        removedAt: expect.any(Date),
      });
      expect(await vmPhase(s, target.runId)).toBe("deleted");
      expect((await execute(s.tunnels.get(target.runId)))?.released).toBeUndefined();
      expect(await execute(s.resourceOwner.reconcile({ limit: 10 }))).toMatchObject({
        entries: [{ outcome: "held" }],
      });
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("pending");
      expect((await execute(paths.sweep({ limit: 10 }))).entries).toEqual([
        { runId: target.runId, outcome: "discharging" },
      ]);
      s.gateway.removalUnavailable = false;
      expect((await execute(paths.sweep({ limit: 10 }))).entries).toEqual([
        { runId: target.runId, outcome: "cleaned" },
      ]);
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
        expect(await launchPhase(s, f.input.runId)).toBe("exchange");
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        expect(await execute(f.close.stop({ runId: f.input.runId }))).toBe("stopped");
        releaseHost();
        expect(await launch).toBeInstanceOf(LaunchRetainedError);
        expect(await launchPhase(s, f.input.runId)).toBe("aborted");
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
      await execute(s.executor.recordIsolation(target, ISOLATION));
      // Models the durable issuance boundary before its network response, using the repository's
      // own statement.
      await execute(s.repo.issueLaunch(target.runId));
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      // The push may have reached the agent: the launch is held, never aborted, and with nothing
      // confirmed saved the VM is kept.
      const paths = await execute(s.final([]));
      expect(await execute(paths.stop(target))).toBe("kept");
      expect(await launchPhase(s, target.runId)).toBe("held");
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
        // Boat accepted the DELETE and has not finished: kept, nothing released.
        expect(await execute(f.close.stop({ runId: f.input.runId }))).toBe("kept");
        expect(await vmOf(s, f.input.runId)).toMatchObject({
          phase: "deleting",
          removal: { kind: "operation", completed: false },
        });
        expect((await execute(nativeConsumerRows(s.db, f.input.runId)))[0]?.state).toBe("pending");
        const restarted = await execute(s.final([]));
        s.provider.deletionUnavailable = true;
        expect(await execute(restarted.stop({ runId: f.input.runId }))).toBe("kept");
        expect(s.provider.deleteCalls).toBe(1);
        s.provider.deletionUnavailable = false;
        s.provider.deletionCompleted = true;
        expect(await execute(restarted.stop({ runId: f.input.runId }))).toBe("stopped");
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
        // The reply was lost: nobody knows whether Boat acted. Kept, and nothing released.
        expect(await execute(f.close.stop({ runId: f.input.runId }))).toBe("kept");
        expect(s.provider.deleteCalls).toBe(1);
        expect(await vmOf(s, f.input.runId)).toMatchObject({
          phase: "deleting",
          removal: { kind: "issued" },
        });
        expect((await execute(nativeConsumerRows(s.db, f.input.runId)))[0]?.state).toBe("pending");
        // Boat carried it out: its own 404 answers, with no second DELETE.
        s.provider.sandboxMissing = true;
        expect(await execute(f.close.sweep({ limit: 10 }))).toMatchObject({
          entries: [{ outcome: "stopped" }],
        });
        expect(s.provider.deleteCalls).toBe(1);
        expect((await execute(nativeConsumerRows(s.db, f.input.runId)))[0]?.state).toBe("released");
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
        // Its run is neither stopping nor failed: the adapter refuses, and asks Boat nothing.
        const active = await stopFailure(f.adapter.stop({ resourceId: "bx_23456789" }));
        expect(active).toMatchObject({ code: "close-held" });
        expect(isRemovalRefusal(active)).toBe(true);
        expect(s.provider.deleteCalls).toBe(0);
        // Reconciliation must also find failed launches whose stop worker has not run.
        await execute(s.runtimes.upsertRuntimeInstance({ runId: f.input.runId, status: "failed" }));
        s.provider.foreign = true;
        // A VM without this run's labels is never taken for ended, never fenced, never deleted.
        expect(await execute(f.close.sweep({ limit: 10 }))).toMatchObject({
          entries: [{ outcome: "draining" }],
        });
        expect(s.provider.deleteCalls).toBe(0);
        expect(await vmOf(s, f.input.runId)).toMatchObject({ phase: "allocated" });
        await expect(
          execute(s.catalog.release(s.input.consumer, s.input.publication.publicationId)),
        ).rejects.toThrow("consumer-conflict");
        s.provider.foreign = false;
        s.provider.bootReadUnavailable = false;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("allocation-held");
        expect(await execute(f.close.stop({ runId: f.input.runId }, "failed"))).toBe("stopped");
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.guest.starts).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }));
  it("retries an unknown unbound DELETE only after a fresh observation of the same owned VM", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        s.provider.bootReadUnavailable = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        s.provider.deleteLost = true;
        expect(await execute(f.close.stop({ runId: f.input.runId }))).toBe("kept");
        expect((await vmOf(s, f.input.runId)).removal?.kind).toBe("issued");
        s.provider.deleteLost = false;
        // Boat answers with a VM that does not carry this run's labels: nothing is sent to it.
        s.provider.foreign = true;
        expect(await execute(f.close.stop({ runId: f.input.runId }))).toBe("draining");
        expect(s.provider.deleteCalls).toBe(1);
        // The exact owned VM again: the DELETE whose reply was lost is asked again.
        s.provider.foreign = false;
        expect(await execute(f.close.stop({ runId: f.input.runId }))).toBe("stopped");
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
        const first = execute(f.close.stop({ runId: f.input.runId }));
        await entered.promise;
        // The sweep finds the stop's DELETE out, its claim live and no operation on record yet,
        // and leaves the run to it: the shared stop is not asked a second time.
        expect(await execute(f.close.sweep({ limit: 10 }))).toMatchObject({
          entries: [{ outcome: "draining" }],
        });
        release.resolve();
        expect(await first).toBe("stopped");
        expect(s.provider.deleteCalls).toBe(1);
      } finally {
        release.resolve();
        await f.runtime.dispose();
      }
    }));
  it("launches for any principal through the durable owners with complete boot facts, then FINAL closes and releases its slot", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      const hooks: string[] = [];
      try {
        // No owner list: whoever may create workspaces is launched on the deployment's Boat account.
        const result = await f.adapter.launch(
          { ...f.input, principalId: "usr_any_creator" },
          {
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
          },
        );
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
        expect(await execute(f.close.stop({ runId: f.input.runId }))).toBe("stopped");
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
  it("refuses a launch without its pins before allocation and leaves unknown boot outcomes in exact custody", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const { admissionPins: _pins, ...unpinned } = f.input;
        await expect(f.adapter.launch(unpinned)).rejects.toThrow("admission-refused");
        expect(s.provider.creates).toHaveLength(0);
        s.guest.fail = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        expect(await f.adapter.locate({ runId: f.input.runId })).toMatchObject({
          resourceId: "bx_23456789",
          reference: f.input.runId,
        });
        expect(s.provider.creates).toHaveLength(1);
        expect(s.provider.deleteCalls).toBe(0);
        // No stop was requested and the row is not failed: nothing removes the VM.
        const refused = await stopFailure(f.adapter.stop({ resourceId: "bx_23456789" }));
        expect(refused).toMatchObject({ code: "close-held" });
        expect(isRemovalRefusal(refused)).toBe(true);
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

/** The secrets a control connection carries; none may surface in an error or a log line. */
const CONTROL_SECRETS = ["a".repeat(64), "test-cookie-local-only", "test-provider-key-local-only"];
/** The API's and the worker's assembly over the real Boat client, against the provider fixture. */
const controlMaterial = async (s: AllocationFixture, deploymentId: string) => {
  const runtime = ManagedRuntime.make(
    boatControlMaterialLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(SealantDB, s.db),
          credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") }).pipe(Layer.orDie),
          Layer.succeed(BoatAllocationProvider, { deploymentId, api: s.api }),
        ),
      ),
    ),
  );
  const control = await runtime.runPromise(BoatControlMaterial);
  /** The typed failure, or `undefined` when connect material came back. */
  const failure = (runId: string, sandboxId: string) =>
    execute(
      control
        .connectMaterial(runId, sandboxId)
        .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined })),
    );
  return { runtime, control, failure };
};
/** A launched, ready Boat run and this deployment's control material for it. */
const controlFixture = async (s: AllocationFixture) => {
  const target = await launched(s);
  await execute(
    s.runtimes.upsertRuntimeInstance({
      runId: target.runId,
      adapter: "boat",
      status: "ready",
      resourceId: target.sandboxId,
    }),
  );
  return { target, ...(await controlMaterial(s, "test")) };
};
const namesNoSecret = (value: unknown) => {
  const text = `${String(value)} ${JSON.stringify(value)} ${value instanceof Error ? value.stack : ""}`;
  for (const known of CONTROL_SECRETS) expect(text).not.toContain(known);
};

describe.runIf(databaseUrl !== undefined)("Boat control material", () => {
  it("opens a running run's control with a fresh hosted cookie from Boat on every connection", () =>
    test(async (s) => {
      const f = await controlFixture(s);
      try {
        expect(await execute(s.repo.isActive(f.target.runId))).toBe(true);
        const expected = {
          url: "wss://fixture-8080.on.boat.dev/sealant/control",
          auth: { bearerToken: "a".repeat(64) },
          headers: {
            Cookie: "_port_auth=test-cookie-local-only",
            Authorization: `Bearer ${"a".repeat(64)}`,
          },
        };
        expect(
          await execute(f.control.connectMaterial(f.target.runId, f.target.sandboxId)),
        ).toEqual(expected);
        // No cache: the next connection asks Boat again.
        expect(
          await execute(f.control.connectMaterial(f.target.runId, f.target.sandboxId)),
        ).toEqual(expected);
        expect(s.provider.hostCalls).toBe(2);
        // The target derivation's hook resolves the same material.
        expect(await boatConnectMaterial(f.control)(f.target.runId, f.target.sandboxId)).toEqual(
          expected,
        );
        await execute(s.runtimes.markStopRequested({ runId: f.target.runId, stopReason: "user" }));
        expect(await f.failure(f.target.runId, f.target.sandboxId)).toMatchObject({
          _tag: "BoatControlError",
          reason: "refused",
        });
        await expect(
          boatConnectMaterial(f.control)(f.target.runId, f.target.sandboxId),
        ).rejects.toThrow("Boat interactive control refused");
        expect(s.provider.hostCalls).toBe(3);
        expect(s.provider.creates).toHaveLength(1);
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("refuses a run whose row names another sandbox or deployment, before asking Boat", () =>
    test(async (s) => {
      const f = await controlFixture(s);
      const other = await controlMaterial(s, "another-deployment");
      try {
        const refused = { _tag: "BoatControlError", reason: "refused" };
        expect(await f.failure(f.target.runId, "bx_3456789a")).toMatchObject(refused);
        expect(await f.failure(randomUUID(), f.target.sandboxId)).toMatchObject(refused);
        // Another deployment's process never opens this deployment's runs.
        expect(await other.failure(f.target.runId, f.target.sandboxId)).toMatchObject(refused);
        // The run's runtime moved to another sandbox: its old one is no longer its control.
        await execute(
          s.runtimes.upsertRuntimeInstance({
            runId: f.target.runId,
            adapter: "boat",
            status: "ready",
            resourceId: "bx_3456789a",
          }),
        );
        expect(await f.failure(f.target.runId, f.target.sandboxId)).toMatchObject(refused);
        expect(s.provider.hostCalls).toBe(0);
      } finally {
        await f.runtime.dispose();
        await other.runtime.dispose();
      }
    }));

  it("refuses a VM whose Boat labels are not the run's, and never asks Boat to host it", () =>
    test(async (s) => {
      const f = await controlFixture(s);
      try {
        s.provider.foreign = true;
        expect(await f.failure(f.target.runId, f.target.sandboxId)).toMatchObject({
          _tag: "BoatControlError",
          reason: "refused",
        });
        expect(s.provider.hostCalls).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("hands out nothing when Stop wins while Boat answers", () =>
    test(async (s) => {
      const f = await controlFixture(s);
      try {
        s.provider.beforeSandboxRead = () =>
          execute(s.runtimes.markStopRequested({ runId: f.target.runId, stopReason: "user" }));
        expect(await f.failure(f.target.runId, f.target.sandboxId)).toMatchObject({
          _tag: "BoatControlError",
          reason: "refused",
        });
        expect(s.provider.hostCalls).toBe(1);
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("surfaces a Boat API failure as typed unavailability that names no secret, in no log", () =>
    test(async (s) => {
      const f = await controlFixture(s);
      const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => {}),
      );
      try {
        s.provider.hostUnavailable = true;
        const error = await f.failure(f.target.runId, f.target.sandboxId);
        expect(error).toBeInstanceOf(BoatControlError);
        expect(error).toMatchObject({ reason: "unavailable" });
        namesNoSecret(error);
        const rejected = await boatConnectMaterial(f.control)(
          f.target.runId,
          f.target.sandboxId,
        ).then(
          () => undefined,
          (cause: unknown) => cause,
        );
        expect(rejected).toBeInstanceOf(Error);
        namesNoSecret(rejected);
        // A refusal names no secret either.
        s.provider.hostUnavailable = false;
        namesNoSecret(await f.failure(f.target.runId, "bx_3456789a"));
        for (const spy of logs) namesNoSecret(spy.mock.calls);
        expect(s.provider.hostCalls).toBe(2);
      } finally {
        for (const spy of logs) spy.mockRestore();
        await f.runtime.dispose();
      }
    }));
});

describe.runIf(databaseUrl !== undefined)(
  "Boat stop on the shared path: FINAL, then DELETE",
  () => {
    it("nudges only runs that are stopping, leaves a live one alone, and resumes after the page cursor", () =>
      test(async (s) => {
        const target = await launched(s);
        const { paths, daemon } = await execute(s.final([savedStatus()]));
        expect((await execute(paths.sweep({ limit: 1 }))).entries).toEqual([
          { runId: target.runId, outcome: "skipped" },
        ]);
        expect(daemon.calls).toEqual([]);
        expect(s.provider.deleteCalls).toBe(0);
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        s.gateway.allowRemoval = true;
        const result = await execute(paths.sweep({ limit: 1 }));
        expect(result).toEqual({
          entries: [{ runId: target.runId, outcome: "stopped" }],
          next: target.runId,
        });
        expect(daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
        expect(await execute(paths.sweep({ limit: 1, after: target.runId }))).toEqual({
          entries: [],
        });
        // Ended and released: the run is settled, so a later pass does not read it at all.
        expect(await execute(paths.sweep({ limit: 1 }))).toEqual({ entries: [] });
        expect(s.provider.deleteCalls).toBe(1);
        for (const limit of [0, -1, 21, 1.5])
          await expect(execute(paths.sweep({ limit }))).rejects.toThrow("invalid-page");
      }));
    it("keeps the VM of a dead daemon whose recovery the agent refuses or cannot answer, without FINAL or deletion, and drains and deletes it once the agent restarts it", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        const { paths, daemon } = await execute(s.final([savedStatus()]));
        // The daemon ended; the VM and its disk did not.
        s.guest.health = () => daemonExited;
        // The typed refusals (another boot, an agent that did not launch this boot, a binding that
        // is not this run's) keep the VM, never read as nothing to save. So does an answer that
        // matches no contract shape.
        const refusals = [
          "recover-new-boot",
          "recover-state-unknown",
          "recover-binding-conflict",
        ] as const;
        for (const [index, state] of refusals.entries()) {
          s.guest.recovery = state;
          expect(await execute(paths.stop(target))).toBe("kept");
          expect(s.guest.actions.filter((action) => action === "recover")).toHaveLength(index + 1);
          expect(daemon.calls).toEqual([]);
          expect(s.provider.deleteCalls).toBe(0);
          expect((await tunnelRecord(s, target)).released).toBeUndefined();
          expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
            retainedAt: expect.any(Date),
            lastRecoveryError: expect.stringContaining(state),
            deletionState: null,
          });
        }
        s.guest.recovery = "running";
        s.guest.malformedRecovery = true;
        expect(await execute(paths.stop(target))).toBe("kept");
        expect(daemon.calls).toEqual([]);
        expect(s.provider.deleteCalls).toBe(0);
        s.guest.malformedRecovery = false;
        // The agent starts sealantd again in recovery mode on the VM's disk: FINAL, then DELETE.
        s.guest.recovery = "restarted";
        expect(await execute(paths.stop(target))).toBe("stopped");
        expect(daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.guest.starts).toBe(1);
        expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
          state: "stopped",
          deletionState: "deleted",
          retainedAt: null,
        });
      }));
    it("drains authenticated FINAL, proves exact provider and host cleanup, then reuses only the released port", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        const { paths, daemon } = await execute(s.final([savedStatus()]));
        const beforeClose = await tunnelRecord(s, target);
        // The slot is released on one thing only: Boat's committed absence of the VM.
        await expect(execute(s.tunnels.releaseAbsent(beforeClose))).rejects.toThrow(
          "operation-held",
        );
        await expect(execute(s.catalog.release(s.input.consumer, target.sourceId))).rejects.toThrow(
          "consumer-conflict",
        );
        expect(await execute(paths.stop(target))).toBe("stopped");
        await execute(s.catalog.release(s.input.consumer, target.sourceId));
        await expect(
          execute(s.catalog.markConsumer(s.input.consumer, target.sourceId, "live")),
        ).rejects.toThrow("consumer-released");
        expect(daemon.flushRequests[0]?.kind).toBe("final");
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.gateway.removeCalls).toBe(1);
        expect((await execute(s.canonical.getByRunId(target.runId)))?.deletionState).toBe(
          "deleted",
        );
        const terminal = await tunnelRecord(s, target);
        expect(terminal).toMatchObject({ released: true, updates: [] });
        // Boat's deletion operation is on the allocation, for a run with a tunnel as for one without.
        expect(terminal.removal).toBeUndefined();
        expect(await vmOf(s, target.runId)).toMatchObject({
          phase: "deleted",
          removal: { kind: "operation", id: s.provider.deletionId, completed: true },
        });
        expect(await launchPhase(s, target.runId)).toBe("held");
        expect(
          (await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId)))?.removedAt,
        ).not.toBeNull();
        expect(await execute(paths.stop(target))).toBe("stopped");
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.gateway.removeCalls).toBe(1);
        await expect(execute(s.resourceOwner.prepare(target))).rejects.toThrow("held");
        const nextId = randomUUID();
        const [attempt] = await execute(s.db.select().from(workspaceAttempts));
        if (attempt === undefined) throw new Error("missing attempt");
        await execute(
          s.db.insert(workspaceAttempts).values({ id: nextId, ownerUserId: attempt.ownerUserId }),
        );
        // Another run, its VM bound and its bearer sealed: what a tunnel is reserved for.
        const nextTarget = await execute(
          seedBoatRun(s.db, { runId: nextId, sandboxId: "bx_3456789a" }),
        );
        await execute(
          corruptBoatRun(s.db, nextId, {
            exchangeId: randomUUID(),
            exchangePublicKey: "p".repeat(100),
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
        const { paths, daemon } = await execute(s.final([savedStatus()]));
        // No stop was requested: the adapter refuses, before anything is asked of Boat.
        const active = await stopFailure(paths.adapter.stop({ resourceId: target.sandboxId }));
        expect(active).toMatchObject({ code: "close-held" });
        expect(isRemovalRefusal(active)).toBe(true);
        expect(s.provider.deleteCalls).toBe(0);
        expect(await execute(paths.stop(target))).toBe("stopped");
        expect(await launchPhase(s, target.runId)).toBe("aborted");
        expect(daemon.calls).toEqual([]);
        expect(s.provider.deleteCalls).toBe(1);
      }));
    it("reconciles publication release after a crash between terminal runtime writes and pin release", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        const paths = await execute(s.final([savedStatus()]));
        expect(await execute(paths.stop(target))).toBe("stopped");
        // Reconstruct the durable boundary immediately before catalog.release.
        await execute(
          s.db.update(schema.nativePublicationConsumers).set({ state: "live", releasedAt: null }),
        );
        expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("live");
        expect((await execute(paths.sweep({ limit: 20 }))).entries).toContainEqual({
          runId: target.runId,
          outcome: "cleaned",
        });
        expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.gateway.removeCalls).toBe(1);
      }));
    it("retains empty but incomplete FINAL and later retries the same held VM without launching again", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        const first = await execute(s.final([captureStatus({ complete: false })]));
        expect(await execute(first.stop(target))).toBe("kept");
        expect(first.daemon.flushRequests.map((request) => request?.kind)).toEqual([
          "final",
          "final",
        ]);
        expect((await tunnelRecord(s, target)).released).toBeUndefined();
        expect(s.provider.deleteCalls).toBe(0);
        expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
        // Nothing was asked of Boat or fenced for the removal: the stop request is the fence.
        expect(await launchPhase(s, target.runId)).toBe("running");
        expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
          stopReason: "user",
          removedAt: null,
        });
        expect((await execute(s.canonical.getByRunId(target.runId)))?.state).toBe("kept");
        const second = await execute(s.final([savedStatus()]));
        expect(await execute(second.stop(target))).toBe("stopped");
        expect(await launchPhase(s, target.runId)).toBe("held");
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
        const freeze = { waitMs: 400, pollMs: 20 };
        const { paths, daemon } = await execute(
          s.final([savedStatus()], undefined, undefined, undefined, freeze),
        );
        try {
          // The work is saved first. The removal then waits its bound for the lock and, with the
          // mutation still outstanding, asks Boat nothing: a refusal, and the stop fails.
          const { outcome, elapsedMs } = await timed(paths.stop(target));
          expect(Result.isFailure(outcome) && String(outcome.failure)).toContain(
            "close-unavailable",
          );
          expect(elapsedMs).toBeGreaterThanOrEqual(freeze.waitMs);
          expect(daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
          expect(s.provider.deleteCalls).toBe(0);
          expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
          // The removal it had issued is given up, so the next pass decides again.
          expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
            state: "stop-failed",
            deletionState: null,
          });
        } finally {
          release.resolve();
          await active;
        }
        expect(await execute(paths.stop(target))).toBe("stopped");
        expect(s.provider.deleteCalls).toBe(1);
      }));
    it("a pending deletion keeps its exact operation and port, then resumes by observation without another DELETE", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        s.provider.deletionCompleted = false;
        const paths = await execute(s.final([savedStatus()]));
        // Boat accepted the deletion and has not finished it: no error, the stop is deferred.
        expect(await execute(paths.stop(target))).toBe("draining");
        expect(paths.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
        expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
          deletionState: "deleting-issued",
          state: "stop-failed",
          detail: expect.stringContaining("accepted the removal and has not finished it"),
        });
        expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
          stopReason: "user",
          removedAt: null,
        });
        // The operation is on the allocation, which is `deleting` from then on; the port is kept.
        const recorded = {
          phase: "deleting",
          removal: {
            kind: "operation",
            id: s.provider.deletionId,
            targetId: target.sandboxId,
            completed: false,
          },
        };
        expect(await vmOf(s, target.runId)).toMatchObject(recorded);
        expect(await tunnelRecord(s, target)).toMatchObject({ closeId: expect.any(String) });
        expect((await tunnelRecord(s, target)).removal).toBeUndefined();
        expect((await tunnelRecord(s, target)).released).toBeUndefined();
        expect(s.gateway.removeCalls).toBe(0);
        // Its operation cannot be read: still deleting as far as anyone knows, and no error.
        s.provider.deletionUnavailable = true;
        expect(await execute(paths.stop(target))).toBe("draining");
        s.provider.deletionUnavailable = false;
        // Boat answering for another operation: not this removal's, with or without a tunnel.
        s.provider.deletionWrongId = true;
        await expect(execute(paths.stop(target))).rejects.toThrow("close-pending");
        s.provider.deletionWrongId = false;
        expect(await vmOf(s, target.runId)).toMatchObject(recorded);
        expect(await execute(paths.stop(target))).toBe("draining");
        // Every pass polled the one operation: no second FINAL, no second DELETE, nothing released.
        expect(paths.daemon.flushRequests).toHaveLength(1);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
        expect(s.gateway.removeCalls).toBe(0);
        s.provider.deletionCompleted = true;
        const restarted = await execute(s.final(["unreachable"]));
        expect(await execute(restarted.stop(target))).toBe("stopped");
        expect(restarted.daemon.calls).toEqual([]);
        expect(s.provider.deleteCalls).toBe(1);
        // The completed operation stays as the allocation's receipt.
        expect(await vmOf(s, target.runId)).toMatchObject({
          phase: "deleted",
          removal: { kind: "operation", id: s.provider.deletionId, completed: true },
        });
        expect(await tunnelRecord(s, target)).toMatchObject({ released: true });
      }));
    it("a lost DELETE response is retried only against the same positively owned sandbox and unchanged evidence", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        s.provider.deleteLost = true;
        const paths = await execute(s.final([savedStatus()]));
        await expect(execute(paths.stop(target))).rejects.toThrow("close-pending");
        // No operation id came back: none is recorded. The allocation carries the claim the DELETE
        // was sent under, given up since its request is over.
        expect((await tunnelRecord(s, target)).removal).toBeUndefined();
        expect(await vmOf(s, target.runId)).toMatchObject({
          phase: "deleting",
          removal: { kind: "issued" },
        });
        expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
        expect((await execute(s.canonical.getByRunId(target.runId)))?.deletionState).toBe(
          "deleting-issued",
        );
        s.provider.deleteLost = false;
        const restarted = await execute(s.final(["unreachable"]));
        expect(await execute(restarted.stop(target))).toBe("stopped");
        expect(s.provider.deleteCalls).toBe(2);
        expect(restarted.daemon.calls).toEqual([]);
      }));
    it("a lost DELETE reply is answered by observing the VM absent (audit S7)", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        s.provider.deleteLost = true;
        const paths = await execute(s.final([savedStatus()]));
        await expect(execute(paths.stop(target))).rejects.toThrow("close-pending");
        // Boat carried the DELETE out; its reply carrying the operation id never arrived.
        s.provider.sandboxMissing = true;
        expect(await execute(paths.stop(target))).toBe("stopped");
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
        expect(await vmPhase(s, target.runId)).toBe("deleted");
        expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
      }));
    it("refuses a foreign deletion target without removing host custody", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        s.provider.deletionForeign = true;
        const paths = await execute(s.final([savedStatus()]));
        await expect(execute(paths.stop(target))).rejects.toThrow("close-pending");
        expect(s.gateway.removeCalls).toBe(0);
        // Another VM's operation is recorded nowhere: the allocation carries only its own claim.
        expect((await tunnelRecord(s, target)).removal).toBeUndefined();
        expect(await vmOf(s, target.runId)).toMatchObject({
          phase: "deleting",
          removal: { kind: "issued" },
        });
        expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
      }));
    it("refuses provider label changes, and an unsaved observation its FINAL does not cover", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        const foreign = await execute(s.final([savedStatus()]));
        // Boat answers with a VM that no longer carries this run's labels: nothing is sent to it.
        s.provider.foreign = true;
        await expect(execute(foreign.stop(target))).rejects.toThrow("close-held");
        expect(s.provider.deleteCalls).toBe(0);
        expect((await execute(s.canonical.getByRunId(target.runId)))?.deletionState).toBeNull();
        s.provider.foreign = false;
        // While this stop's FINAL is in flight, another path hears the executor say its work is
        // not saved. Nothing orders that answer before the FINAL's, so the FINAL does not cover
        // it: nothing is authorized, and the VM is kept.
        const reached = await execute(Deferred.make<void>()),
          open = await execute(Deferred.make<void>());
        const paths = await execute(s.final([{ gated: savedStatus(), reached, open }]));
        const stopping = execute(paths.stop(target));
        await execute(Deferred.await(reached));
        await execute(
          s.canonical.recordStatus({
            runId: target.runId,
            status: { ...captureStatus({ complete: false }) },
            observedAt: new Date(),
          }),
        );
        await execute(Deferred.succeed(open, undefined));
        expect(await stopping).toBe("kept");
        expect(s.provider.deleteCalls).toBe(0);
        expect((await tunnelRecord(s, target)).released).toBeUndefined();
        expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
      }));
    it("host cleanup failure retains the slot after positive VM deletion and resumes without another FINAL or DELETE", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        s.gateway.removalUnavailable = true;
        const paths = await execute(s.final([savedStatus()]));
        // Boat no longer has the VM: the stop is done. Only the host cleanup is left.
        expect(await execute(paths.stop(target))).toBe("stopped");
        expect((await tunnelRecord(s, target)).released).toBeUndefined();
        expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("pending");
        expect((await execute(s.canonical.getByRunId(target.runId)))?.deletionState).toBe(
          "deleted",
        );
        s.gateway.removalUnavailable = false;
        const restarted = await execute(s.final(["unreachable"]));
        expect((await execute(restarted.sweep({ limit: 20 }))).entries).toEqual([
          { runId: target.runId, outcome: "cleaned" },
        ]);
        expect((await tunnelRecord(s, target)).released).toBe(true);
        expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
        expect(restarted.daemon.calls).toEqual([]);
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.gateway.removeCalls).toBe(2);
      }));
    it("concurrent closes cannot drain or delete twice while the first FINAL is in flight", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        const reached = await execute(Deferred.make<void>()),
          open = await execute(Deferred.make<void>());
        const paths = await execute(s.final([{ gated: savedStatus(), reached, open }]));
        const first = execute(paths.stop(target));
        await execute(Deferred.await(reached));
        try {
          // The first stop holds the run's drain: the second neither drains nor removes.
          expect(await execute(paths.stop(target))).toBe("busy");
        } finally {
          await execute(Deferred.succeed(open, undefined));
        }
        expect(await first).toBe("stopped");
        expect(paths.daemon.flushRequests).toHaveLength(1);
        expect(s.provider.deleteCalls).toBe(1);
      }));
  },
);

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
        // The frozen intent names the run's epoch and subnet, and no address for a VM to dial.
        expect(frozen?.network).toEqual({
          operationId: expect.any(String),
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
        expect(await launchPhase(s, target.runId)).toBe("installed");
        for (const key of [s.gateway.requests[0]?.privateKey])
          if (key !== undefined) expect(JSON.stringify(frozen)).not.toContain(Redacted.value(key));
        for (const changed of [{ bootId: randomUUID() }, { diskLineage: "foreign" }])
          await expect(execute(reopened.prepare({ ...target, ...changed }))).rejects.toThrow(
            "binding-conflict",
          );
        const foreignHost = await execute(s.reopenResources(randomUUID()));
        await expect(execute(foreignHost.prepare(target))).rejects.toThrow("binding-conflict");
        expect(s.gateway.requests).toHaveLength(2);
        // Where the worker reaches the gateway is no part of the frozen intent: a worker that
        // reaches it at another address carries the same tunnel, to the same port, from there.
        // (The Docker gateway is labelled with the address it was published on, and refuses one
        // published elsewhere: `boat-tunnel.e2e.ts`.)
        const moved = await execute(s.reopenResources(undefined, "172.17.0.1"));
        await execute(moved.prepare(target));
        expect(await execute(s.tunnels.get(target.runId))).toEqual(frozen);
        expect(s.carried.at(-1)).toMatchObject({
          runId: target.runId,
          gateway: { host: "172.17.0.1", port: frozen?.listenPort },
        });
      }));
    it("keeps reconciling a session whose reservation was made when a VM could dial the gateway", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        await execute(s.executor.stage(target.runId, Redacted.make(launchMaterial())));
        await execute(s.resourceOwner.prepare(target));
        const current = await execute(s.tunnels.get(target.runId));
        if (current?.network === undefined) throw new Error("no frozen intent");
        // As the release before this one froze it on a deployment that set the gateway's public
        // address: the intent records where the VM dialled.
        const dialled = { ...current, network: { ...current.network, endpoint: "10.0.0.41" } };
        await execute(corruptBoatTunnel(s.db, target.runId, dialled));
        expect(await execute(s.tunnels.get(target.runId))).toEqual(dialled);
        // It still parses, still reconciles, and is neither rewritten nor read: the tunnel is
        // carried, and the guest is sent no address.
        const before = s.carried.length;
        expect((await execute(s.resourceOwner.reconcile({ limit: 20 }))).entries).toEqual([
          { runId: target.runId, outcome: "configured" },
        ]);
        expect(await execute(s.tunnels.get(target.runId))).toEqual(dialled);
        expect(s.carried).toHaveLength(before + 1);
        expect(s.guest.networkBodies.at(-1)).not.toContain("10.0.0.41");
        // The rest of the intent is still frozen: another subnet is a conflict, as before.
        await execute(
          corruptBoatTunnel(s.db, target.runId, {
            ...dialled,
            network: { ...dialled.network, subnet: "10.98.0.64/27" },
          }),
        );
        await expect(execute(s.resourceOwner.prepare(target))).rejects.toThrow("binding-conflict");
      }));
    it("carries every tunnel: the guest is sent no address, and the carrier gets the gateway's port on the relay host", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        await execute(s.executor.stage(target.runId, Redacted.make(launchMaterial())));
        expect(s.carried).toHaveLength(0);
        const result = await execute(s.resourceOwner.prepare(target));
        expect(result.guest).toEqual({
          receipt: "e".repeat(64),
          handshake: "unverified",
          admission: "held",
        });
        const body = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(s.guest.networkBodies.at(-1) ?? "{}"));
        expect(body).toMatchObject({ carrier: "websocket" });
        expect(body).not.toHaveProperty("endpoint");
        expect(body).not.toHaveProperty("port");
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
    it("gives no tunnel to an agent that cannot carry one, and opens no carrier for it", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        await execute(s.executor.stage(target.runId, Redacted.make(launchMaterial())));
        // An image from before the carrier: its agent lists no way to carry the tunnel.
        const { carriers: _carriers, ...older } = s.guest.networkStatus;
        s.guest.networkStatus = older;
        const refused = await execute(Effect.flip(s.resourceOwner.prepare(target)));
        expect(refused).toMatchObject({
          code: "unavailable",
          diagnostic: { code: "carrier-unavailable", resourceOperation: "isolate-guest" },
        });
        expect(s.guest.networkBodies).toHaveLength(0);
        expect(s.carried).toHaveLength(0);
      }));
    it("a repeated stop of an early-aborted resource failure stays stopped without resource setup", () =>
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
        // Gateway setup settled normally before guest isolation failed. The stop needs no
        // resource setup or manual settlement to remove this pre-invocation execution's VM.
        expect((await tunnelRecord(s, target)).updates).toEqual([]);
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        await execute(
          s.canonical.storeCaptureToken({ runId: target.runId, sealed: "local-sealed-capture" }),
        );
        s.gateway.allowRemoval = true;
        const { paths, daemon } = await execute(s.final([]));
        expect(await execute(paths.stop(target))).toBe("stopped");
        expect(await execute(paths.stop(target))).toBe("stopped");
        // Settled by the stop: nothing is left for Boat's own sweep.
        expect(await execute(paths.sweep({ limit: 20 }))).toEqual({ entries: [] });
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
            const paths = await execute(s.final([]));
            // Boat no longer has the VM and the session reads stopped; its gateway is not
            // removed yet, so it is not closed.
            expect(await execute(paths.stop(target))).toBe("stopped");
            expect(await core.runtime(session)).toMatchObject({ ready: false, closed: false });
            s.gateway.removalUnavailable = false;
            expect((await execute(paths.sweep({ limit: 20 }))).entries).toEqual([
              { runId: target.runId, outcome: "cleaned" },
            ]);
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
        // pushed (the agent is asked whether it can carry it, then sent the config); readiness
        // reads health, then the tunnel's handshake, after it.
        const launchAt = s.guest.actions.indexOf("launch");
        expect(s.guest.actions[0]).toBe("health");
        const configuredAt = s.guest.actions.indexOf("network");
        expect(configuredAt).toBeLessThan(launchAt);
        expect(s.guest.actions[configuredAt - 1]).toBe("network-status");
        const healthAt = s.guest.actions.indexOf("health", launchAt);
        expect(healthAt).toBeGreaterThan(launchAt);
        expect(s.guest.actions[healthAt + 1]).toBe("network-status");
        expect(s.guest.starts).toBe(1);
        const before = s.guest.actions.length;
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        await expect(execute(s.readiness.observe(target))).rejects.toThrow("held");
        await expect(execute(s.readiness.launch(target, payload))).rejects.toThrow("held");
        expect(s.guest.actions).toHaveLength(before);
      }));
    it("waits out a VM that is not ready for a minute, longer than twenty polls, and launches", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        const before = healthPolls(s);
        let pending = 60;
        s.guest.health = () =>
          s.guest.starts > 0 && pending-- > 0 ? controlSocketPending : undefined;
        const { outcome, elapsedMs } = await launchOnTestClock(s, target);
        expect(outcome).toMatchObject({
          _tag: "Success",
          success: { runtimeId: "rt_fixture", handshake: "verified" },
        });
        expect(healthPolls(s) - before).toBe(61);
        expect(elapsedMs).toBeGreaterThanOrEqual(60_000);
        expect(s.guest.starts).toBe(1);
      }));
    it("reports the last check that did not pass when a VM never becomes ready within the budget", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        const before = healthPolls(s);
        s.guest.health = () => (s.guest.starts > 0 ? controlSocketPending : undefined);
        const { outcome, elapsedMs } = await launchOnTestClock(s, target);
        expect(outcome).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "BoatReadinessError",
            code: "unavailable",
            diagnostic: {
              step: "readiness",
              errorClass: "BoatExecutionError",
              code: "agent-not-ready",
              check: "control-socket",
              agent: { pathClass: "/sealant/health", responseTail: "" },
            },
          },
        });
        // The wait ends 85 s into the launch, before the 120 s budget's own timeout would.
        expect(elapsedMs).toBeGreaterThanOrEqual(85_000);
        expect(elapsedMs).toBeLessThan(120_000);
        expect(healthPolls(s) - before).toBeGreaterThan(60);
        expect(s.guest.starts).toBe(1);
      }));
    it("stops waiting at once when the daemon exits while the VM is not ready yet", () =>
      test(async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        const before = healthPolls(s);
        let pending = 3;
        s.guest.health = () =>
          s.guest.starts === 0
            ? undefined
            : pending-- > 0
              ? controlSocketPending
              : {
                  status: 503,
                  body: {
                    booted: true,
                    controlSocket: false,
                    daemonExit: { code: 1, signal: null },
                  },
                };
        const { outcome, elapsedMs } = await launchOnTestClock(s, target);
        expect(outcome).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "BoatReadinessError",
            code: "unavailable",
            diagnostic: {
              step: "readiness",
              code: "guest-failed",
              guest: { service: "sealantd", exitCode: 1 },
            },
          },
        });
        expect(healthPolls(s) - before).toBe(4);
        expect(elapsedMs).toBeLessThan(10_000);
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
        await reserve(s);
        await execute(corruptBoatRun(s.db, s.input.consumer.runId, MALFORMED));
        const second = await execute(seed(s.db, s.catalog));
        await execute(s.repo.reserve(second, AGENT_MANIFEST_DIGEST));
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
        expect(await launchOf(s, target.runId)).toMatchObject({
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
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
          phase: "issued",
          sandboxId: null,
        });
        // The sweep finds the VM Boat made by its labels and records it. It binds nothing: only a
        // launch does, and this VM's launch is over.
        const swept = await execute(s.allocations.reconcile({ limit: 20 }));
        expect(swept.entries).toEqual([{ runId: s.input.consumer.runId, outcome: "pending" }]);
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
          phase: "allocated",
          sandboxId: "bx_23456789",
          target: null,
        });
        expect(s.provider.creates).toHaveLength(1);
        expect(s.guest.targets).toHaveLength(0);
        expect(s.provider.commands).toEqual([]);
      }));
    it("resolves an issued create with no VM identity by replaying it under the same key (audit S4)", () =>
      test(async (s) => {
        const record = await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
        const issued = await execute(s.repo.issueCreate(record.runId));
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
          "pending",
        );
        expect(s.provider.creates).toHaveLength(1);
        expect(s.provider.creates[0]?.key).toBe(issued.idempotencyKey);
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
          phase: "allocated",
          sandboxId: "bx_23456789",
        });
      }));
    it("admits only one create issuer under a deterministic same-record race", () =>
      test(async (s) => {
        const record = await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
        const results = await Promise.allSettled([
          execute(s.repo.issueCreate(record.runId)),
          execute(s.repo.issueCreate(record.runId)),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        await execute(s.allocations.reconcile({ limit: 20 }));
        // The one issuer's key is the only one Boat ever sees.
        expect(s.provider.creates.map((create) => create.key)).toEqual([record.idempotencyKey]);
      }));
    it("refuses changed source, scope, launch identity and publication before provider effects", () =>
      test(async (s) => {
        await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
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
        const record = await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
        expect(await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST))).toEqual(record);
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
        await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
        await execute(
          s.runtimes.markStopRequested({ runId: s.input.consumer.runId, stopReason: "user" }),
        );
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("allocation-held");
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
          phase: "held",
          reason: "run-stopped",
        });
        expect(s.provider.creates).toHaveLength(0);
        expect(s.provider.reads).toHaveLength(0);
      }));
    it("refuses issuance when the catalog quarantines the source after reservation", () =>
      test(async (s) => {
        await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
        await execute(s.catalog.rejectReady(s.input.publication, "fixture-refusal"));
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow("pin-unavailable");
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
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
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
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
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
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
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
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
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
          phase: "allocated",
          sandboxId: "bx_23456789",
        });
        expect(s.guest.targets).toHaveLength(0);
      }));
    it("leaves a bound VM whose exchange was lost as it is: the sweep reads no boot, binds nothing and exchanges nothing", () =>
      test(async (s) => {
        s.guest.fail = true;
        await expect(execute(s.allocations.prepare(s.input))).rejects.toThrow(
          "transport-unavailable",
        );
        const before = await execute(s.repo.get(s.input.consumer.runId));
        expect(await vmPhase(s, s.input.consumer.runId)).toBe("bound");
        expect(await launchPhase(s, s.input.consumer.runId)).toBe("exchange");
        s.guest.fail = false;
        const exchanges = s.guest.targets.length;
        // A run with a VM on record is not in the sweep's page: only a launch binds or exchanges.
        expect(await execute(s.allocations.reconcile({ limit: 20 }))).toEqual({ entries: [] });
        expect(await execute(s.repo.get(s.input.consumer.runId))).toEqual(before);
        // The launch read the boot once; the sweep asked the VM nothing.
        expect(s.provider.commands).toEqual(["/usr/bin/cat /proc/sys/kernel/random/boot_id"]);
        expect(s.guest.targets).toHaveLength(exchanges);
        expect(s.provider.creates).toHaveLength(1);
      }));
    it("adopts a Boat launch its worker lost as a retained launch, as the shared sweep adopts any runtime's", () =>
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
        ).toEqual([target.runId]);
        // The VM is kept, and its row is what a launch that failed after its VM existed leaves.
        expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
          status: "failed",
          errorCode: LAUNCH_RETAINED_ERROR_CODE,
          resourceId: target.sandboxId,
          stopReason: null,
        });
        expect(s.provider.deleteCalls).toBe(0);
        // The retained-launch stop then takes it: no launch was pushed, so nothing is to save.
        const paths = await execute(s.final([]));
        expect(await execute(paths.stop(target, "failed"))).toBe("stopped");
        expect(s.provider.deleteCalls).toBe(1);
        expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
          status: "stopped",
          stopReason: "failed",
          errorCode: LAUNCH_RETAINED_ERROR_CODE,
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
        await reserve(s);
        await execute(corruptBoatRun(s.db, s.input.consumer.runId, MALFORMED));
        const nextInput = await execute(seed(s.db, s.catalog));
        const next = await execute(s.repo.reserve(nextInput, AGENT_MANIFEST_DIGEST));
        await execute(s.repo.issueCreate(next.runId));
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
        // Its create was issued and nothing is known of it: the sweep replays it under its key.
        await reserve(s);
        await execute(s.repo.issueCreate(s.input.consumer.runId));
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
          expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
            phase: "issued",
          });
        } finally {
          release.resolve();
        }
        s.provider.beforeCreateReply = async () => {};
        expect((await execute(s.allocations.reconcile({ limit: 20 }))).entries[0]?.outcome).toBe(
          "pending",
        );
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
          phase: "allocated",
          sandboxId: "bx_23456789",
        });
        expect(s.provider.creates).toHaveLength(1);
      }));
    it("wraps only after the last cursor page", () =>
      test(async (s) => {
        const record = await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
        await execute(s.repo.issueCreate(record.runId));
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
  // The VM owner over the recorded Boat: the only reader of presence.
  const observer = await recordedVm(s, api.value);
  const reserved = await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
  const issued = await execute(s.repo.issueCreate(reserved.runId));
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
  const allocation = await execute(s.repo.adopt(issued.runId, created.value.id));
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
    expect(await observedOf(s, s.input.consumer.runId)).toMatchObject({
      presence: "present",
      createdObservedAt: expect.any(Date),
    });
  };
  return {
    boat,
    api: api.value,
    observer,
    allocation,
    sandboxId: created.value.id,
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
        // Nothing is recorded of a VM Boat could not read yet: neither seen created, nor gone.
        expect(await observedOf(s, s.input.consumer.runId)).toEqual({
          presence: "present",
          basis: null,
          createdObservedAt: null,
          sandboxId: o.sandboxId,
        });
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
          backdateBoatCreate(s.db, s.input.consumer.runtimeInstanceId, 24 * 60 * 60_000),
        );
        o.boat.unreadableAfterCreate = 10;
        expect(await execute(o.observer.observe(o.allocation))).toMatchObject({
          kind: "unknown",
          reason: "creating",
        });
        const paths = await execute(s.final([], o.api));
        expect(await execute(paths.stop({ runId: s.input.consumer.runId }))).toBe("draining");
        expect(o.boat.requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
        expect(o.boat.vms.has(o.sandboxId)).toBe(true);
        expect(await observedOf(s, s.input.consumer.runtimeInstanceId)).toMatchObject({
          presence: "present",
          createdObservedAt: null,
        });
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

  it("records absence once Boat reported the VM created and then no longer has it; the shared stop then reads the runtime stopped with its launch error kept", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        await o.readUntilCreated();
        o.boat.removeOutOfBand(o.sandboxId);
        expect(await execute(o.observer.observe(o.allocation))).toEqual({
          kind: "absent",
          basis: "not-found",
        });
        // The observer writes the observation and nothing else.
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
        ).toMatchObject({
          status: "failed",
          stopReason: null,
          removedAt: null,
          errorCode: LAUNCH_RETAINED_ERROR_CODE,
        });
        // The shared stop reads the absence through the adapter and records it, as it records a
        // lost executor of any runtime. Boat is asked nothing more.
        const paths = await execute(s.final([], o.api));
        const asked = o.boat.requests.length;
        expect(await execute(paths.stop({ runId: s.input.consumer.runId }, "failed"))).toBe(
          "stopped",
        );
        expect(o.boat.requests).toHaveLength(asked);
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
        ).toMatchObject({
          status: "stopped",
          stopReason: "failed",
          removedAt: expect.any(Date),
          errorCode: LAUNCH_RETAINED_ERROR_CODE,
        });
        expect(await execute(s.canonical.getByRunId(s.input.consumer.runId))).toMatchObject({
          state: "gone",
          retainedAt: null,
        });
        expect((await execute(nativeConsumerRows(s.db, s.input.consumer.runId)))[0]?.state).toBe(
          "released",
        );
        // Absent is terminal: Boat is not asked again and nothing revives the VM.
        const reads = o.boat.requests.length;
        expect(await execute(o.observer.observe(o.allocation))).toMatchObject({ kind: "absent" });
        expect(o.boat.requests).toHaveLength(reads);
        await expect(
          execute(s.repo.seen(s.input.consumer.runId, o.sandboxId, true)),
        ).resolves.toMatchObject({ absentAt: expect.any(Date), absentBasis: "not-found" });
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
          await execute(
            s.repo.recordDeletion(s.input.consumer.runId, {
              id: `bdop_${"a".repeat(32)}`,
              sandboxId: o.sandboxId,
              completed: true,
            }),
          );
        };
        expect(await execute(o.observer.observe(o.allocation))).toEqual({
          kind: "absent",
          basis: "deletion-completed",
        });
        expect(await observedOf(s, s.input.consumer.runtimeInstanceId)).toMatchObject({
          presence: "absent",
        });
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
        expect(await observedOf(s, s.input.consumer.runtimeInstanceId)).toMatchObject({
          presence: "present",
        });
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
        const paths = await execute(s.final([], o.api));
        expect(await execute(paths.stop({ runId: s.input.consumer.runId }))).toBe("draining");
        // Nothing was claimed, fenced or sent on a 404 that says nothing.
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
          phase: "allocated",
        });
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
        ).toMatchObject({
          removedAt: null,
        });
        expect(o.boat.requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
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
      const paths = await execute(s.final([savedStatus()]));
      expect(await execute(paths.stop(target))).toBe("stopped");
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        state: "stopped",
        retainedAt: null,
        captureTokenSealed: null,
        nextRecoveryAt: null,
      });
      expect(await vmPhase(s, target.runId)).toBe("deleted");
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
      // The sealed launch material is erased with the VM.
      const ended = await runOf(s, target.runId);
      expect(ended.admissionOperationId).not.toBeNull();
      expect(ended.sealedLaunch).toBeNull();
      // The deleted VM is no longer driven as if it were current: the sweep does not read it.
      expect(await execute(s.allocations.reconcile({ limit: 10 }))).toEqual({ entries: [] });
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
      const { paths, daemon } = await execute(s.final([]));
      s.gateway.allowRemoval = true;
      // A live session is the exit reconciler's to watch: Boat's own sweep leaves it alone.
      expect(await execute(paths.sweep({ limit: 10 }))).toMatchObject({
        entries: [{ runId: target.runId, outcome: "skipped" }],
      });
      expect(await execute(paths.reconcileExits())).toBe(0);
      // A person deletes the VM in Boat's console; no stop was ever requested.
      s.provider.sandboxMissing = true;
      expect(await execute(paths.sweep({ limit: 10 }))).toMatchObject({
        entries: [{ runId: target.runId, outcome: "skipped" }],
      });
      expect(await execute(paths.reconcileExits())).toBe(1);
      // Recorded as a lost executor of any runtime is: failed, with what the runtime said.
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
        status: "failed",
        errorCode: "runtime-exited",
        errorMessage: expect.stringContaining("is gone"),
        stopReason: null,
        removedAt: expect.any(Date),
      });
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        state: "gone",
        retainedAt: null,
        captureTokenSealed: null,
      });
      expect((await tunnelRecord(s, target)).released).toBe(true);
      expect(await vmPhase(s, target.runId)).toBe("deleted");
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
      expect(s.provider.deleteCalls).toBe(0);
      expect(daemon.calls).toEqual([]);
      // A failed run's desired state is stopped: Boat's sweep asks the shared stop, which finds
      // nothing of the executor left and records the run stopped. Boat is asked nothing.
      expect(await execute(paths.sweep({ limit: 10 }))).toMatchObject({
        entries: [{ runId: target.runId, outcome: "stopped" }],
      });
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
        status: "stopped",
        stopReason: "failed",
        errorCode: "runtime-exited",
        removedAt: expect.any(Date),
      });
      expect((await execute(s.canonical.getByRunId(target.runId)))?.state).toBe("gone");
      expect(s.provider.deleteCalls).toBe(0);
      // Nothing is left for a later pass of either sweep.
      expect(await execute(paths.reconcileExits())).toBe(0);
      expect(await execute(paths.sweep({ limit: 10 }))).toEqual({ entries: [] });
    }));

  it("adopts a launch whose worker died as failed and closes it (audit S3)", () =>
    test(async (s) => {
      const target = await launched(s);
      await execute(strandBoatLaunch(s.db, { runId: target.runId, sandboxId: target.sandboxId }));
      const { paths, daemon } = await execute(s.final([savedStatus()]));
      s.gateway.allowRemoval = true;
      // The shared stranded-launch sweep adopts it as a retained launch: failed, its VM kept.
      await execute(paths.reconcileExits());
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
        status: "failed",
        errorCode: LAUNCH_RETAINED_ERROR_CODE,
        launchOwner: null,
        removedAt: null,
      });
      expect(s.provider.deleteCalls).toBe(0);
      // A failed launch's desired state is stopped: FINAL, then DELETE.
      expect(await execute(paths.sweep({ limit: 10 }))).toMatchObject({
        entries: [{ runId: target.runId, outcome: "stopped" }],
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
      const paths = await execute(s.final([]));
      expect(await execute(paths.reconcileExits())).toBe(1);
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
        const reserved = await execute(s.repo.reserve(input, AGENT_MANIFEST_DIGEST));
        o.boat.savedSnapshots.set(input.publication.snapshot.identity.name, {
          ...input.publication.snapshot.identity,
          status: "ready",
        });
        o.boat.loseCreateReply = true;
        o.boat.outageAfterLostCreate = true;
        await expect(execute(allocations.prepare(input))).rejects.toThrow();
        o.boat.outageAfterLostCreate = false;
        o.boat.unreachable = false;
        expect(await vmOf(s, input.consumer.runId)).toMatchObject({
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
        expect(await vmOf(s, input.consumer.runId)).toMatchObject({
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
        const reserved = await execute(s.repo.reserve(input, AGENT_MANIFEST_DIGEST));
        await execute(s.repo.issueCreate(reserved.runId));
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
        expect(await vmPhase(s, input.consumer.runId)).toBe("issued");
        o.boat.rejectCreate = { status: 402, code: "insufficient_balance" };
        await execute(allocations.reconcile({ limit: 20 }));
        expect(await vmOf(s, input.consumer.runId)).toMatchObject({
          phase: "deleted",
          sandboxId: null,
          removal: { kind: "never-created" },
        });
        const paths = await execute(s.final([], o.api));
        const sweep = await execute(paths.sweep({ limit: 20 }));
        expect(sweep.entries).toContainEqual({ runId: input.consumer.runId, outcome: "cleaned" });
        // There was never a VM to remove: the run reads stopped, with nothing recorded removed.
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(input.consumer.runId)),
        ).toMatchObject({
          status: "stopped",
          stopReason: "failed",
          resourceId: null,
          removedAt: null,
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
        expect(await vmOf(s, input.consumer.runId)).toMatchObject({
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
        const paths = await execute(s.final([], o.api));
        for (let pass = 0; pass < 3; pass += 1) await execute(paths.sweep({ limit: 20 }));
        expect(vmsFor(o, key)).toHaveLength(1);
        expect((await execute(nativeConsumerRows(s.db, input.consumer.runId)))[0]?.state).toBe(
          "pending",
        );
        // Boat lists the VM again: discovery adopts it and the lifecycle closes it.
        o.boat.unlisted = false;
        await execute(allocations.reconcile({ limit: 20 }));
        expect(await vmOf(s, input.consumer.runId)).toMatchObject({
          phase: "allocated",
          reason: null,
        });
        for (let pass = 0; pass < 3; pass += 1) await execute(paths.sweep({ limit: 20 }));
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
        const paths = await execute(s.final([], o.api));
        await execute(paths.sweep({ limit: 20 }));
        expect(await vmPhase(s, input.consumer.runId)).toBe("held");
        expect((await runOf(s, input.consumer.runId)).absentAt).toBeNull();
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
        const paths = await execute(s.final([], o.api));
        expect((await execute(paths.sweep({ limit: 20 }))).entries).toContainEqual({
          runId: input.consumer.runId,
          outcome: "held",
        });
        expect(await execute(s.canonical.getByRunId(input.consumer.runId))).toMatchObject({
          state: "discarded",
        });
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(input.consumer.runId)),
        ).toMatchObject({ status: "stopped", removedAt: null });
        expect(await vmPhase(s, input.consumer.runId)).toBe("held");
      } finally {
        await o.boat.close();
      }
    }));

  it("never creates again after a crash right after recording that Boat holds no VM (review of #495)", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        const input = await execute(seed(s.db, s.catalog));
        const reserved = await execute(s.repo.reserve(input, AGENT_MANIFEST_DIGEST));
        await execute(s.repo.issueCreate(reserved.runId));
        o.boat.savedSnapshots.set(input.publication.snapshot.identity.name, {
          ...input.publication.snapshot.identity,
          status: "ready",
        });
        // The worker dies as soon as the refusal is recorded. Recording that Boat holds no VM
        // and ending the run's VM are one statement: nothing is left between them to redo.
        const interrupted = await recordedVm(s, o.api, {
          ...s.repo,
          recordNeverCreated: (runId) =>
            s.repo.recordNeverCreated(runId).pipe(Effect.andThen(Effect.interrupt)),
        });
        o.boat.rejectCreate = { status: 402, code: "insufficient_balance" };
        await execute(interrupted.reconcile({ limit: 20 })).catch(() => undefined);
        expect(await observedOf(s, input.consumer.runId)).toMatchObject({
          presence: "absent",
          basis: "never-created",
        });
        expect(await vmPhase(s, input.consumer.runId)).toBe("deleted");
        o.boat.rejectCreate = undefined;
        const creates = o.boat.requests.filter((request) => request.startsWith("POST")).length;
        const allocations = await recordedAllocations(s, o);
        await execute(allocations.reconcile({ limit: 20 }));
        expect(await vmOf(s, input.consumer.runId)).toMatchObject({
          phase: "deleted",
          removal: { kind: "never-created" },
        });
        expect(o.boat.requests.filter((request) => request.startsWith("POST"))).toHaveLength(
          creates,
        );
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
      const { paths, daemon } = await execute(s.final(["unreachable"]));
      expect(await execute(paths.stop(target))).toBe("stopped");
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

  it("honors an attested sealed FINAL of a Boat executor whose daemon ended, without asking the guest (audit S8)", () =>
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
      // Its daemon ended after the FINAL Mend sealed; the VM and its disk did not.
      s.guest.health = () => daemonExited;
      const { paths, daemon } = await execute(s.final(["unreachable"]));
      expect(await execute(paths.stop(target))).toBe("stopped");
      expect(daemon.calls).toEqual([]);
      expect(s.guest.actions.includes("recover")).toBe(false);
      expect(s.provider.deleteCalls).toBe(1);
      expect((await execute(s.canonical.getByRunId(target.runId)))?.deletionState).toBe("deleted");
      expect((await execute(nativeConsumerRows(s.db, target.runId)))[0]?.state).toBe("released");
    }));

  it("drains a Boat executor whose daemon is up before an attestation lets it go, as every runtime's: a silent one is kept", () =>
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
      // The agent reports the daemon up, and it does not answer: it may have written since the
      // seal, so only a drain of it lets it go.
      const silent = await execute(s.final(["unreachable"]));
      expect(await execute(silent.stop(target))).toBe("draining");
      expect(s.provider.deleteCalls).toBe(0);
      expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
      const answering = await execute(s.final([savedStatus()]));
      expect(await execute(answering.stop(target))).toBe("stopped");
      expect(answering.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
      expect(s.provider.deleteCalls).toBe(1);
    }));

  it("fences an issued start whose reply never came, keeps its VM, and lets discard remove it (audit S5)", () =>
    test(async (s) => {
      const target = await execute(s.allocations.prepare(s.input));
      await execute(s.executor.stage(target.runtimeInstanceId, Redacted.make(launchMaterial())));
      await execute(s.resourceOwner.prepare(target));
      await execute(s.executor.recordIsolation(target, ISOLATION));
      // Core durably issued start; the guest's reply never came.
      await execute(s.repo.issueLaunch(target.runId));
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      s.gateway.allowRemoval = true;
      const paths = await execute(s.final(["unreachable"]));
      // Work may exist and nothing proves it saved: the VM is kept, never deleted on a guess.
      await execute(paths.stop(target)).catch(() => "kept");
      expect(s.provider.deleteCalls).toBe(0);
      // The start is fenced: Core can never send it again.
      expect(await launchPhase(s, target.runId)).toBe("held");
      await expect(execute(s.executor.launch(target.runtimeInstanceId))).rejects.toThrow(
        "invocation-held",
      );
      await execute(s.canonical.requestDiscard({ runId: target.runId, requestedBy: "usr_owner" }));
      expect(await execute(paths.stop(target))).toBe("stopped");
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
      s.guest.health = () => daemonExited;
      s.provider.deleteLost = true;
      const paths = await execute(s.final(["unreachable"]));
      await expect(execute(paths.stop(target))).rejects.toThrow("close-pending");
      expect(s.provider.deleteCalls).toBe(1);
      s.provider.deleteLost = false;
      // The caller retries its attestation after the lost reply: the same seal, not new evidence.
      const before = (await execute(s.canonical.getByRunId(target.runId)))?.evidenceVersion;
      await execute(s.canonical.attestCompletion(seal));
      expect((await execute(s.canonical.getByRunId(target.runId)))?.evidenceVersion).toBe(before);
      const outcomes = [];
      for (let attempt = 0; attempt < 3; attempt += 1)
        outcomes.push(await execute(paths.stop(target)).catch((error: unknown) => String(error)));
      await execute(s.canonical.requestDiscard({ runId: target.runId, requestedBy: "usr_owner" }));
      const discard = await execute(paths.stop(target)).catch((error: unknown) => String(error));
      expect({ outcomes, discard, deletes: s.provider.deleteCalls }).toEqual({
        outcomes: ["stopped", "stopped", "stopped"],
        discard: "stopped",
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
      s.guest.health = () => daemonExited;
      s.provider.deleteLost = true;
      const paths = await execute(s.final(["unreachable"]));
      await expect(execute(paths.stop(target))).rejects.toThrow("close-pending");
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
      expect(await execute(paths.stop(target))).toBe("stopped");
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
      s.guest.health = () => daemonExited;
      const paths = await execute(s.final(["unreachable"]));
      expect(await execute(paths.stop(target))).toBe("stopped");
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
      expect(await launchPhase(s, target.runId)).toBe("issued");
      expect(s.guest.starts).toBe(1);
      // The launching worker is lost; connectivity returns.
      await execute(strandBoatLaunch(s.db, { runId: target.runId, sandboxId: target.sandboxId }));
      s.gateway.allowRemoval = true;
      const paths = await execute(s.final([savedStatus()]));
      // Adopted as a retained launch. Its push was never confirmed, so its recovery holds the
      // launch and asks the agent, which answers that the daemon it started is running.
      await execute(paths.reconcileExits());
      const second = await execute(paths.sweep({ limit: 20 }));
      expect(second.entries).toContainEqual({ runId: target.runId, outcome: "stopped" });
      expect(await launchPhase(s, target.runId)).toBe("held");
      expect(s.guest.actions.filter((action) => action === "recover")).toHaveLength(1);
      expect(paths.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
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
      const paths = await execute(s.final([]));
      await execute(paths.sweep({ limit: 20 }));
      expect(binds).toBe(1);
      release.resolve();
      const target = await launch;
      expect(target.runId).toBe(s.input.consumer.runId);
      expect(await launchPhase(s, target.runId)).toBe("control");
      // Its create is resolved and its VM bound: nothing is left for the VM sweep, even once the
      // launch's ownership lapses.
      await execute(strandBoatLaunch(s.db, { runId: target.runId, sandboxId: target.sandboxId }));
      expect(await execute(s.allocations.reconcile({ limit: 20 }))).toEqual({ entries: [] });
    }));

  it("continues a launch through a lost create reply by finding the VM Boat accepted (harness: create reply lost)", () =>
    test(async (s) => {
      const o = await observedLaunch(s);
      try {
        const allocations = await recordedAllocations(s, o);
        const input = await execute(seed(s.db, s.catalog));
        const reserved = await execute(s.repo.reserve(input, AGENT_MANIFEST_DIGEST));
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
        expect(await vmOf(s, input.consumer.runId)).toMatchObject({
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
        const paths = await execute(s.final([], o.api, 10_000));
        expect(await execute(paths.stop({ runId: s.input.consumer.runId }))).toBe("stopped");
        expect(o.boat.vms.has(o.sandboxId)).toBe(false);
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
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
        const paths = await execute(s.final([], o.api, 10_000));
        // One sweep stops it and records the removal Boat completed.
        expect((await execute(paths.sweep({ limit: 20 }))).entries).toContainEqual({
          runId: s.input.consumer.runId,
          outcome: "stopped",
        });
        expect(o.boat.vms.has(o.sandboxId)).toBe(false);
        expect(
          await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
        ).toMatchObject({ status: "stopped", removedAt: expect.any(Date) });
        // No launch was ever pushed to it: nothing was to save, and nothing is reported lost.
        expect(await execute(s.canonical.getByRunId(s.input.consumer.runId))).toMatchObject({
          state: "stopped",
          retainedAt: null,
          detail: expect.stringContaining("no launch could be pushed to it"),
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
        expect(await execute(first.stop({ runId: s.input.consumer.runId }))).toBe("kept");
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
          phase: "deleting",
          removal: { kind: "operation", completed: false },
        });
        expect(o.boat.vms.has(o.sandboxId)).toBe(false);
        // The restarted worker: the VM reads 404 and was never seen created, so only Boat's
        // recorded operation can say the removal finished.
        const restarted = await execute(s.final([], o.api, 20_000));
        // A stop alone reads the VM, and a 404 of a VM never seen created says nothing.
        expect(await execute(restarted.stopOnly({ runId: s.input.consumer.runId }))).toBe(
          "draining",
        );
        expect(await vmPhase(s, s.input.consumer.runId)).toBe("deleting");
        // Boat's sweep polls the recorded operation, and the stop then records what it found.
        expect((await execute(restarted.sweep({ limit: 20 }))).entries).toContainEqual({
          runId: s.input.consumer.runId,
          outcome: "stopped",
        });
        expect(
          o.boat.requests.filter((r) => r.startsWith("DELETE /api/v1/sandboxes/")),
        ).toHaveLength(1);
        expect(await vmPhase(s, s.input.consumer.runId)).toBe("deleted");
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
        const paths = await execute(s.final([], o.api, 20_000));
        await execute(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(paths.stop({ runId: s.input.consumer.runId }));
            yield* Effect.promise(() => entered.promise);
            yield* Fiber.interrupt(fiber);
          }),
        );
        expect(await vmOf(s, s.input.consumer.runId)).toMatchObject({
          phase: "deleting",
          removal: { kind: "operation", completed: false },
        });
        release.resolve();
        o.api.getDeletion = read;
        // Boat finishes the deletion while no worker polls it.
        o.boat.finishDeletions();
        expect(o.boat.vms.has(o.sandboxId)).toBe(false);
        const restarted = await execute(s.final([], o.api, 20_000));
        expect((await execute(restarted.sweep({ limit: 20 }))).entries).toContainEqual({
          runId: s.input.consumer.runId,
          outcome: "stopped",
        });
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
          const paths = await execute(s.final([], o.api, 1_100));
          const polls = () =>
            o.boat.requests.filter((r) => r.startsWith("GET /api/v1/deletion-operations/")).length;
          const mine = (sweep: BoatConvergenceSweep) =>
            sweep.entries.find((entry) => entry.runId === s.input.consumer.runId)?.outcome;
          expect(await execute(paths.stop({ runId: s.input.consumer.runId }))).toBe("kept");
          expect(mine(await execute(paths.sweep({ limit: 20 })))).toBe("draining");
          // Boat was asked, and answered blocked each time; the 404 VM never stood in for completion.
          expect(polls()).toBeGreaterThanOrEqual(2);
          expect(
            await execute(s.runtimes.getRuntimeInstanceByRunId(s.input.consumer.runId)),
          ).toMatchObject({ removedAt: null });
          expect((await execute(nativeConsumerRows(s.db, s.input.consumer.runId)))[0]?.state).toBe(
            "pending",
          );
          o.boat.unblockDeletions();
          expect(mine(await execute(paths.sweep({ limit: 20 })))).toBe("stopped");
          expect(
            o.boat.requests.filter((r) => r.startsWith("DELETE /api/v1/sandboxes/")),
          ).toHaveLength(1);
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
          const paths = await execute(s.final([], o.api, 1_000));
          const started = Date.now();
          expect(await execute(paths.stop({ runId: s.input.consumer.runId }))).toBe("kept");
          // Under the read's own 2 s: the wait bounds the removal, not the request in flight.
          expect(Date.now() - started).toBeLessThan(1_900);
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
      const paths = await execute(s.final([]));
      // While the launch is in flight its pin is its own.
      await execute(paths.sweep({ limit: 20 }));
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
      await execute(paths.sweep({ limit: 20 }));
      expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("released");
      // Idempotent, and the owner's discard (a stopped run) settles the same way.
      await execute(s.runtimes.markStopped({ runId, stopReason: "user" }));
      await execute(paths.sweep({ limit: 20 }));
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
        const consumer = boatRunInputSchema.shape.consumer.parse({
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
      const paths = await execute(s.final([]));
      await execute(paths.sweep({ limit: 20 }));
      for (const { runId } of runs)
        expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("released");
    }));

  it("leaves the pin of a run with an allocation to the lifecycle that owns that VM", () =>
    test(async (s) => {
      const runId = s.input.consumer.runId;
      // The allocation exists but Boat has not been asked for a VM yet; it is not discharged.
      await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
      await execute(s.runtimes.upsertRuntimeInstance({ runId, adapter: "boat", status: "failed" }));
      const paths = await execute(s.final([]));
      await execute(paths.sweep({ limit: 20 }));
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
  const reserved = await execute(s.repo.reserve(input, AGENT_MANIFEST_DIGEST));
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

/** Core's record of when create was issued, 25 hours ago by the database's clock. */
const agedIssuance = (s: AllocationFixture, id: string) =>
  execute(backdateBoatCreate(s.db, id, 25 * HOUR));

/** The VM owner over another Boat API (the recorded-facts fake), on the same row. */
const recordedVm = (
  s: AllocationFixture,
  api: HttpBoatApi,
  repo: BoatRunRepo["Service"] = s.repo,
) =>
  execute(
    Effect.gen(function* () {
      return yield* BoatVm;
    }).pipe(
      Effect.provide(
        boatVmLayerNoDeps.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(BoatRunRepo, repo),
              Layer.succeed(BoatAllocationProvider, { deploymentId: "test", api }),
              Layer.succeed(BoatExecution, s.executor),
            ),
          ),
        ),
      ),
    ),
  );
/** The VM owner driven against the recorded-facts Boat fake. */
const recordedAllocations = (s: AllocationFixture, o: Awaited<ReturnType<typeof observedLaunch>>) =>
  recordedVm(s, o.api);

/** A run whose workspace was created never to be linked to resources, launched and then stopped. */
const stopUnlinked = async (s: AllocationFixture) => {
  const target = await launched(s);
  await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
  return target;
};
/**
 * Nothing exists on the gateway host for any run (no container, network, subnet, port row or
 * receipt), no carrier was asked for, and the guest was never told of a network. The gateway
 * fixture dies on a removal it was not told to allow, so a close that reached for it fails too.
 */
const expectNoGateway = async (s: AllocationFixture) => {
  expect(s.gateway.requests).toEqual([]);
  expect(s.gateway.subnetCalls).toBe(0);
  expect(s.gateway.removeCalls).toBe(0);
  expect(s.carried).toEqual([]);
  expect(await execute(s.db.select().from(schema.boatTunnels))).toEqual([]);
  expect(s.guest.networkBodies).toEqual([]);
  expect(
    s.guest.actions.filter((action) => action === "network" || action === "network-status"),
  ).toEqual([]);
};
/**
 * What a stop has released and recorded: nothing, until Boat's own word that the VM is gone.
 * `absent`: that word is committed on the run's row. `launchErased`: the sealed launch material is
 * erased, by the statement that commits it.
 */
const released = async (s: AllocationFixture, runId: string) => {
  const runtime = await execute(s.runtimes.getRuntimeInstanceByRunId(runId));
  const run = await runOf(s, runId);
  return {
    runtime: { status: runtime?.status, removed: (runtime?.removedAt ?? null) !== null },
    pin: (await execute(nativeConsumerRows(s.db, runId)))[0]?.state === "released",
    absent: run.absentAt !== null,
    launchErased: run.sealedLaunch === null,
    captureToken: (await execute(s.canonical.getByRunId(runId)))?.captureTokenSealed === null,
  };
};
/** Boat's absence is committed and what the VM held is not released yet: the pin is still held. */
const ABSENT_NOT_RELEASED = { runtime: { removed: false }, pin: false, absent: true };
const NOTHING_RELEASED = {
  runtime: { removed: false },
  pin: false,
  absent: false,
  launchErased: false,
};
/** With a capture token stored for the run: it is still held too. */
const NOTHING_RELEASED_WITH_TOKEN = { ...NOTHING_RELEASED, captureToken: false };
const EVERYTHING_RELEASED = {
  runtime: { status: "stopped", removed: true },
  pin: true,
  absent: true,
  launchErased: true,
  captureToken: true,
};

describe.runIf(databaseUrl !== undefined)("Boat run without resources", () => {
  const unlinked = { resources: "none" } as const;

  it("launches with nothing on the gateway host and no network in the guest, ready without a handshake, then stops by FINAL, DELETE, poll and discharge", () =>
    test(async (s) => {
      const f = await adapterFixture(s, unlinked);
      const runId = f.input.runId;
      // An agent that reports no tunnel and cannot carry one (an image older than the carrier):
      // readiness never asks it, so it launches the same.
      s.guest.networkStatus = { configured: false, handshake: "unverified", dns: "unavailable" };
      try {
        const result = await f.adapter.launch(f.input, {
          onStarted: async (identity) => {
            await execute(
              s.runtimes.upsertRuntimeInstance({ runId, ...identity, status: "running" }),
            );
          },
          onReady: async (identity) => {
            await execute(
              s.runtimes.upsertRuntimeInstance({ runId, ...identity, status: "ready" }),
            );
          },
        });
        expect(result).toMatchObject({
          adapter: "boat",
          resourceId: "bx_23456789",
          status: "ready",
        });
        await expectNoGateway(s);
        // The agent's launch body is the contract's and names no network.
        expect(s.guest.launchBodies).toHaveLength(1);
        const body: unknown = JSON.parse(s.guest.launchBodies[0] ?? "");
        expect(Object.keys(z.record(z.string(), z.unknown()).parse(body)).toSorted()).toEqual([
          "bootEnv",
          "controlToken",
          "flushTimeoutMs",
          "runId",
          "secretEnvJson",
          "version",
        ]);
        expect(s.guest.launchBodies[0]).not.toMatch(/network|tunnel|wireguard|subnet|gateway/i);
        // The decision was read from the stored spec once and frozen for the run.
        expect((await runOf(s, runId)).resources).toBe("none");
        expect((await runOf(s, runId)).isolation).toEqual({ resources: "none" });
        // Agent health, then the daemon's own health: no handshake or DNS wait.
        expect(s.guest.actions.filter((action) => action !== "health")).toEqual(["launch"]);

        // Stop. FINAL is drained before DELETE is sent, and nothing is released while Boat's
        // deletion operation is still processing.
        await execute(s.runtimes.markStopRequested({ runId, stopReason: "user" }));
        await execute(s.canonical.storeCaptureToken({ runId, sealed: "sealed-token" }));
        const atDelete: unknown[] = [];
        s.provider.beforeDeletion = async () => {
          atDelete.push({
            flushed: f.close.daemon.flushRequests.map((request) => request?.kind),
            ...(await released(s, runId)),
          });
        };
        s.provider.deletionCompleted = false;
        expect(await execute(f.close.stop({ runId }))).toBe("draining");
        expect(atDelete).toHaveLength(1);
        expect(atDelete[0]).toMatchObject({ flushed: ["final"], ...NOTHING_RELEASED_WITH_TOKEN });
        expect(await released(s, runId)).toMatchObject(NOTHING_RELEASED_WITH_TOKEN);
        // Boat's deletion operation id is on the allocation's own removal record.
        expect(await vmOf(s, runId)).toMatchObject({
          phase: "deleting",
          removal: {
            kind: "operation",
            id: s.provider.deletionId,
            targetId: "bx_23456789",
            completed: false,
          },
        });
        expect((await execute(s.canonical.getByRunId(runId)))?.deletionState).toBe(
          "deleting-issued",
        );
        const polled = s.provider.deletionReads;
        s.provider.deletionCompleted = true;
        expect(await execute(f.close.stop({ runId }))).toBe("stopped");
        expect(s.provider.deletionReads).toBeGreaterThan(polled);
        expect(s.provider.deleteCalls).toBe(1);
        expect(f.close.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
        expect(await released(s, runId)).toMatchObject(EVERYTHING_RELEASED);
        expect(await vmOf(s, runId)).toMatchObject({
          phase: "deleted",
          removal: { kind: "operation", id: s.provider.deletionId, completed: true },
        });
        expect(await execute(s.canonical.getByRunId(runId))).toMatchObject({
          deletionState: "deleted",
          state: "stopped",
          retainedAt: null,
        });
        // A repeated stop finds it closed and asks Boat for nothing more.
        expect(await execute(f.close.stop({ runId }))).toBe("stopped");
        expect(s.provider.deleteCalls).toBe(1);
        await expectNoGateway(s);
      } finally {
        await f.runtime.dispose();
      }
    }, unlinked));

  it("recovers the deletion operation after a worker restart between DELETE and completed, polls it, and releases nothing while Boat is still processing", () =>
    test(async (s) => {
      const target = await stopUnlinked(s);
      await execute(s.canonical.storeCaptureToken({ runId: target.runId, sealed: "sealed-token" }));
      s.provider.deletionCompleted = false;
      const first = await execute(s.final([savedStatus()]));
      expect(await execute(first.stop(target))).toBe("draining");
      expect(first.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
      expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED_WITH_TOKEN);
      // The worker restarts: new paths with no memory, and a guest that cannot answer.
      const restarted = await execute(s.final(["unreachable"]));
      // Boat unreachable, then answering for another operation: the recorded id is kept and
      // nothing is released on either.
      s.provider.deletionUnavailable = true;
      expect(await execute(restarted.stop(target))).toBe("draining");
      s.provider.deletionUnavailable = false;
      s.provider.deletionWrongId = true;
      await expect(execute(restarted.stop(target))).rejects.toThrow("close-pending");
      s.provider.deletionWrongId = false;
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleting",
        removal: { kind: "operation", id: s.provider.deletionId, completed: false },
      });
      // Stuck in `processing`: every stop and every sweep polls the same operation.
      const polled = s.provider.deletionReads;
      expect(await execute(restarted.stop(target))).toBe("draining");
      expect((await execute(restarted.sweep({ limit: 20 }))).entries).toEqual([
        { runId: target.runId, outcome: "draining" },
      ]);
      expect(s.provider.deletionReads).toBeGreaterThanOrEqual(polled + 2);
      expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED_WITH_TOKEN);
      expect(s.provider.deleteCalls).toBe(1);
      // Boat completes it: the next pass discharges, with no FINAL and no second DELETE.
      s.provider.deletionCompleted = true;
      expect((await execute(restarted.sweep({ limit: 20 }))).entries).toEqual([
        { runId: target.runId, outcome: "stopped" },
      ]);
      expect(restarted.daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(1);
      expect(await released(s, target.runId)).toMatchObject(EVERYTHING_RELEASED);
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "operation", id: s.provider.deletionId, completed: true },
      });
      await expectNoGateway(s);
    }, unlinked));

  it("answers a lost DELETE reply by observing the VM absent, or by asking again for the same owned VM", () =>
    test(async (s) => {
      const target = await stopUnlinked(s);
      s.provider.deleteLost = true;
      const paths = await execute(s.final([savedStatus()]));
      await expect(execute(paths.stop(target))).rejects.toThrow("close-pending");
      // No operation id came back: the allocation carries only the claim its DELETE was sent
      // under, and the removal stays issued.
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleting",
        removal: { kind: "issued" },
      });
      expect((await execute(s.canonical.getByRunId(target.runId)))?.deletionState).toBe(
        "deleting-issued",
      );
      expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
      // Boat carried the DELETE out; only its reply was lost.
      s.provider.sandboxMissing = true;
      expect(await execute(paths.stop(target))).toBe("stopped");
      expect(s.provider.deleteCalls).toBe(1);
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "absent", completed: true },
      });
      expect(await released(s, target.runId)).toMatchObject({ pin: true, absent: true });
      await expectNoGateway(s);
    }, unlinked));

  it("retries a lost DELETE against the same VM when Boat still has it", () =>
    test(async (s) => {
      const target = await stopUnlinked(s);
      s.provider.deleteLost = true;
      const paths = await execute(s.final([savedStatus()]));
      await expect(execute(paths.stop(target))).rejects.toThrow("close-pending");
      s.provider.deleteLost = false;
      const restarted = await execute(s.final(["unreachable"]));
      expect(await execute(restarted.stop(target))).toBe("stopped");
      expect(restarted.daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(2);
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "operation", id: s.provider.deletionId, completed: true },
      });
    }, unlinked));

  it("closes a launch that failed before its guest was reached without FINAL, deleting the VM and confirming it", () =>
    test(async (s) => {
      const f = await adapterFixture(s, unlinked);
      const runId = f.input.runId;
      // The bind exchange never reaches the guest: nothing ran on the VM.
      s.guest.fail = true;
      try {
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        expect(s.guest.starts).toBe(0);
        expect(await vmOf(s, runId)).toMatchObject({
          phase: "bound",
          resources: "none",
        });
        await execute(s.runtimes.markStopRequested({ runId, stopReason: "user" }));
        s.provider.deletionCompleted = false;
        // Boat accepted the DELETE and has not finished: kept, and nothing released.
        expect(await execute(f.close.stop({ runId: runId }))).toBe("kept");
        expect(await vmOf(s, runId)).toMatchObject({
          phase: "deleting",
          removal: { kind: "operation", id: s.provider.deletionId, completed: false },
        });
        expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).not.toBe("released");
        s.provider.deletionCompleted = true;
        expect(await execute(f.close.stop({ runId: runId }))).toBe("stopped");
        // Removed as a VM nothing ran on: no FINAL, no agent recovery, one DELETE, Boat's own
        // completion.
        expect(f.close.daemon.calls).toEqual([]);
        expect(s.guest.actions.includes("recover")).toBe(false);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await vmOf(s, runId)).toMatchObject({
          phase: "deleted",
          removal: { kind: "operation", completed: true },
        });
        expect(await launchPhase(s, runId)).toBe("aborted");
        expect(await execute(s.runtimes.getRuntimeInstanceByRunId(runId))).toMatchObject({
          status: "stopped",
          removedAt: expect.any(Date),
        });
        expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("released");
        await expectNoGateway(s);
      } finally {
        await f.runtime.dispose();
      }
    }, unlinked));

  it("honors the owner's discard: no guest answers, the VM is deleted and confirmed, then everything is discharged", () =>
    test(async (s) => {
      const target = await stopUnlinked(s);
      await execute(s.canonical.storeCaptureToken({ runId: target.runId, sealed: "sealed-token" }));
      await execute(s.canonical.requestDiscard({ runId: target.runId, requestedBy: "usr_owner" }));
      // The guest cannot answer at all.
      const { paths, daemon } = await execute(s.final(["unreachable"]));
      s.provider.deletionCompleted = false;
      expect(await execute(paths.stop(target))).toBe("draining");
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleting",
        removal: { kind: "operation", id: s.provider.deletionId, completed: false },
      });
      expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED_WITH_TOKEN);
      // Not recorded discarded before Boat has finished.
      expect((await execute(s.canonical.getByRunId(target.runId)))?.state).not.toBe("discarded");
      s.provider.deletionCompleted = true;
      expect(await execute(paths.stop(target))).toBe("stopped");
      expect(daemon.calls).toEqual([]);
      expect(s.guest.actions.includes("recover")).toBe(false);
      expect(s.provider.deleteCalls).toBe(1);
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        state: "discarded",
        retainedAt: null,
      });
      expect(await released(s, target.runId)).toMatchObject(EVERYTHING_RELEASED);
      await expectNoGateway(s);
    }, unlinked));

  it("retains the VM when FINAL is incomplete, and removes nothing", () =>
    test(async (s) => {
      const target = await stopUnlinked(s);
      const first = await execute(s.final([captureStatus({ complete: false })]));
      expect(await execute(first.stop(target))).toBe("kept");
      expect(s.provider.deleteCalls).toBe(0);
      expect(await vmOf(s, target.runId)).toMatchObject({ phase: "bound" });
      expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
      const second = await execute(s.final([savedStatus()]));
      expect(await execute(second.stop(target))).toBe("stopped");
      expect(s.guest.starts).toBe(1);
    }, unlinked));

  it("is left alone by every sweep while ready, never configured, and closed by the sweep once stopped", () =>
    test(async (s) => {
      const target = await launched(s);
      const { paths, daemon } = await execute(s.final([savedStatus()]));
      expect((await execute(paths.sweep({ limit: 20 }))).entries).toEqual([
        { runId: target.runId, outcome: "skipped" },
      ]);
      expect((await execute(s.resourceOwner.reconcile({ limit: 20 }))).entries).toEqual([
        { runId: target.runId, outcome: "no-resources" },
      ]);
      expect(await execute(s.resourceOwner.reach())).toEqual([]);
      // No owner can give it a gateway or a tunnel after the fact.
      await expect(execute(s.resourceOwner.prepare(target))).rejects.toThrow("held");
      await expect(execute(s.executor.tunnel(target))).rejects.toThrow("invocation-held");
      await expect(
        execute(
          s.executor.isolate(target, {
            network: { epoch: 1, operationId: randomUUID(), subnet: "10.98.0.32/27" },
            privateKey: Redacted.make("unused"),
            publicKey: "unused",
            gatewayKey: "unused",
          }),
        ),
      ).rejects.toThrow("invocation-held");
      // A fresh readiness observation: agent health, then the daemon's, and no tunnel receipt.
      expect(await execute(s.readiness.observe(target))).toMatchObject({
        runtimeId: "rt_fixture",
        handshake: "none",
        dns: "none",
      });
      expect(daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(0);
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      expect((await execute(paths.sweep({ limit: 20 }))).entries).toEqual([
        { runId: target.runId, outcome: "stopped" },
      ]);
      expect(daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
      expect(s.provider.deleteCalls).toBe(1);
      expect((await execute(s.resourceOwner.reconcile({ limit: 20 }))).entries).toEqual([
        { runId: target.runId, outcome: "no-resources" },
      ]);
      await expectNoGateway(s);
    }, unlinked));

  it.each([
    ["a run launched without resources", unlinked, stopUnlinked],
    ["a run that has a tunnel", {}, stopLaunched],
  ] as const)(
    "lets %s leave bound for deleting only once its execution is held, and only under the removal's own claim or Boat's deletion operation",
    (_name, options, stopped) =>
      test(async (s) => {
        const target = await stopped(s);
        const claim = () => execute(s.repo.claimDeletion(target.runId, BOAT_REMOVAL_CLAIM_MS));
        const operation = {
          id: s.provider.deletionId,
          sandboxId: target.sandboxId,
          completed: false,
        };
        // Still running: a launch could be adopted, so the VM is not anyone's to remove, whether
        // under a claim or under an operation.
        await expect(claim()).rejects.toThrow("binding-conflict");
        await expect(execute(s.repo.recordDeletion(target.runId, operation))).rejects.toThrow(
          "binding-conflict",
        );
        await execute(s.executor.hold(target));
        // Held alone lets nothing leave `bound`: a recovery holds before its drain (#592).
        expect(await vmPhase(s, target.runId)).toBe("bound");
        // The claim the removal takes right before its DELETE, then the operation Boat answers.
        const claimed = await claim();
        if (claimed === undefined) throw new Error("the first claim was refused");
        expect(vmView(claimed)).toMatchObject({ phase: "deleting", removal: { kind: "issued" } });
        // A live claim is one caller's: a second call gets none.
        expect(await claim()).toBeUndefined();
        const recorded = await execute(s.repo.recordDeletion(target.runId, operation));
        expect(vmView(recorded)).toMatchObject({
          phase: "deleting",
          removal: { kind: "operation", completed: false },
        });
        // An operation never goes back to a claim, another operation is never recorded over it,
        // and completion never reverts.
        expect(await claim()).toBeUndefined();
        await expect(
          execute(
            s.repo.recordDeletion(target.runId, { ...operation, id: `bdop_${"f".repeat(32)}` }),
          ),
        ).rejects.toThrow("target-conflict");
        const completed = { phase: "deleted", removal: { kind: "operation", completed: true } };
        expect(
          vmView(
            await execute(s.repo.recordDeletion(target.runId, { ...operation, completed: true })),
          ),
        ).toMatchObject(completed);
        expect(vmView(await execute(s.repo.recordDeletion(target.runId, operation)))).toMatchObject(
          completed,
        );
      }, options),
  );

  it("leaves a run without the option unchanged: gateway, carrier, handshake, DNS and the close through its tunnel", () =>
    test(async (s) => {
      const target = await launched(s);
      expect((await runOf(s, target.runId)).resources).toBeNull();
      expect(await launchOf(s, target.runId)).toMatchObject({
        isolation: { resourceReceipt: "e".repeat(64), tunnelReceipt: "c".repeat(64) },
      });
      expect(s.gateway.subnetCalls).toBeGreaterThan(0);
      expect(s.gateway.requests.length).toBeGreaterThan(0);
      expect(s.carried.length).toBeGreaterThan(0);
      expect(s.guest.networkBodies.length).toBeGreaterThan(0);
      expect((await tunnelRecord(s, target)).network).toBeDefined();
      expect(await execute(s.readiness.observe(target))).toMatchObject({
        handshake: "verified",
        dns: "udp-and-tcp",
      });
      // Readiness still waits for the tunnel: no handshake, then no DNS, is not ready.
      s.guest.networkStatus = { ...s.guest.networkStatus, handshake: "unverified" };
      await expect(execute(s.executor.readiness(target))).rejects.toThrow(/"check":"handshake"/);
      s.guest.networkStatus = {
        ...s.guest.networkStatus,
        handshake: "verified",
        dns: "unavailable",
      };
      await expect(execute(s.executor.readiness(target))).rejects.toThrow(/"check":"dns"/);
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      s.gateway.allowRemoval = true;
      const { paths, daemon } = await execute(s.final([savedStatus()]));
      expect(await execute(paths.stop(target))).toBe("stopped");
      expect(daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
      expect(s.gateway.removeCalls).toBe(1);
      // Its tunnel slot is released, and its deletion operation is its allocation's receipt.
      expect(await tunnelRecord(s, target)).toMatchObject({ released: true });
      expect((await tunnelRecord(s, target)).removal).toBeUndefined();
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "operation", id: s.provider.deletionId, completed: true },
      });
    }));
});

describe.runIf(databaseUrl !== undefined)("Boat deployment with no resource gateway", () => {
  const unlinked = { resources: "none", resourceGateway: false } as const;

  it("launches a run created without resources, and stops it by FINAL, DELETE and discharge", () =>
    test(async (s) => {
      const f = await adapterFixture(s, unlinked);
      const runId = f.input.runId;
      try {
        expect(f.adapter.supports({ blueprint: f.input.blueprint })).toEqual({ supported: true });
        const result = await f.adapter.launch(f.input);
        expect(result).toMatchObject({
          adapter: "boat",
          resourceId: "bx_23456789",
          status: "ready",
        });
        await expectNoGateway(s);
        expect((await execute(s.resourceOwner.reconcile({ limit: 20 }))).entries).toEqual([
          { runId, outcome: "no-resources" },
        ]);
        expect(await execute(s.resourceOwner.reach())).toEqual([]);
        await execute(s.runtimes.markStopRequested({ runId, stopReason: "user" }));
        expect(await execute(f.close.stop({ runId }))).toBe("stopped");
        expect(f.close.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await vmOf(s, runId)).toMatchObject({
          phase: "deleted",
          removal: { kind: "operation", completed: true },
        });
        expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("released");
        await expectNoGateway(s);
      } finally {
        await f.runtime.dispose();
      }
    }, unlinked));

  it("refuses a Boat workspace that may be linked, with the typed reason, before a VM is created", () =>
    test(
      async (s) => {
        const f = await adapterFixture(s, { resourceGateway: false });
        try {
          const refusal = {
            supported: false,
            reason: "gateway-unavailable",
            message: BOAT_GATEWAY_UNAVAILABLE_MESSAGE,
          };
          expect(f.adapter.supports({ blueprint: f.input.blueprint })).toEqual(refusal);
          // The worker's selection refuses it before its image is built: the code and the words
          // are what the run's failure, the API and the SDK's `ready()` carry.
          expect(() =>
            selectRuntimeAdapter({
              blueprint: f.input.blueprint,
              adapters: [f.adapter],
              defaultAdapterId: "boat",
            }),
          ).toThrow(
            expect.objectContaining({
              code: "gateway-unavailable",
              message: BOAT_GATEWAY_UNAVAILABLE_MESSAGE,
            }),
          );
          // A launch that reached the adapter anyway is refused before allocation.
          await expect(f.adapter.launch(f.input)).rejects.toThrow(
            /admission-refused.*"code":"gateway-unavailable"/,
          );
          expect(s.provider.creates).toHaveLength(0);
          expect(await execute(s.repo.get(f.input.runId))).toBeUndefined();
          // The same workspace created without resources is served.
          expect(
            f.adapter.supports({
              blueprint: {
                ...f.input.blueprint,
                runtime: { ...f.input.blueprint.runtime, resources: "none" },
              },
            }),
          ).toEqual({ supported: true });
        } finally {
          await f.runtime.dispose();
        }
      },
      { resourceGateway: false },
    ));

  it("holds a run that has a tunnel instead of closing it, and closes it once the gateway is back", () =>
    test(async (s) => {
      // Launched while the deployment had its gateway; the gateway settings were then removed.
      const target = await stopLaunched(s);
      const without = await execute(s.final([savedStatus()], undefined, undefined, false));
      // Its work is saved, and then nothing is asked of Boat: this worker cannot remove the
      // run's gateway, so the VM is kept and the stop fails until it can.
      await expect(execute(without.stop(target))).rejects.toThrow("close-held");
      // The pass says why: `close-held` alone names no setting (#592).
      const why = () =>
        without.logged.filter(
          (line) =>
            line.startsWith("Warn") &&
            line.includes(target.runId) &&
            line.includes("this worker has no resource gateway"),
        ).length;
      expect(why()).toBe(1);
      expect((await execute(without.sweep({ limit: 20 }))).entries).toEqual([
        { runId: target.runId, outcome: "unavailable" },
      ]);
      expect(why()).toBe(2);
      expect(without.daemon.flushRequests.every((request) => request?.kind === "final")).toBe(true);
      expect(s.provider.deleteCalls).toBe(0);
      expect((await tunnelRecord(s, target)).released).toBeUndefined();
      expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
      expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
        state: "stop-failed",
        deletionState: null,
      });
      const restored = await execute(s.final([savedStatus()]));
      expect(await execute(restored.stop(target))).toBe("stopped");
      expect(s.provider.deleteCalls).toBe(1);
      expect(s.gateway.removeCalls).toBe(1);
    }));

  it("configures no gateway for a run that has a tunnel, with the typed reason", () =>
    test(
      async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        await execute(s.executor.stage(target.runtimeInstanceId, Redacted.make(launchMaterial())));
        await expect(execute(s.resourceOwner.prepare(target))).rejects.toThrow(
          /unavailable.*"code":"gateway-unavailable"/,
        );
        await expect(
          execute(s.readiness.launch(target, Redacted.make(launchMaterial()))),
        ).rejects.toThrow(/"code":"gateway-unavailable"/);
        expect(s.guest.starts).toBe(0);
        await expectNoGateway(s);
      },
      { resourceGateway: false },
    ));
});

/**
 * `count` runs the deployment ended long ago, each before Boat held a VM for it: the history the
 * sweep pages through. Their ids sort before a random UUID, so a sweep reaches them first.
 */
const endedRuns = async (s: AllocationFixture, count: number) => {
  if (s.input.scope.kind !== "owner") throw new Error("expected owner scope");
  const ownerUserId = s.input.scope.ownerUserId;
  const ids = Array.from(
    { length: count },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  await execute(s.db.insert(workspaceAttempts).values(ids.map((id) => ({ id, ownerUserId }))));
  // Ended with no VM: create was never issued for them.
  await execute(
    s.db.insert(schema.boatRuns).values(
      ids.map((id) => ({
        runId: id,
        deploymentId: s.input.deploymentId,
        publicationId: s.input.publication.publicationId,
        workspaceId: s.input.workspaceId,
        launchAttemptId: s.input.launchAttemptId,
        manifestDigest: AGENT_MANIFEST_DIGEST,
        snapshotName: s.input.publication.snapshot.identity.name,
        idempotencyKey: randomUUID(),
        diskLineage: randomUUID(),
        absentAt: new Date(),
        absentBasis: "never-created" as const,
      })),
    ),
  );
  return ids;
};

describe.runIf(databaseUrl !== undefined)("Boat tunnel carriers at worker start", () => {
  it("reopens a live run's carrier at once, where the sweep reaches it only after every ended run before it", () =>
    test(async (s) => {
      await linkedResource(s);
      const target = await launched(s);
      const tunnel = await tunnelRecord(s, target);
      const ended = await endedRuns(s, 200);
      expect(ended.every((id) => id < target.runId)).toBe(true);
      const gatewayHostId = tunnel.binding.gatewayHostId;

      // The sweep's pace, unchanged: twenty allocations a tick, every ended one closed and its
      // carrier released as before, and the live run's carrier ensured only on the eleventh tick
      // (five and a half minutes at the worker's 30 s period).
      const swept = await execute(s.reopenResources());
      s.carried.length = 0;
      let page = await execute(swept.reconcile({ limit: 20 }));
      let ticks = 1;
      expect(page.entries).toEqual(
        ended.slice(0, 20).map((runId) => ({ runId, outcome: "closed" })),
      );
      expect(s.carried).toEqual([]);
      while (page.next !== undefined && s.carried.length === 0) {
        page = await execute(swept.reconcile({ limit: 20, after: page.next }));
        ticks += 1;
      }
      expect(ticks).toBe(11);
      expect(page.entries).toContainEqual({ runId: target.runId, outcome: "configured" });

      // The worker restarts again. Its start pass reads the live runs alone, ensures the carrier
      // to the run's own gateway port, and configures nothing: the sweep still does that.
      expect(
        await execute(s.repo.listTunnelled({ deploymentId: "test", gatewayHostId, limit: 100 })),
      ).toEqual([target.runId]);
      const restarted = await execute(s.reopenResources());
      s.carried.length = 0;
      const configured = {
        gateway: s.gateway.requests.length,
        guest: s.guest.networkBodies.length,
        subnets: s.gateway.subnetCalls,
      };
      expect(await execute(restarted.reopenCarriers())).toEqual({ runIds: [target.runId] });
      expect(s.carried).toHaveLength(1);
      expect(s.carried[0]).toMatchObject({
        runId: target.runId,
        gateway: { host: "127.0.0.1", port: tunnel.listenPort },
      });
      const connection = Redacted.value(await execute(s.carried[0]?.connection ?? Effect.die("")));
      expect(connection.url).toMatch(/\/sealant\/tunnel$/);
      expect({
        gateway: s.gateway.requests.length,
        guest: s.guest.networkBodies.length,
        subnets: s.gateway.subnetCalls,
      }).toEqual(configured);

      // A stopped run is no longer live: the start pass leaves it to the sweep, which releases it.
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      expect(
        await execute(s.repo.listTunnelled({ deploymentId: "test", gatewayHostId, limit: 100 })),
      ).toEqual([]);
      s.carried.length = 0;
      expect(await execute(restarted.reopenCarriers())).toEqual({ runIds: [] });
      expect(s.carried).toEqual([]);
    }));

  it("pages live runs by the sweep's cursor and reads none on a foreign gateway host", () =>
    test(async (s) => {
      const target = await launched(s);
      const gatewayHostId = (await tunnelRecord(s, target)).binding.gatewayHostId;
      await endedRuns(s, 20);
      expect(
        await execute(s.repo.listTunnelled({ deploymentId: "test", gatewayHostId, limit: 1 })),
      ).toEqual([target.runId]);
      expect(
        await execute(
          s.repo.listTunnelled({
            deploymentId: "test",
            gatewayHostId,
            limit: 1,
            after: target.runId,
          }),
        ),
      ).toEqual([]);
      for (const other of [
        { deploymentId: "other", gatewayHostId },
        { deploymentId: "test", gatewayHostId: randomUUID() },
      ])
        expect(await execute(s.repo.listTunnelled({ ...other, limit: 100 }))).toEqual([]);
      await expect(
        execute(s.repo.listTunnelled({ deploymentId: "test", gatewayHostId, limit: 101 })),
      ).rejects.toThrow("invalid-record");
      // A worker on another gateway host opens no carrier for this one's runs.
      const foreign = await execute(s.reopenResources(randomUUID()));
      s.carried.length = 0;
      expect(await execute(foreign.reopenCarriers())).toEqual({ runIds: [] });
      expect(s.carried).toEqual([]);
    }));

  it("visits no run launched without resources", () =>
    test(
      async (s) => {
        const target = await launched(s);
        await endedRuns(s, 20);
        const restarted = await execute(s.reopenResources());
        expect(await execute(restarted.reopenCarriers())).toEqual({ runIds: [] });
        expect(await vmPhase(s, target.runId)).toBe("bound");
        await expectNoGateway(s);
      },
      { resources: "none" },
    ));

  it("opens no carrier on a deployment with no resource gateway", () =>
    test(
      async (s) => {
        await endedRuns(s, 20);
        expect(await execute(s.resourceOwner.reopenCarriers())).toEqual({ runIds: [] });
        await expectNoGateway(s);
      },
      { resourceGateway: false },
    ));
});

/** How the page of every allocation reports an ended run. */
const closedRun = (runId: string) => ({ runId, outcome: "closed" });
/** What a configuration touches: the gateway host, its subnets, the guest's network, a carrier. */
const touched = (s: AllocationFixture) => ({
  gateway: s.gateway.requests.length,
  guest: s.guest.networkBodies.length,
  subnets: s.gateway.subnetCalls,
  carried: s.carried.length,
});

describe.runIf(databaseUrl !== undefined)("Boat resource links applied at once (#594)", () => {
  /** The worker's resource tick: a page of live runs, then a page of every allocation. */
  const ticker = (owner: BoatResources["Service"]) => {
    const cursor: { all?: string | undefined; live?: string | undefined } = {};
    return {
      cursor,
      tick: async () => {
        const sweep = await execute(
          owner.reconcile({
            limit: 20,
            ...(cursor.all === undefined ? {} : { after: cursor.all }),
            live: {
              limit: BOAT_RESOURCE_PASS.livePage,
              ...(cursor.live === undefined ? {} : { after: cursor.live }),
            },
          }),
        );
        cursor.all = sweep.next;
        cursor.live = sweep.live?.next;
        return sweep;
      },
    };
  };
  /** A launched run linked to a resource, and the link Mend rewrites it to while it runs. */
  const linkedRun = async (s: AllocationFixture) => {
    await linkedResource(s);
    const target = await launched(s);
    const link = await execute(s.resources.linkOfRun(target.runId));
    if (link === undefined) throw new Error("missing link");
    expect(s.gateway.requests.at(-1)?.link).toEqual(link);
    return { target, changed: { ...link, worktreeKey: ResourceWorktreeKey.make("other") } };
  };

  it("applies a changed link on the next tick, not after the sweep has paged through every ended run", () =>
    test(async (s) => {
      const { target, changed } = await linkedRun(s);
      const ended = await endedRuns(s, 200);
      expect(ended.every((id) => id < target.runId)).toBe(true);
      await execute(s.resources.link(changed));
      const worker = ticker(await execute(s.reopenResources()));
      s.releasedCarriers.length = 0;
      let requests = s.gateway.requests.length;

      // The first tick after the change: the live run is configured with the new link, while the
      // page of every allocation is still on the first twenty ended runs.
      const first = await worker.tick();
      expect(first.live).toEqual({ entries: [{ runId: target.runId, outcome: "configured" }] });
      expect(s.gateway.requests).toHaveLength(requests + 1);
      expect(s.gateway.requests.at(-1)?.link).toEqual(changed);
      expect(await execute(s.resourceOwner.reach())).toEqual([changed]);
      // Ended runs keep their pace and their treatment: twenty a tick, reported closed, their
      // carriers released, and nothing of the live run's released.
      expect(first.entries).toEqual(ended.slice(0, 20).map(closedRun));
      expect(first.next).toBe(ended[19]);
      expect(s.releasedCarriers.toSorted()).toEqual(ended.slice(0, 20));

      // Every later tick configures the live run once: also the eleventh, whose page of every
      // allocation holds the run and reports the outcome the live page had.
      let ticks = 1;
      let sweep = first;
      while (worker.cursor.all !== undefined) {
        requests = s.gateway.requests.length;
        sweep = await worker.tick();
        ticks += 1;
        expect(s.gateway.requests).toHaveLength(requests + 1);
        expect(sweep.live?.entries).toEqual([{ runId: target.runId, outcome: "configured" }]);
        if (ticks <= 10)
          expect(sweep.entries).toEqual(ended.slice((ticks - 1) * 20, ticks * 20).map(closedRun));
      }
      expect(ticks).toBe(11);
      expect(sweep.entries).toEqual([{ runId: target.runId, outcome: "configured" }]);
      expect(s.releasedCarriers.toSorted()).toEqual(ended);
    }));

  it("pages live runs by a cursor of their own, and visits none on a foreign gateway host", () =>
    test(async (s) => {
      const { target } = await linkedRun(s);
      await endedRuns(s, 20);
      const requests = s.gateway.requests.length;
      // A full page of live runs hands back a cursor; the page after the last run is empty and
      // starts the next tick from the beginning.
      const full = await execute(s.resourceOwner.reconcile({ limit: 20, live: { limit: 1 } }));
      expect(full.live).toEqual({
        entries: [{ runId: target.runId, outcome: "configured" }],
        next: target.runId,
      });
      const after = await execute(
        s.resourceOwner.reconcile({ limit: 20, live: { limit: 1, after: target.runId } }),
      );
      expect(after.live).toEqual({ entries: [] });
      expect(s.gateway.requests).toHaveLength(requests + 1);
      // Without `live` a call is the page of every allocation alone, as before.
      expect(await execute(s.resourceOwner.reconcile({ limit: 20 }))).not.toHaveProperty("live");
      const foreign = await execute(s.reopenResources(randomUUID()));
      expect((await execute(foreign.reconcile({ limit: 20, live: { limit: 20 } }))).live).toEqual({
        entries: [],
      });
    }));

  it("applies a link when the API's message arrives, without a tick, and a burst of re-links is one application", () =>
    test(async (s) => {
      const { target, changed } = await linkedRun(s);
      await endedRuns(s, 200);
      await execute(s.resources.link(changed));
      const message = { workspaceId: target.workspaceId, runId: target.runId };
      try {
        // The link route's message, five times over: one waits in the queue.
        for (let i = 0; i < 5; i += 1) await publishBoatResourceLinkChanged(s.databaseUrl, message);
        const { boss } = await getJobQueueSingleton(s.databaseUrl);
        const waiting = async () =>
          (await boss.findJobs(boatResourceLinkQueue.name)).filter(
            (job) => job.state === "created",
          );
        expect(await waiting()).toHaveLength(1);
        const before = touched(s);
        s.releasedCarriers.length = 0;
        // The worker's consumer, as `startWorkspaceWorker` registers it. No tick runs here.
        const outcomes: string[] = [];
        const consumer = await consumeBoatResourceLinkJobs({
          databaseUrl: s.databaseUrl,
          concurrency: BOAT_RESOURCE_PASS.linkJobs,
          onMessage: async (delivery) => {
            outcomes.push(await execute(s.resourceOwner.apply(delivery.message.runId)));
          },
        });
        await vi.waitFor(() => expect(outcomes).toHaveLength(1), { timeout: 15_000 });
        await consumer.cancel();
        expect(outcomes).toEqual(["configured"]);
        expect(await waiting()).toEqual([]);
        expect(s.gateway.requests).toHaveLength(before.gateway + 1);
        expect(s.gateway.requests.at(-1)?.link).toEqual(changed);
        expect(await execute(s.resourceOwner.reach())).toEqual([changed]);
        expect(s.releasedCarriers).toEqual([]);
        // Applying it again finds nothing to change and breaks nothing.
        expect(await execute(s.resourceOwner.apply(target.runId))).toBe("configured");
        expect(s.gateway.requests.at(-1)?.link).toEqual(changed);
      } finally {
        await closeJobQueueSingleton();
      }
    }));

  it("configures a run for one caller at a time: a link job waits out the tick's visit, then applies the link it may have missed", () =>
    test(async (s) => {
      const { target, changed } = await linkedRun(s);
      // Twenty ended runs fill the tick's page of every allocation: the live run is not on it.
      await endedRuns(s, 20);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let replies = 0;
      s.gateway.beforeReply = async () => {
        replies += 1;
        if (replies > 1) return;
        entered.resolve();
        await release.promise;
      };
      const requests = s.gateway.requests.length;
      s.releasedCarriers.length = 0;
      const tick = execute(s.resourceOwner.reconcile({ limit: 20, live: { limit: 20 } }));
      await entered.promise;
      // The link changes while the tick's configuration is at the gateway host, and its job runs.
      await execute(s.resources.link(changed));
      const applied = execute(s.resourceOwner.apply(target.runId));
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(s.gateway.requests).toHaveLength(requests + 1);
      } finally {
        release.resolve();
      }
      // The tick's visit read the link before the change: it is stale, and says so.
      expect((await tick).live).toEqual({ entries: [{ runId: target.runId, outcome: "pending" }] });
      expect(await applied).toBe("configured");
      expect(s.gateway.requests).toHaveLength(requests + 2);
      expect(s.gateway.requests.at(-1)?.link).toEqual(changed);
      expect(s.releasedCarriers).not.toContain(target.runId);
    }));

  it("keeps a live session's carrier when its link is written while the tick configures it, and the next tick applies the link", () =>
    test(async (s) => {
      // No ended runs: the run is on the tick's page of live runs and on its page of every
      // allocation, which is where a carrier is released.
      const { target, changed } = await linkedRun(s);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let replies = 0;
      s.gateway.beforeReply = async () => {
        replies += 1;
        if (replies > 1) return;
        entered.resolve();
        await release.promise;
      };
      const worker = ticker(s.resourceOwner);
      s.carried.length = 0;
      s.releasedCarriers.length = 0;
      const requests = s.gateway.requests.length;
      const visiting = worker.tick();
      await entered.promise;
      // Mend links right after ready: the write lands while the visit is at the gateway host.
      await execute(s.resources.link(changed));
      release.resolve();
      const stale = { runId: target.runId, outcome: "pending" };
      const first = await visiting;
      expect(first.live).toEqual({ entries: [stale] });
      expect(first.entries).toEqual([stale]);
      expect(s.releasedCarriers).toEqual([]);
      expect(s.gateway.requests).toHaveLength(requests + 1);
      // The next tick (or the link's job, whichever comes first) configures the new link.
      const second = await worker.tick();
      const configured = { runId: target.runId, outcome: "configured" };
      expect(second.live).toEqual({ entries: [configured] });
      expect(second.entries).toEqual([configured]);
      expect(s.gateway.requests).toHaveLength(requests + 2);
      expect(s.gateway.requests.at(-1)?.link).toEqual(changed);
      expect(await execute(s.resourceOwner.reach())).toEqual([changed]);
      expect(s.carried.at(-1)?.runId).toBe(target.runId);
      expect(s.releasedCarriers).toEqual([]);
      // The page of every allocation alone, as the sweep ran before: the same answer.
      const again = { ...changed, worktreeKey: ResourceWorktreeKey.make("third") };
      s.gateway.beforeReply = () => execute(s.resources.link(again)).then(() => undefined);
      expect((await execute(s.resourceOwner.reconcile({ limit: 20 }))).entries).toEqual([stale]);
      expect(s.releasedCarriers).toEqual([]);
    }));

  it("refuses a link job that names another deployment's run", () =>
    test(async (s) => {
      if (s.input.scope.kind !== "owner") throw new Error("expected owner scope");
      const foreignRun = randomUUID();
      await execute(
        s.db
          .insert(workspaceAttempts)
          .values({ id: foreignRun, ownerUserId: s.input.scope.ownerUserId }),
      );
      await execute(
        s.db.insert(schema.boatRuns).values({
          runId: foreignRun,
          deploymentId: "other",
          publicationId: s.input.publication.publicationId,
          workspaceId: s.input.workspaceId,
          launchAttemptId: s.input.launchAttemptId,
          manifestDigest: AGENT_MANIFEST_DIGEST,
          snapshotName: s.input.publication.snapshot.identity.name,
          idempotencyKey: randomUUID(),
          diskLineage: randomUUID(),
        }),
      );
      // This deployment's own run in the same state is only not ready yet.
      await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
      expect(await execute(s.resourceOwner.apply(s.input.consumer.runId))).toBe("pending");
      expect(await execute(s.resourceOwner.apply(foreignRun))).toBe("held");
      // The sweep never lists it, and a link job for it released and configured nothing.
      expect((await execute(s.resourceOwner.reconcile({ limit: 20 }))).entries).toEqual([
        { runId: s.input.consumer.runId, outcome: "pending" },
      ]);
      expect(s.releasedCarriers).toEqual([]);
      await expectNoGateway(s);
    }));

  it("a stop that meets a link job at the gateway host saves the work, waits for the job, freezes, and ends stopped in one pass", () =>
    test(async (s) => {
      const { target, changed } = await linkedRun(s);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      s.gateway.beforeReply = async () => {
        entered.resolve();
        await release.promise;
      };
      await execute(s.resources.link(changed));
      const applied = execute(s.resourceOwner.apply(target.runId));
      await entered.promise;
      // The job holds the gateway host lock. The session is stopped and its stop begins.
      const before = touched(s);
      s.releasedCarriers.length = 0;
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      s.gateway.allowRemoval = true;
      const { paths, daemon } = await execute(
        s.final([savedStatus()], undefined, undefined, undefined, { waitMs: 10_000, pollMs: 20 }),
      );
      const closing = execute(paths.stop(target));
      try {
        // The work is saved first: FINAL needs nothing of the gateway host. The removal then
        // holds the execution and waits for the lock: nothing is frozen or deleted yet.
        await vi.waitFor(async () => expect(await launchPhase(s, target.runId)).toBe("held"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect((await tunnelRecord(s, target)).closeId).toBeUndefined();
        expect(daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
        expect(s.provider.deleteCalls).toBe(0);
        expect(s.gateway.removeCalls).toBe(0);
      } finally {
        release.resolve();
      }
      // The job's mutation returns and it finds the run stopping: no guest setup, no carrier.
      expect(await applied).toBe("held");
      expect(await closing).toBe("stopped");
      expect(touched(s)).toEqual(before);
      expect(s.releasedCarriers).toEqual([]);
      expect(daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
      expect(s.gateway.removeCalls).toBe(1);
      expect(s.provider.deleteCalls).toBe(1);
      expect(await tunnelRecord(s, target)).toMatchObject({ updates: [], released: true });
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "operation", id: s.provider.deletionId, completed: true },
      });
    }));

  it("a stop still fails when a link job holds the gateway host past the bound, with the work saved and nothing deleted, and the next pass stops it", () =>
    test(async (s) => {
      const { target, changed } = await linkedRun(s);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      s.gateway.beforeReply = async () => {
        entered.resolve();
        await release.promise;
      };
      await execute(s.resources.link(changed));
      const applied = execute(s.resourceOwner.apply(target.runId));
      await entered.promise;
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      s.gateway.allowRemoval = true;
      const freeze = { waitMs: 400, pollMs: 20 };
      const { paths, daemon } = await execute(
        s.final([savedStatus()], undefined, undefined, undefined, freeze),
      );
      try {
        const { outcome, elapsedMs } = await timed(paths.stop(target));
        expect(Result.isFailure(outcome) && String(outcome.failure)).toContain("close-unavailable");
        // The freeze's own bound.
        expect(elapsedMs).toBeGreaterThanOrEqual(freeze.waitMs);
        expect(elapsedMs).toBeLessThan(5_000);
        // The work is saved and the execution held; nothing frozen, no gateway removal, and
        // Boat was asked nothing.
        expect(daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
        expect(await launchPhase(s, target.runId)).toBe("held");
        expect((await tunnelRecord(s, target)).closeId).toBeUndefined();
        expect(s.gateway.removeCalls).toBe(0);
        expect(s.provider.deleteCalls).toBe(0);
        expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
      } finally {
        release.resolve();
      }
      expect(await applied).toBe("held");
      expect(await execute(paths.stop(target))).toBe("stopped");
      expect(s.gateway.removeCalls).toBe(1);
      expect(s.provider.deleteCalls).toBe(1);
    }));

  it("never configures a run launched without resources, from a tick or from a link job", () =>
    test(
      async (s) => {
        const target = await launched(s);
        expect(await execute(s.resourceOwner.apply(target.runId))).toBe("no-resources");
        const sweep = await execute(s.resourceOwner.reconcile({ limit: 20, live: { limit: 20 } }));
        expect(sweep.live).toEqual({ entries: [] });
        expect(sweep.entries).toEqual([{ runId: target.runId, outcome: "no-resources" }]);
        expect(s.releasedCarriers).toEqual([]);
        await expectNoGateway(s);
      },
      { resources: "none" },
    ));

  it("configures nothing on a deployment with no resource gateway", () =>
    test(
      async (s) => {
        const target = await execute(s.allocations.prepare(s.input));
        await execute(s.executor.stage(target.runtimeInstanceId, Redacted.make(launchMaterial())));
        expect(await execute(s.resourceOwner.apply(target.runId))).toBe("unavailable");
        expect(
          (await execute(s.resourceOwner.reconcile({ limit: 20, live: { limit: 20 } }))).live,
        ).toEqual({ entries: [] });
        await expectNoGateway(s);
      },
      { resourceGateway: false },
    ));

  it("leaves a stopping run untouched while its stop drains, from a tick or from a link job, and the stop ends as before", () =>
    test(async (s) => {
      const { target, changed } = await linkedRun(s);
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      s.gateway.allowRemoval = true;
      s.carried.length = 0;
      s.releasedCarriers.length = 0;
      const before = touched(s);
      // A stop was requested and its drain has not begun: a link job changes nothing.
      await execute(s.resources.link(changed));
      expect(await execute(s.resourceOwner.apply(target.runId))).toBe("held");
      expect(touched(s)).toEqual(before);

      // The stop is waiting on its FINAL drain. Its stop request, recorded before the drain, is
      // what fences every configuration: nothing is held or frozen until the removal.
      const reached = await execute(Deferred.make<void>());
      const open = await execute(Deferred.make<void>());
      const { paths, daemon } = await execute(s.final([{ gated: savedStatus(), reached, open }]));
      const closing = execute(paths.stop(target));
      await execute(Deferred.await(reached));
      try {
        const frozen = await tunnelRecord(s, target);
        expect(frozen.closeId).toBeUndefined();
        expect(await launchPhase(s, target.runId)).toBe("running");
        expect(await execute(s.resourceOwner.apply(target.runId))).toBe("held");
        expect(s.releasedCarriers).toEqual([]);
        // The tick: no longer a live run, and the page of every allocation reports it held and
        // releases its carrier, as the sweep did before.
        const sweep = await execute(s.resourceOwner.reconcile({ limit: 20, live: { limit: 20 } }));
        expect(sweep.live).toEqual({ entries: [] });
        expect(sweep.entries).toEqual([{ runId: target.runId, outcome: "held" }]);
        expect(s.releasedCarriers).toEqual([target.runId]);
        expect(touched(s)).toEqual(before);
        expect(await tunnelRecord(s, target)).toEqual(frozen);
      } finally {
        await execute(Deferred.succeed(open, undefined));
      }
      expect(await closing).toBe("stopped");
      expect(daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
      expect(s.gateway.removeCalls).toBe(1);
      expect(s.provider.deleteCalls).toBe(1);
      expect(await tunnelRecord(s, target)).toMatchObject({ released: true });
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "operation", id: s.provider.deletionId, completed: true },
      });
      // Closed: a late link job reports it and still touches nothing.
      expect(await execute(s.resourceOwner.apply(target.runId))).toBe("closed");
      expect(touched(s)).toEqual(before);
    }));
});

/** Everything a stop has released and recorded once Boat's deletion completed, short of the capture token. */
const REMOVED = {
  runtime: { status: "stopped", removed: true },
  pin: true,
  absent: true,
  launchErased: true,
};
/**
 * What the removal itself discharges once Boat no longer has the VM: Boat's own obligations. The
 * run's runtime row and capture record are the shared stop's to write, and the removal leaves both.
 */
const DISCHARGED = {
  runtime: { removed: false },
  pin: true,
  absent: true,
  launchErased: true,
};
/** The owner's discard: one of the three things that authorize deleting a VM a daemon ran on. */
const discardedBy = (s: AllocationFixture, runId: string) =>
  execute(s.canonical.requestDiscard({ runId, requestedBy: "usr_owner" }));

describe.runIf(databaseUrl !== undefined).each([
  { name: "a run with a tunnel", options: {} },
  { name: "a run launched without resources", options: { resources: "none" } as const },
])("Boat removal: the one deletion of $name", ({ options }) => {
  const tunnelled = options.resources === undefined;
  /** The run's tunnel slot: held while frozen and unreleased, or absent for a run without one. */
  const slot = async (s: AllocationFixture, target: BoatExecutionTarget) => {
    if (!tunnelled) return null;
    const record = await tunnelRecord(s, target);
    return { frozen: record.closeId !== undefined, released: record.released === true };
  };
  const settled = async (s: AllocationFixture, target: BoatExecutionTarget) => {
    if (!tunnelled) return expectNoGateway(s);
    expect(await slot(s, target)).toEqual({ frozen: true, released: true });
    expect(s.gateway.removeCalls).toBe(1);
  };
  const unreleased = async (s: AllocationFixture, target: BoatExecutionTarget) => {
    expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
    expect(s.gateway.removeCalls).toBe(0);
    if (tunnelled) expect(await slot(s, target)).toMatchObject({ released: false });
  };

  it("from nothing sent: fences, claims, sends one DELETE, records the operation on the allocation, and discharges on completed", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const { removal, daemon } = await execute(s.final(["unreachable"]));
      const asked = s.guest.actions.length;
      const atDelete: unknown[] = [];
      s.provider.beforeDeletion = async () => {
        atDelete.push({
          execution: await launchPhase(s, target.runId),
          slot: await slot(s, target),
          claim: (await vmOf(s, target.runId)).removal?.kind,
          ...(await released(s, target.runId)),
        });
      };
      const allocation = await runOf(s, target.runId);
      expect(await execute(removal.remove(allocation, AUTHORIZED))).toBe("removed");
      // Fenced and claimed before the DELETE, with nothing released yet.
      expect(atDelete).toHaveLength(1);
      expect(atDelete[0]).toMatchObject({
        execution: "held",
        slot: tunnelled ? { frozen: true, released: false } : null,
        claim: "issued",
        ...NOTHING_RELEASED,
      });
      expect(s.provider.deleteCalls).toBe(1);
      // It weighs nothing about the work on the VM: the guest and its daemon are asked nothing.
      expect(daemon.calls).toEqual([]);
      expect(s.guest.actions.length).toBe(asked);
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: {
          kind: "operation",
          id: s.provider.deletionId,
          targetId: target.sandboxId,
          completed: true,
        },
      });
      // Boat's own obligations are discharged. The run's row and its capture record are not the
      // removal's to write.
      expect(await released(s, target.runId)).toMatchObject(DISCHARGED);
      expect((await execute(s.canonical.getByRunId(target.runId)))?.state ?? null).toBeNull();
      await settled(s, target);
      // A repeat, with the record it was first given, finds it removed and asks Boat nothing.
      const reads = s.provider.reads.length;
      expect(await execute(removal.remove(allocation, AUTHORIZED))).toBe("removed");
      expect(s.provider.reads.length).toBe(reads);
      expect(s.provider.deleteCalls).toBe(1);
      await settled(s, target);
    }, options));

  it("with the operation recorded and not complete: releases nothing, polls it from a restarted worker, never sends DELETE again, and discharges once Boat completes", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      await execute(s.canonical.storeCaptureToken({ runId: target.runId, sealed: "sealed-token" }));
      const first = await execute(s.final(["unreachable"]));
      const allocation = await runOf(s, target.runId);
      s.provider.deletionCompleted = false;
      expect(await execute(first.removal.remove(allocation, AUTHORIZED))).toBe("deleting");
      const recorded = {
        phase: "deleting",
        removal: {
          kind: "operation",
          id: s.provider.deletionId,
          targetId: target.sandboxId,
          completed: false,
        },
      };
      expect(await vmOf(s, target.runId)).toMatchObject(recorded);
      if (tunnelled) expect((await tunnelRecord(s, target)).removal).toBeUndefined();
      await unreleased(s, target);
      expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED_WITH_TOKEN);
      // A restarted worker has no memory of the DELETE: it polls the operation it finds.
      const restarted = await execute(s.final(["unreachable"]));
      const polled = s.provider.deletionReads;
      expect(
        await Promise.all([
          execute(restarted.removal.remove(allocation, AUTHORIZED)),
          // A recorded operation is only polled: that needs no authorization.
          execute(restarted.removal.remove(allocation)),
        ]),
      ).toEqual(["deleting", "deleting"]);
      expect(s.provider.deletionReads).toBeGreaterThanOrEqual(polled + 2);
      expect(s.provider.deleteCalls).toBe(1);
      expect(await vmOf(s, target.runId)).toMatchObject(recorded);
      await unreleased(s, target);
      // Boat unreachable, then answering for another operation: the recorded one is kept. The
      // failure says the operation is on record, so its caller knows Boat accepted the deletion.
      s.provider.deletionUnavailable = true;
      expect(
        await execute(Effect.flip(restarted.removal.remove(allocation, AUTHORIZED))),
      ).toMatchObject({ code: "unavailable", requested: true, recorded: true });
      s.provider.deletionUnavailable = false;
      s.provider.deletionWrongId = true;
      expect(
        await execute(Effect.flip(restarted.removal.remove(allocation, AUTHORIZED))),
      ).toMatchObject({ code: "held", requested: true });
      s.provider.deletionWrongId = false;
      expect(await vmOf(s, target.runId)).toMatchObject(recorded);
      await unreleased(s, target);
      // Cleanup alone asks Boat nothing and releases nothing while Boat has not said the VM is gone.
      const reads = s.provider.reads.length;
      expect(await execute(restarted.removal.cleanup(allocation))).toBe("present");
      expect(s.provider.reads.length).toBe(reads);
      await unreleased(s, target);
      // Boat completes it, and the worker dies with that recorded and nothing discharged yet.
      s.provider.deletionCompleted = true;
      await execute(
        s.repo.recordDeletion(target.runId, {
          id: s.provider.deletionId,
          sandboxId: target.sandboxId,
          completed: true,
        }),
      );
      // Boat's completion and the VM's absence are one statement; what the VM held is still held.
      expect(await released(s, target.runId)).toMatchObject(ABSENT_NOT_RELEASED);
      expect(s.gateway.removeCalls).toBe(0);
      if (tunnelled) expect(await slot(s, target)).toMatchObject({ released: false });
      // Complete, not discharged: cleanup alone discharges, with no DELETE and no read of Boat.
      expect(await execute(restarted.removal.cleanup(allocation))).toBe("removed");
      expect(s.provider.reads.length).toBe(reads);
      expect(s.provider.deleteCalls).toBe(1);
      // The capture token is the capture record's: the shared stop clears it, not the removal.
      expect(await released(s, target.runId)).toMatchObject({ ...DISCHARGED, captureToken: false });
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "operation", id: s.provider.deletionId, completed: true },
      });
      await settled(s, target);
    }, options));

  it("with the DELETE sent and its reply lost: records no operation and releases nothing, then asks again for the same owned VM", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const { removal } = await execute(s.final(["unreachable"]));
      const allocation = await runOf(s, target.runId);
      s.provider.deleteLost = true;
      // Boat was asked: the outcome is unknown, never a refusal, and no operation is on record.
      expect(await execute(Effect.flip(removal.remove(allocation, AUTHORIZED)))).toMatchObject({
        code: "unavailable",
        requested: true,
        recorded: false,
      });
      // The allocation carries the claim the DELETE was sent under, and nothing else.
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleting",
        removal: { kind: "issued" },
      });
      expect(await launchPhase(s, target.runId)).toBe("held");
      await unreleased(s, target);
      // Its request is over, so the claim was given up: Boat still has the VM, it is read
      // again, and DELETE goes to that exact VM again.
      s.provider.deleteLost = false;
      expect(await execute(removal.remove(allocation, AUTHORIZED))).toBe("removed");
      expect(s.provider.deleteCalls).toBe(2);
      expect(await released(s, target.runId)).toMatchObject(DISCHARGED);
      await settled(s, target);
    }, options));

  it("with the DELETE sent and its reply lost: Boat's own 404 answers it, with no second DELETE", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const { removal } = await execute(s.final(["unreachable"]));
      const allocation = await runOf(s, target.runId);
      s.provider.deleteLost = true;
      await expect(execute(removal.remove(allocation, AUTHORIZED))).rejects.toThrow("unavailable");
      // Boat carried the DELETE out; only its reply was lost.
      s.provider.sandboxMissing = true;
      expect(await execute(removal.remove(allocation, AUTHORIZED))).toBe("removed");
      expect(s.provider.deleteCalls).toBe(1);
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "absent", completed: true },
      });
      expect(await released(s, target.runId)).toMatchObject(DISCHARGED);
      await settled(s, target);
    }, options));

  it("with the VM already absent: cleans up only, fencing nothing and sending nothing, whatever its caller holds", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const { removal } = await execute(s.final(["unreachable"]));
      s.provider.sandboxMissing = true;
      // No authorization: a VM Boat no longer has is only cleaned up.
      expect(await execute(removal.remove(await runOf(s, target.runId)))).toBe("removed");
      expect(s.provider.deleteCalls).toBe(0);
      // Nothing can reach a VM that does not exist: its execution was not held for it.
      expect(await launchPhase(s, target.runId)).toBe("running");
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "absent", completed: true },
      });
      expect(await released(s, target.runId)).toMatchObject(DISCHARGED);
      await settled(s, target);
    }, options));

  it("sends Boat nothing for a run that is not stopping, one whose caller holds nothing that authorizes deleting it, a foreign VM, or one Boat cannot be read for", () =>
    test(async (s) => {
      const target = await launched(s);
      s.gateway.allowRemoval = true;
      const { removal } = await execute(s.final(["unreachable"]));
      const allocation = await runOf(s, target.runId);
      const refusal = (authorized: boolean) =>
        execute(Effect.flip(removal.remove(allocation, authorized ? AUTHORIZED : {})));
      const untouched = async () => {
        expect(await launchPhase(s, target.runId)).toBe("running");
        if (tunnelled) expect(await slot(s, target)).toMatchObject({ frozen: false });
        expect(await vmOf(s, target.runId)).toMatchObject({ phase: "bound" });
        expect((await vmOf(s, target.runId)).removal).toBeUndefined();
        expect(s.provider.deleteCalls).toBe(0);
      };
      // Not stopping: refused before any fence is written, whatever its caller holds.
      expect(await refusal(true)).toMatchObject({ code: "held", requested: false });
      await untouched();
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      // Stopping, and a daemon ran on the VM: without an authorization nothing is fenced or sent.
      expect(await refusal(false)).toMatchObject({ code: "held", requested: false });
      await untouched();
      // An authorization is asked for once, when a DELETE is about to be sent, and `false` holds.
      let asked = 0;
      expect(
        await execute(
          Effect.flip(
            removal.remove(allocation, {
              authorized: Effect.sync(() => {
                asked += 1;
                return false;
              }),
            }),
          ),
        ),
      ).toMatchObject({ code: "held", requested: false });
      expect(asked).toBe(1);
      await untouched();
      // A VM without this run's labels is never touched, and an unreadable one is unknown.
      s.provider.foreign = true;
      expect(await refusal(true)).toMatchObject({ code: "held", requested: false });
      s.provider.foreign = false;
      s.provider.beforeSandboxRead = async () => {
        throw new Error("Boat is down");
      };
      expect(await refusal(true)).toMatchObject({ code: "unavailable", requested: false });
      s.provider.beforeSandboxRead = async () => {};
      await untouched();
      await unreleased(s, target);
      // An operation Boat names for another VM is recorded nowhere, and nothing is released.
      s.provider.deletionForeign = true;
      expect(await refusal(true)).toMatchObject({ code: "held", requested: true, recorded: false });
      expect((await vmOf(s, target.runId)).removal?.kind).toBe("issued");
      await unreleased(s, target);
    }, options));

  it("deletes a VM no launch was ever pushed to on Core's own record of that, with no authorization, and fences it first", () =>
    test(async (s) => {
      // Bound and exchanged, never launched: nothing ran on it.
      const target = await execute(s.allocations.prepare(s.input));
      expect(await launchPhase(s, target.runId)).toBe("control");
      s.gateway.allowRemoval = true;
      const { removal } = await execute(s.final(["unreachable"]));
      const allocation = await runOf(s, target.runId);
      // Not stopping: not even this VM is touched.
      expect(await execute(Effect.flip(removal.remove(allocation)))).toMatchObject({
        code: "held",
        requested: false,
      });
      expect(await launchPhase(s, target.runId)).toBe("control");
      await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
      const atDelete: unknown[] = [];
      s.provider.beforeDeletion = async () => {
        atDelete.push(await launchPhase(s, target.runId));
      };
      let asked = 0;
      expect(
        await execute(
          removal.remove(allocation, {
            authorized: Effect.sync(() => {
              asked += 1;
              return false;
            }),
          }),
        ),
      ).toBe("removed");
      // Never asked: nothing on the VM needs anyone's leave. Aborted before the DELETE, so no
      // launch can be pushed after it.
      expect(asked).toBe(0);
      expect(atDelete).toEqual(["aborted"]);
      expect(s.provider.deleteCalls).toBe(1);
      expect(s.guest.starts).toBe(0);
      await expect(execute(s.executor.launch(target.runtimeInstanceId))).rejects.toThrow();
      expect(await released(s, target.runId)).toMatchObject({ pin: true, absent: true });
    }, options));

  it("sends one DELETE for two concurrent first calls: one claims it, the other waits for what it records", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const { removal } = await execute(s.final(["unreachable"], undefined, 5_000));
      const allocation = await runOf(s, target.runId);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      s.provider.beforeDeletion = async () => {
        entered.resolve();
        await release.promise;
      };
      const first = execute(removal.remove(allocation, AUTHORIZED));
      await entered.promise;
      // The first call's DELETE is in flight, nothing recorded yet but its claim.
      expect((await vmOf(s, target.runId)).removal?.kind).toBe("issued");
      const second = execute(removal.remove(allocation, AUTHORIZED));
      // The second finds the claim held and sends nothing, however long the first takes.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(s.provider.deleteCalls).toBe(1);
      release.resolve();
      expect(await first).toBe("removed");
      // It ends on what the first brought about, in the same call.
      expect(["removed", "discharging"]).toContain(await second);
      expect(s.provider.deleteCalls).toBe(1);
      expect(await released(s, target.runId)).toMatchObject(DISCHARGED);
      await settled(s, target);
    }, options));

  it("holds off every other call while a claim's caller may still be sending its DELETE, and lets one through once the claim has lapsed", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const { removal } = await execute(s.final(["unreachable"]));
      const allocation = await runOf(s, target.runId);
      // A caller fenced the run, claimed the DELETE and vanished: nobody knows whether it sent it.
      await execute(s.executor.hold(target));
      if (tunnelled) await execute(s.tunnels.freeze(await tunnelRecord(s, target), randomUUID()));
      await execute(claimBoatDeletionAgo(s.db, target.runId, 0));
      for (const pass of [1, 2]) {
        expect(await execute(removal.remove(allocation, AUTHORIZED))).toBe("deleting");
        expect(s.provider.deleteCalls, `pass ${String(pass)}`).toBe(0);
      }
      await unreleased(s, target);
      // The claim's lease has passed: the exact owned VM is read again and DELETE is sent.
      await execute(claimBoatDeletionAgo(s.db, target.runId, BOAT_REMOVAL_CLAIM_MS + 1));
      expect(await execute(removal.remove(allocation, AUTHORIZED))).toBe("removed");
      expect(s.provider.deleteCalls).toBe(1);
      expect(await released(s, target.runId)).toMatchObject(DISCHARGED);
    }, options));

  it("the adapter's stop finds the VM by its id, reports a deletion in progress as pending and no refusal, and is idempotent on the recorded operation", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const target = await stopLaunched(s);
        await discardedBy(s, target.runId);
        // The row's reference names no run: the allocation's writes rewrote it.
        const instance = await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId));
        expect(instance?.reference).toBe(`boat:${target.sandboxId}`);
        const input = { resourceId: target.sandboxId, reference: `boat:${target.sandboxId}` };
        // Boat states no bound on a deletion: the generic path reads none from its adapter.
        const lifecycle: RuntimeAdapterLifecycle = f.adapter;
        expect(lifecycle.removalFenceMs).toBeUndefined();
        s.provider.deletionCompleted = false;
        for (const attempt of [1, 2, 3]) {
          const pending = await stopFailure(f.adapter.stop(input));
          expect(pending).toBeInstanceOf(BoatAdapterError);
          expect(pending).toMatchObject({ code: "close-pending" });
          // Boat accepted the deletion and has not finished: not a refusal, not an unknown.
          expect(isRemovalPending(pending)).toBe(true);
          expect(isRemovalRefusal(pending)).toBe(false);
          // One DELETE, whatever the number of stops: the later ones poll its operation.
          expect(s.provider.deleteCalls).toBe(1);
          expect(s.provider.deletionReads).toBeGreaterThanOrEqual(attempt - 1);
          await unreleased(s, target);
        }
        expect(await vmOf(s, target.runId)).toMatchObject({
          phase: "deleting",
          removal: { kind: "operation", id: s.provider.deletionId, completed: false },
        });
        // Boat unreachable while the operation is on record: still deleting as far as anyone
        // knows. Answering for another operation is an outcome nobody knows.
        s.provider.deletionUnavailable = true;
        const unread = await stopFailure(f.adapter.stop(input));
        expect(unread).toMatchObject({ code: "close-pending" });
        expect(isRemovalPending(unread)).toBe(true);
        expect(isRemovalRefusal(unread)).toBe(false);
        s.provider.deletionUnavailable = false;
        s.provider.deletionWrongId = true;
        const unknown = await stopFailure(f.adapter.stop(input));
        expect(unknown).toMatchObject({ code: "close-pending" });
        expect(isRemovalPending(unknown)).toBe(false);
        expect(isRemovalRefusal(unknown)).toBe(false);
        s.provider.deletionWrongId = false;
        await unreleased(s, target);
        s.provider.deletionCompleted = true;
        const stopped = { adapter: "boat", resourceId: target.sandboxId, outcome: "stopped" };
        // With or without a reference: only the VM's id is read.
        expect(await f.adapter.stop({ resourceId: target.sandboxId })).toEqual(stopped);
        expect(await released(s, target.runId)).toMatchObject(DISCHARGED);
        await settled(s, target);
        expect(await f.adapter.stop(input)).toEqual(stopped);
        expect(s.provider.deleteCalls).toBe(1);
        await settled(s, target);
        // The executor is gone: the runtime answers `missing` from its own completed deletion.
        expect(await f.adapter.inspect({ resourceId: target.sandboxId })).toEqual({
          state: "missing",
        });
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it("the adapter's stop reports a lost DELETE reply as an unknown outcome, and a refusal only when Boat was asked nothing", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const target = await launched(s);
        s.gateway.allowRemoval = true;
        await discardedBy(s, target.runId);
        const failure = (adapter: BoatRuntimeAdapter, resourceId: string) =>
          stopFailure(adapter.stop({ resourceId }));
        // Not stopping: nothing is fenced and Boat is asked nothing, whatever is on record. A
        // definitive refusal.
        const held = await failure(f.adapter, target.sandboxId);
        expect(held).toMatchObject({ code: "close-held" });
        expect(isRemovalRefusal(held)).toBe(true);
        expect(await launchPhase(s, target.runId)).toBe("running");
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        // Boat cannot be read: nothing is fenced and nothing is sent. A refusal too.
        s.provider.beforeSandboxRead = async () => {
          throw new Error("Boat is down");
        };
        const unread = await failure(f.adapter, target.sandboxId);
        expect(unread).toMatchObject({ code: "close-unavailable" });
        expect(isRemovalRefusal(unread)).toBe(true);
        s.provider.beforeSandboxRead = async () => {};
        // A VM this deployment holds no allocation for, and another deployment's adapter.
        const unknown = await failure(f.adapter, "bx_3456789a");
        expect(unknown).toMatchObject({ code: "target-mismatch" });
        expect(isRemovalRefusal(unknown)).toBe(true);
        const foreign = await failure(
          new BoatRuntimeAdapter({ deploymentId: "other", runtime: f.runtime }),
          target.sandboxId,
        );
        expect(foreign).toMatchObject({ code: "target-mismatch" });
        expect(isRemovalRefusal(foreign)).toBe(true);
        expect(await launchPhase(s, target.runId)).toBe("running");
        expect(s.provider.deleteCalls).toBe(0);
        // The DELETE went out and its reply was lost: Boat may be deleting. No refusal, and
        // not a deletion known to be in progress either.
        s.provider.deleteLost = true;
        const lost = await failure(f.adapter, target.sandboxId);
        expect(lost).toMatchObject({ code: "close-pending" });
        expect(isRemovalRefusal(lost)).toBe(false);
        expect(isRemovalPending(lost)).toBe(false);
        expect(s.provider.deleteCalls).toBe(1);
        await unreleased(s, target);
        s.provider.deleteLost = false;
        expect(await f.adapter.stop({ resourceId: target.sandboxId })).toMatchObject({
          outcome: "stopped",
        });
        expect(await released(s, target.runId)).toMatchObject(DISCHARGED);
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it.each([
    [
      "the capture ledger's issued removal, held live",
      async (
        s: AllocationFixture,
        f: Awaited<ReturnType<typeof adapterFixture>>,
        runId: string,
      ) => {
        const { ledger } = f.close;
        await execute(ledger.recordStatus(runId, savedStatus(), Date.now()));
        const read = await execute(ledger.read(runId));
        const authorized = await execute(
          ledger.authorizeDeletion(runId, read.readable ? (read.entry?.evidenceVersion ?? 0) : -1),
        );
        if (authorized.kind !== "authorized") throw new Error(authorized.kind);
        // Authorized and not yet issued is no ticket: the removal may still be voided.
        const early = await stopFailure(f.adapter.stop({ resourceId: "bx_23456789" }));
        expect(early).toMatchObject({ code: "close-held" });
        expect(s.provider.deleteCalls).toBe(0);
        expect(await execute(ledger.issueDeletion(runId, authorized.ticket))).toBe(true);
      },
    ],
    [
      "the owner's discard",
      async (
        s: AllocationFixture,
        _f: Awaited<ReturnType<typeof adapterFixture>>,
        runId: string,
      ) => {
        await discardedBy(s, runId);
      },
    ],
    [
      "the agent's own answer, through this adapter's recover, that nothing is to save",
      async (
        s: AllocationFixture,
        f: Awaited<ReturnType<typeof adapterFixture>>,
        runId: string,
      ) => {
        s.guest.recovery = "nothing-to-save";
        expect(
          await f.adapter.recover({
            resourceId: "bx_23456789",
            runId,
            secretEnv: { SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN },
            daemonRecoveryBoot: true,
          }),
        ).toMatchObject({ outcome: "nothing-to-save" });
      },
    ],
  ] as const)(
    "the adapter's stop deletes a VM a daemon ran on only for a caller that holds %s",
    (_name, grant) =>
      test(async (s) => {
        const f = await adapterFixture(s);
        try {
          const target = await stopLaunched(s);
          // Stopping, and nothing held: refused before Boat is asked or anything is fenced.
          const refused = await stopFailure(f.adapter.stop({ resourceId: target.sandboxId }));
          expect(refused).toMatchObject({ code: "close-held" });
          expect(isRemovalRefusal(refused)).toBe(true);
          expect(await launchPhase(s, target.runId)).toBe("running");
          if (tunnelled) expect(await slot(s, target)).toMatchObject({ frozen: false });
          expect(s.provider.deleteCalls).toBe(0);
          await grant(s, f, target.runId);
          expect(s.provider.deleteCalls).toBe(0);
          expect(await f.adapter.stop({ resourceId: target.sandboxId })).toMatchObject({
            outcome: "stopped",
          });
          expect(s.provider.deleteCalls).toBe(1);
          expect(await released(s, target.runId)).toMatchObject(DISCHARGED);
          await settled(s, target);
        } finally {
          await f.runtime.dispose();
        }
      }, options),
  );

  it("the adapter's stop refuses an issued removal whose hold has ended: its issuer is no longer the caller", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const target = await stopLaunched(s);
        const { ledger } = f.close;
        await execute(ledger.recordStatus(target.runId, savedStatus(), Date.now()));
        const read = await execute(ledger.read(target.runId));
        const authorized = await execute(
          ledger.authorizeDeletion(
            target.runId,
            read.readable ? (read.entry?.evidenceVersion ?? 0) : -1,
          ),
        );
        if (authorized.kind !== "authorized") throw new Error(authorized.kind);
        expect(await execute(ledger.issueDeletion(target.runId, authorized.ticket))).toBe(true);
        // Its issuer's call ended with nothing recorded: the removal stays issued, its hold over.
        await execute(ledger.lapseIssuedDeletion(target.runId, authorized.ticket));
        const refused = await stopFailure(f.adapter.stop({ resourceId: target.sandboxId }));
        expect(refused).toMatchObject({ code: "close-held" });
        expect(isRemovalRefusal(refused)).toBe(true);
        expect(s.provider.deleteCalls).toBe(0);
        await unreleased(s, target);
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it("the adapter's stop sends one DELETE for two concurrent first calls", () =>
    test(async (s) => {
      const f = await adapterFixture(s, { deletionWaitMs: 5_000 });
      try {
        const target = await stopLaunched(s);
        await discardedBy(s, target.runId);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        s.provider.beforeDeletion = async () => {
          entered.resolve();
          await release.promise;
        };
        const first = f.adapter.stop({ resourceId: target.sandboxId });
        await entered.promise;
        const second = f.adapter.stop({ resourceId: target.sandboxId });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(s.provider.deleteCalls).toBe(1);
        release.resolve();
        // Both resolve: Boat no longer has the VM, by the one DELETE.
        expect(await first).toMatchObject({ outcome: "stopped" });
        expect(await second).toMatchObject({ outcome: "stopped" });
        expect(s.provider.deleteCalls).toBe(1);
        expect(await released(s, target.runId)).toMatchObject(DISCHARGED);
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it("the adapter's stop ends within its bound when a Boat request stalls, as an outcome nobody knows", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      const release = Promise.withResolvers<void>();
      try {
        const target = await stopLaunched(s);
        await discardedBy(s, target.runId);
        s.provider.beforeDeletion = () => release.promise;
        const bounded = new BoatRuntimeAdapter({
          deploymentId: "test",
          runtime: f.runtime,
          stopBoundMs: 300,
        });
        const started = Date.now();
        const stalled = await stopFailure(bounded.stop({ resourceId: target.sandboxId }));
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(stalled).toMatchObject({ code: "close-pending" });
        // The DELETE may have reached Boat: never a refusal, and not known to be in progress.
        expect(isRemovalRefusal(stalled)).toBe(false);
        expect(isRemovalPending(stalled)).toBe(false);
        await unreleased(s, target);
      } finally {
        release.resolve();
        await f.runtime.dispose();
      }
    }, options));
});

describe.runIf(databaseUrl !== undefined)("Boat removal of a run closed before the upgrade", () => {
  /**
   * A close by the earlier code, as the migration carries it: the launch held, the tunnel frozen
   * with the operation on its own record, and that operation on the run's row (with the VM's
   * absence, where Boat had completed it). The tunnel's copy is never read again.
   */
  const closedByEarlierCode = async (s: AllocationFixture, completed: boolean) => {
    const target = await stopLaunched(s);
    await execute(s.executor.hold(target));
    const frozen = await execute(s.tunnels.freeze(await tunnelRecord(s, target), randomUUID()));
    await execute(
      corruptBoatTunnel(s.db, target.runId, {
        ...frozen,
        removal: { id: s.provider.deletionId, completed },
      }),
    );
    await execute(
      corruptBoatRun(s.db, target.runId, {
        deletionOperationId: s.provider.deletionId,
        ...(completed
          ? {
              deletionCompletedAt: new Date(),
              absentAt: new Date(),
              absentBasis: "deletion-completed" as const,
              sealedLaunch: null,
            }
          : {}),
      }),
    );
    expect(await vmOf(s, target.runId)).toMatchObject({
      phase: completed ? "deleted" : "deleting",
      removal: { kind: "operation", id: s.provider.deletionId, completed },
    });
    return target;
  };

  it("honours an operation id carried from the tunnel row: polled, never a second DELETE", () =>
    test(async (s) => {
      const target = await closedByEarlierCode(s, false);
      s.provider.deletionCompleted = false;
      const { paths, removal, daemon } = await execute(s.final(["unreachable"]));
      // What that close left on the capture record: its FINAL observed complete, and the removal
      // it issued with no outcome recorded.
      await execute(paths.ledger.recordStatus(target.runId, savedStatus(), Date.now()));
      const read = await execute(paths.ledger.read(target.runId));
      const issued = await execute(
        paths.ledger.authorizeDeletion(
          target.runId,
          read.readable ? (read.entry?.evidenceVersion ?? 0) : -1,
        ),
      );
      if (issued.kind !== "authorized") throw new Error(issued.kind);
      expect(await execute(paths.ledger.issueDeletion(target.runId, issued.ticket))).toBe(true);
      await execute(paths.ledger.lapseIssuedDeletion(target.runId, issued.ticket));
      // Through the shared stop, as a reaper and Boat's sweep reach it: the removal is issued
      // again on the evidence that still stands, and the adapter polls the operation it finds.
      expect(await execute(paths.stop(target))).toBe("draining");
      expect(s.provider.deleteCalls).toBe(0);
      expect(s.provider.deletionReads).toBeGreaterThan(0);
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleting",
        removal: {
          kind: "operation",
          id: s.provider.deletionId,
          targetId: target.sandboxId,
          completed: false,
        },
      });
      // The tunnel row is never written: it keeps what the earlier code recorded.
      expect((await tunnelRecord(s, target)).removal).toEqual({
        id: s.provider.deletionId,
        completed: false,
      });
      expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
      expect(s.gateway.removeCalls).toBe(0);
      // Through the removal itself, as the adapter's stop reaches it.
      expect(await execute(removal.remove(await runOf(s, target.runId), AUTHORIZED))).toBe(
        "deleting",
      );
      expect(s.provider.deleteCalls).toBe(0);
      s.provider.deletionCompleted = true;
      expect(await execute(paths.stop(target))).toBe("stopped");
      expect(daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(0);
      expect(s.gateway.removeCalls).toBe(1);
      expect(await tunnelRecord(s, target)).toMatchObject({ released: true });
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "operation", id: s.provider.deletionId, completed: true },
      });
      expect(await released(s, target.runId)).toMatchObject(REMOVED);
    }));

  it("releases what a deletion the earlier code recorded complete on the tunnel row still held", () =>
    test(async (s) => {
      const target = await closedByEarlierCode(s, true);
      const { removal } = await execute(s.final(["unreachable"]));
      expect(await execute(removal.remove(await runOf(s, target.runId)))).toBe("removed");
      expect(s.provider.deleteCalls).toBe(0);
      expect(s.gateway.removeCalls).toBe(1);
      expect(await vmOf(s, target.runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "operation", id: s.provider.deletionId, completed: true },
      });
      expect(await released(s, target.runId)).toMatchObject(DISCHARGED);
    }));
});

/** A launched run recorded ready, as the build worker records it. */
const readyRun = async (s: AllocationFixture) => {
  const target = await launched(s);
  await execute(
    s.runtimes.upsertRuntimeInstance({
      runId: target.runId,
      adapter: "boat",
      status: "ready",
      resourceId: target.sandboxId,
    }),
  );
  return target;
};
/** The agent's health once sealantd exited: its code and its last output, the bearer in it. */
const daemonExited = {
  status: 503,
  body: {
    booted: true,
    controlSocket: false,
    daemonExit: {
      code: 75,
      signal: null,
      output: `sealantd: final flush incomplete\ncontrol ${"a".repeat(64)} closed\n`,
    },
  },
};
/** The same exit with a signal that is no signal's name: the guest's free text is not repeated. */
const daemonKilledOddly = {
  status: 503,
  body: {
    booted: true,
    controlSocket: false,
    daemonExit: { code: null, signal: "SIGKILL; rm -rf /" },
  },
};
/** A ready run and an adapter on a clock the test moves, with what each inspection read. */
const inspectFixture = async (s: AllocationFixture, inspectBoundMs?: number) => {
  const f = await adapterFixture(s);
  const clock = { now: Date.parse("2026-11-10T00:00:00.000Z") };
  const adapter = new BoatRuntimeAdapter({
    deploymentId: "test",
    runtime: f.runtime,
    now: () => clock.now,
    ...(inspectBoundMs === undefined ? {} : { inspectBoundMs }),
  });
  const target = await readyRun(s);
  return {
    ...f,
    adapter,
    clock,
    target,
    inspect: () => adapter.inspect({ resourceId: target.sandboxId }),
    /** How often Boat was asked for the VM, and the agent for its health. */
    reads: () => ({
      boat: s.provider.reads.filter((path) => path === `/api/v1/sandboxes/${target.sandboxId}`)
        .length,
      agent: healthPolls(s),
    }),
    row: () => execute(s.runtimes.getRuntimeInstanceByRunId(target.runId)),
    observed: () => observedAll(s),
  };
};

describe.runIf(databaseUrl !== undefined)("Boat adapter inspect", () => {
  it("answers running for a VM Boat has whose agent reports its daemon up", () =>
    test(async (s) => {
      const f = await inspectFixture(s);
      try {
        expect(await f.inspect()).toEqual({ state: "running", platformState: "running" });
        expect(await f.row()).toMatchObject({ status: "ready", removedAt: null });
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("answers exited, the machine still up, when the agent's health names the daemon's exit, with the bearer redacted", () =>
    test(async (s) => {
      const f = await inspectFixture(s);
      try {
        s.guest.health = () => daemonExited;
        const exited = await f.inspect();
        expect(exited).toMatchObject({
          state: "exited",
          exitCode: 75,
          platformEnded: false,
          platformState: "running",
        });
        if (exited.state !== "exited") throw new Error("expected an exit");
        expect(exited.detail).toContain("final flush incomplete");
        expect(exited.detail).toContain("[REDACTED]");
        expect(exited.detail).not.toContain("a".repeat(64));
        // What Boat said of the VM is unchanged: present, and nothing was written about it.
        expect(await f.observed()).toEqual(["present"]);
        expect(await f.row()).toMatchObject({ status: "ready", removedAt: null });
        // No exit code, and a signal that is not a signal's name: reported, never repeated.
        s.guest.health = () => daemonKilledOddly;
        expect(await f.inspect()).toEqual({
          state: "exited",
          platformEnded: false,
          platformState: "running",
          detail:
            "sealantd in the Boat VM exited before the workspace stopped (code null, signal unrecognized).",
        });
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("answers running when the agent reports no daemon launched on its boot for a run that was ready: nothing observed its daemon end (#599)", () =>
    test(async (s) => {
      const f = await inspectFixture(s);
      try {
        // The agent restarted on the same boot and could not adopt its launch record.
        s.guest.health = () => ({ status: 503, body: { booted: false, controlSocket: false } });
        expect(await f.inspect()).toEqual({ state: "running", platformState: "running" });
        // A stop requested for it changes nothing: the row was ready, the daemon may be alive.
        await execute(s.runtimes.markStopRequested({ runId: f.target.runId, stopReason: "user" }));
        f.clock.now += BOAT_INSPECT_READ_MS;
        expect(await f.inspect()).toEqual({ state: "running", platformState: "running" });
        expect(await f.row()).toMatchObject({ status: "ready", errorCode: null, removedAt: null });
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("answers exited, the machine still up, when the agent reports no daemon launched on its boot for a launch that never became ready and is stopping", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        // Launched, never recorded ready, and its stop requested.
        const target = await stopLaunched(s);
        s.guest.health = () => ({ status: 503, body: { booted: false, controlSocket: false } });
        expect(await f.adapter.inspect({ resourceId: target.sandboxId })).toEqual({
          state: "exited",
          platformEnded: false,
          platformState: "running",
          detail: expect.stringContaining("no daemon launched"),
        });
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("answers running for a launch not pushed while it may still be, and exited once its run is stopping or its execution fenced, without asking the agent", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const target = await execute(s.allocations.prepare(s.input));
        const asked = healthPolls(s);
        const inspect = () => {
          f.close.clock.now += BOAT_INSPECT_READ_MS;
          return f.adapter.inspect({ resourceId: target.sandboxId });
        };
        // Bound, its launch not pushed and its run live: a launch may still be on its way.
        expect(await launchPhase(s, target.runId)).toBe("control");
        expect(await inspect()).toEqual({ state: "running", platformState: "running" });
        // Its stop is requested: no launch was confirmed running, and its recovery decides.
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        expect(await inspect()).toEqual({
          state: "exited",
          platformEnded: false,
          platformState: "running",
          detail: expect.stringContaining("no launch was confirmed running"),
        });
        await execute(s.repo.fence(target.runId));
        expect(await inspect()).toEqual({
          state: "exited",
          platformEnded: false,
          platformState: "running",
          detail: expect.stringContaining("No launch was ever pushed"),
        });
        // The record answers: the agent's `booted: false` would describe the same thing.
        expect(healthPolls(s)).toBe(asked);
      } finally {
        await f.runtime.dispose();
      }
    }));

  it.each<readonly [string, (s: AllocationFixture) => void]>([
    [
      "Boat does not answer",
      (s) => {
        s.provider.beforeSandboxRead = async () => {
          throw new Error("Boat is down");
        };
      },
    ],
    [
      "Boat answers with a VM that does not carry the run's labels",
      (s) => {
        s.provider.foreign = true;
      },
    ],
    [
      "Boat cannot host the agent",
      (s) => {
        s.guest.beforeHost = async () => {
          throw new Error("hosting failed");
        };
      },
    ],
    [
      "the agent's health is lost in transport",
      (s) => {
        s.guest.health = () => {
          throw new Error("connection reset");
        };
      },
    ],
    [
      "the hosted proxy answers 503 for the agent",
      (s) => {
        s.guest.health = () => ({ status: 503, body: { message: "upstream not ready" } });
      },
    ],
    [
      "the agent's health is not the contract's",
      (s) => {
        s.guest.health = () => ({ status: 200, body: { booted: "yes" } });
      },
    ],
  ])("answers running, and records nothing, when %s", (_what, fail) =>
    test(async (s) => {
      const f = await inspectFixture(s);
      try {
        fail(s);
        expect(await f.inspect()).toMatchObject({ state: "running" });
        expect(await f.observed()).toEqual(["present"]);
        expect(await f.row()).toMatchObject({ status: "ready", removedAt: null });
        expect(s.provider.deleteCalls).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }),
  );

  it("answers running when a read does not answer within its bound", () =>
    test(async (s) => {
      const f = await inspectFixture(s, 250);
      const never = Promise.withResolvers<void>();
      try {
        s.guest.beforeReady = () => never.promise;
        expect(await f.inspect()).toEqual({ state: "running" });
        expect(await f.row()).toMatchObject({ status: "ready", removedAt: null });
      } finally {
        never.resolve();
        await f.runtime.dispose();
      }
    }));

  it("answers running for a 404 of a VM Boat never reported past creation, and commits no absence", () =>
    test(async (s) => {
      const f = await inspectFixture(s);
      try {
        // As straight after create: nothing on record says Boat ever reported the VM created.
        await execute(forgetCreationSeen(s));
        s.provider.sandboxMissing = true;
        expect(await f.inspect()).toEqual({ state: "running" });
        expect(await f.observed()).toEqual([]);
        expect(await f.row()).toMatchObject({ status: "ready", removedAt: null });
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("answers missing on Boat's typed 404 for a VM it had reported past creation, and from that committed absence afterwards", () =>
    test(async (s) => {
      const f = await inspectFixture(s);
      try {
        expect(await f.inspect()).toMatchObject({ state: "running" });
        // Another period, and a person deleted the VM in Boat's console meanwhile.
        f.clock.now += BOAT_INSPECT_READ_MS;
        s.provider.sandboxMissing = true;
        expect(await f.inspect()).toEqual({ state: "missing" });
        // The absence is the observer's own commit, and all it writes: the run's row is the
        // shared paths' to write, from this answer.
        expect(await f.observed()).toEqual(["absent"]);
        expect(await f.row()).toMatchObject({ status: "ready", stopReason: null, removedAt: null });
        // Asked again, even of a Boat that answers once more: the committed absence stands.
        s.provider.sandboxMissing = false;
        const read = f.reads();
        expect(await f.inspect()).toEqual({ state: "missing" });
        expect(f.reads()).toEqual(read);
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("reads Boat and the agent once per period for a live VM, answers running in between, and never answers exited or missing from memory", () =>
    test(async (s) => {
      const f = await inspectFixture(s);
      try {
        const start = f.reads();
        const after = (reads: number) => ({
          boat: start.boat + reads,
          agent: start.agent + reads,
        });
        expect(await f.inspect()).toEqual({ state: "running", platformState: "running" });
        expect(f.reads()).toEqual(after(1));
        // The daemon dies a moment later. Until the period is over nothing is read: `running`.
        s.guest.health = () => daemonExited;
        for (const elapsed of [5_000, 30_000, BOAT_INSPECT_READ_MS - 1]) {
          f.clock.now += elapsed - (f.clock.now - Date.parse("2026-11-10T00:00:00.000Z"));
          expect(await f.inspect()).toEqual({ state: "running" });
        }
        expect(f.reads()).toEqual(after(1));
        // The period is over: read, and the exit is reported.
        f.clock.now += 1;
        expect(await f.inspect()).toMatchObject({ state: "exited", exitCode: 75 });
        expect(f.reads()).toEqual(after(2));
        // An exit is never remembered. Asked again in the same instant, it is read again...
        expect(await f.inspect()).toMatchObject({ state: "exited", exitCode: 75 });
        expect(f.reads()).toEqual(after(3));
        // ...so a daemon that is up again is believed at once, not answered `exited` from memory.
        s.guest.health = () => undefined;
        expect(await f.inspect()).toEqual({ state: "running", platformState: "running" });
        expect(f.reads()).toEqual(after(4));
        // That read answered `running`, and paces the next period.
        f.clock.now += BOAT_INSPECT_READ_MS - 1;
        s.provider.sandboxMissing = true;
        expect(await f.inspect()).toEqual({ state: "running" });
        expect(f.reads()).toEqual(after(4));
        expect(await f.observed()).toEqual(["present"]);
        // The absence is concluded only from a read: Boat's own 404, once the period is over.
        f.clock.now += 1;
        expect(await f.inspect()).toEqual({ state: "missing" });
        expect(f.reads().boat).toBe(start.boat + 5);
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("answers missing for an absence another writer committed, inside the pacing window and without asking Boat or the agent", () =>
    test(async (s) => {
      const f = await inspectFixture(s);
      try {
        expect(await f.inspect()).toEqual({ state: "running", platformState: "running" });
        const read = f.reads();
        // The same instant: paced, `running` from the read a moment ago.
        expect(await f.inspect()).toEqual({ state: "running" });
        // Another observer commits Boat's 404 for the VM (a removal polling its deletion, the
        // exit reconciler): from then on the run's row says Boat no longer has it.
        await execute(s.repo.recordNotFound(f.target.runId, f.target.sandboxId));
        expect(await f.observed()).toEqual(["absent"]);
        // Still the same instant, well inside the period: the row is read, not the memory.
        expect(await f.inspect()).toEqual({ state: "missing" });
        f.clock.now += BOAT_INSPECT_READ_MS - 1;
        expect(await f.inspect()).toEqual({ state: "missing" });
        // Nothing was asked of Boat or the agent for it.
        expect(f.reads()).toEqual(read);
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("paces a failed read like any other, as running", () =>
    test(async (s) => {
      const f = await inspectFixture(s);
      try {
        s.guest.health = () => {
          throw new Error("connection reset");
        };
        expect(await f.inspect()).toMatchObject({ state: "running" });
        const read = f.reads();
        f.clock.now += BOAT_INSPECT_READ_MS - 1;
        expect(await f.inspect()).toEqual({ state: "running" });
        expect(f.reads()).toEqual(read);
        f.clock.now += 1;
        s.guest.health = () => daemonExited;
        expect(await f.inspect()).toMatchObject({ state: "exited" });
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("paces a run whose stop is requested too: four reads a minute for a kept VM, not one every poll, and an ended answer is still never remembered (#599)", () =>
    test(async (s) => {
      const f = await inspectFixture(s);
      try {
        expect(await f.inspect()).toMatchObject({ state: "running" });
        const read = f.reads();
        await execute(s.runtimes.markStopRequested({ runId: f.target.runId, stopReason: "user" }));
        // Same instant: the read a moment ago still answers.
        expect(await f.inspect()).toEqual({ state: "running" });
        expect(f.reads()).toEqual(read);
        // A minute of the exit reconciler's polls, 5 s apart: one read every 15 s.
        for (let poll = 0; poll < 12; poll += 1) {
          f.clock.now += 5_000;
          expect(await f.inspect()).toMatchObject({ state: "running" });
        }
        expect(f.reads()).toEqual({ boat: read.boat + 4, agent: read.agent + 4 });
        expect(BOAT_INSPECT_STOPPING_READ_MS).toBe(15_000);
        // The daemon ends: the next read that is due reports it, and it is read again on every
        // call after that, never answered from memory.
        s.guest.health = () => daemonExited;
        f.clock.now += BOAT_INSPECT_STOPPING_READ_MS - 1;
        expect(await f.inspect()).toEqual({ state: "running" });
        f.clock.now += 1;
        expect(await f.inspect()).toMatchObject({ state: "exited", platformEnded: false });
        expect(await f.inspect()).toMatchObject({ state: "exited", platformEnded: false });
        expect(f.reads()).toEqual({ boat: read.boat + 6, agent: read.agent + 6 });
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("says nothing of a VM this deployment holds no allocation for", () =>
    test(async (s) => {
      const f = await inspectFixture(s);
      try {
        const other = new BoatRuntimeAdapter({ deploymentId: "other", runtime: f.runtime });
        const read = f.reads();
        expect(await other.inspect({ resourceId: f.target.sandboxId })).toEqual({
          state: "running",
        });
        expect(await f.adapter.inspect({ resourceId: "bx_3456789a" })).toEqual({
          state: "running",
        });
        expect(f.reads()).toEqual(read);
      } finally {
        await f.runtime.dispose();
      }
    }));
});

describe.runIf(databaseUrl !== undefined)("Boat control material for the worker's drains", () => {
  const drainFailure = (
    control: BoatControlMaterial["Service"],
    runId: string,
    sandboxId: string,
  ) =>
    execute(
      control
        .drainMaterial(runId, sandboxId)
        .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined })),
    );

  it("opens for a stop-requested run, and for one whose execution a close holds, where the strict method refuses", () =>
    test(async (s) => {
      const f = await controlFixture(s);
      try {
        const { runId, sandboxId } = f.target;
        await execute(s.runtimes.markStopRequested({ runId, stopReason: "user" }));
        // Exec jobs and the API: a stopping run is refused, before Boat is asked.
        expect(await f.failure(runId, sandboxId)).toMatchObject({ reason: "refused" });
        expect(s.provider.hostCalls).toBe(0);
        const opened = {
          url: "wss://fixture-8080.on.boat.dev/sealant/control",
          auth: { bearerToken: "a".repeat(64) },
          headers: {
            Cookie: "_port_auth=test-cookie-local-only",
            Authorization: `Bearer ${"a".repeat(64)}`,
          },
        };
        expect(await execute(f.control.drainMaterial(runId, sandboxId))).toEqual(opened);
        expect(s.provider.hostCalls).toBe(1);
        // FINAL's daemon is reached after the close held the execution too.
        await execute(s.executor.hold(f.target));
        expect(await boatDrainConnectMaterial(f.control)(runId, sandboxId)).toEqual(opened);
        // A fresh hosted cookie from Boat for every connection, as the strict method asks.
        expect(s.provider.hostCalls).toBe(2);
        expect(await f.failure(runId, sandboxId)).toMatchObject({ reason: "refused" });
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("opens for a run that never became ready, where the strict method refuses", () =>
    test(async (s) => {
      const target = await launched(s);
      const f = await controlMaterial(s, "test");
      try {
        const row = await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId));
        expect(row?.status).not.toBe("ready");
        expect(await f.failure(target.runId, target.sandboxId)).toMatchObject({
          reason: "refused",
        });
        expect(
          await execute(f.control.drainMaterial(target.runId, target.sandboxId)),
        ).toMatchObject({ auth: { bearerToken: "a".repeat(64) } });
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("refuses another deployment's run and a different sandbox, before asking Boat", () =>
    test(async (s) => {
      const f = await controlFixture(s);
      const other = await controlMaterial(s, "other");
      try {
        const { runId, sandboxId } = f.target;
        await execute(s.runtimes.markStopRequested({ runId, stopReason: "user" }));
        const asked = s.provider.reads.length;
        for (const refused of [
          await drainFailure(other.control, runId, sandboxId),
          await drainFailure(f.control, runId, "bx_3456789a"),
          await drainFailure(f.control, randomUUID(), sandboxId),
          await boatDrainConnectMaterial(other.control)(runId, sandboxId).then(
            () => undefined,
            (error: unknown) => error,
          ),
        ]) {
          expect(refused).toBeInstanceOf(BoatControlError);
          expect(refused).toMatchObject({ reason: "refused" });
          namesNoSecret(refused);
        }
        expect(s.provider.reads.length).toBe(asked);
        expect(s.provider.hostCalls).toBe(0);
      } finally {
        await f.runtime.dispose();
        await other.runtime.dispose();
      }
    }));

  it("refuses a VM whose Boat labels are not the run's, and names no secret when Boat fails", () =>
    test(async (s) => {
      const f = await controlFixture(s);
      const logged = vi.spyOn(console, "log").mockImplementation(() => {});
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errored = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { runId, sandboxId } = f.target;
        await execute(s.runtimes.markStopRequested({ runId, stopReason: "user" }));
        // The ownership-label check stands: Boat is never asked to host a foreign VM.
        s.provider.foreign = true;
        expect(await drainFailure(f.control, runId, sandboxId)).toMatchObject({
          reason: "refused",
        });
        expect(s.provider.hostCalls).toBe(0);
        s.provider.foreign = false;
        s.provider.hostUnavailable = true;
        const unavailable = await drainFailure(f.control, runId, sandboxId);
        expect(unavailable).toMatchObject({ reason: "unavailable" });
        namesNoSecret(unavailable);
        for (const spy of [logged, warned, errored])
          for (const call of spy.mock.calls) namesNoSecret(call);
      } finally {
        logged.mockRestore();
        warned.mockRestore();
        errored.mockRestore();
        await f.runtime.dispose();
      }
    }));

  it("refuses a run whose launch was never pushed, or was fenced before it: no daemon ran to drain", () =>
    test(async (s) => {
      const target = await execute(s.allocations.prepare(s.input));
      const f = await controlMaterial(s, "test");
      try {
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        expect(await launchPhase(s, target.runId)).toBe("control");
        expect(await drainFailure(f.control, target.runId, target.sandboxId)).toMatchObject({
          reason: "refused",
        });
        await execute(s.repo.fence(target.runId));
        expect(await drainFailure(f.control, target.runId, target.sandboxId)).toMatchObject({
          reason: "refused",
        });
        expect(s.provider.hostCalls).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }));
});

/** A ready run, the shared paths over it with the daemon answering `script`, and its reads. */
const readyPaths = async (s: AllocationFixture, script: readonly CaptureDaemonScriptEntry[]) => {
  const paths = await execute(s.final(script));
  const target = await readyRun(s);
  s.gateway.allowRemoval = true;
  return {
    ...paths,
    target,
    runId: target.runId,
    row: () => execute(s.runtimes.getRuntimeInstanceByRunId(target.runId)),
    drain: () => execute(s.canonical.getByRunId(target.runId)),
    observed: () => observedAll(s),
    recovers: () => s.guest.actions.filter((action) => action === "recover").length,
  };
};

describe.runIf(databaseUrl !== undefined)(
  "Boat runs under the shared exit reconciler and recovery sweep",
  () => {
    it("records a daemon that exited in a live VM as failed with its retention, and its recovery restarts it on its disk, drains FINAL and deletes the VM", () =>
      test(async (s) => {
        // Silent while it is dead; it answers once the agent has started it again.
        const f = await readyPaths(s, ["unreachable", savedStatus()]);
        // A healthy session is left alone.
        expect(await execute(f.reconcileExits())).toBe(0);
        expect(await f.row()).toMatchObject({ status: "ready", errorCode: null });
        s.guest.health = () => daemonExited;
        expect(await execute(f.reconcileExits())).toBe(1);
        expect(await f.row()).toMatchObject({
          status: "failed",
          errorCode: "runtime-exited",
          errorMessage: expect.stringContaining("exitCode: 75"),
          stopReason: null,
          removedAt: null,
        });
        expect(await f.drain()).toMatchObject({
          retainedAt: expect.any(Date),
          deletionState: null,
        });
        // Recorded and kept: nothing was asked of the agent's recovery or of Boat, nothing fenced.
        expect(f.daemon.calls).toEqual([]);
        expect(f.recovers()).toBe(0);
        expect(s.provider.deleteCalls).toBe(0);
        expect(await vmOf(s, f.runId)).toMatchObject({ phase: "bound" });
        expect(await launchPhase(s, f.runId)).toBe("running");
        expect(await released(s, f.runId)).toMatchObject(NOTHING_RELEASED);
        // Recorded once: the row is no longer `ready`, and its retention keeps the settle sweep off.
        expect(await execute(f.reconcileExits())).toBe(0);
        // The recovery sweep its retention starts: the agent restarts sealantd in recovery mode,
        // handed the capture token; FINAL is drained, and only then is the VM deleted.
        s.guest.recovery = "restarted";
        expect(await execute(f.recover(f.runId))).toBe("released");
        expect(f.recovers()).toBe(1);
        expect(await launchPhase(s, f.runId)).toBe("held");
        expect(f.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await f.row()).toMatchObject({
          status: "stopped",
          stopReason: "failed",
          errorCode: "runtime-exited",
          removedAt: expect.any(Date),
        });
        expect(await f.drain()).toMatchObject({
          state: "stopped",
          deletionState: "deleted",
          retainedAt: null,
          captureTokenSealed: null,
        });
        expect(await released(s, f.runId)).toMatchObject(REMOVED);
        expect(s.guest.starts).toBe(1);
      }));

    it("drains a restarted daemon again on the next recovery when its first drain did not finish, without restarting it twice, and deletes the VM only then", () =>
      test(async (s) => {
        // Silent while it is dead; restarted, its FINAL is not complete within the first drain.
        const f = await readyPaths(s, ["unreachable", captureStatus({ complete: false })]);
        s.guest.health = () => daemonExited;
        expect(await execute(f.reconcileExits())).toBe(1);
        s.guest.recovery = "restarted";
        expect(await execute(f.recover(f.runId))).toBe("retained");
        expect(f.recovers()).toBe(1);
        expect(s.provider.deleteCalls).toBe(0);
        expect(await released(s, f.runId)).toMatchObject(NOTHING_RELEASED);
        // The daemon is up now, so the sweep reads it running and hands no capture token. It is
        // drained as it is: not refused for the missing token, and not restarted a second time.
        s.guest.health = () => undefined;
        const next = await execute(s.final([savedStatus()]));
        expect(await execute(next.recover(f.runId))).toBe("released");
        expect(f.recovers()).toBe(1);
        expect(next.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await f.row()).toMatchObject({ status: "stopped", removedAt: expect.any(Date) });
        expect(await f.drain()).toMatchObject({
          state: "stopped",
          deletionState: "deleted",
          retainedAt: null,
        });
        expect(await released(s, f.runId)).toMatchObject(REMOVED);
      }));

    it("drains a daemon restarted during a requested stop on the next recovery, where nothing else would: the stopped run's VM is not kept with its work unsaved", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        const first = await execute(s.final(["unreachable", captureStatus({ complete: false })]));
        // The daemon ended during the stop; the agent restarts it, and its FINAL is not complete
        // within this attempt's drain.
        s.guest.health = () => daemonExited;
        s.guest.recovery = "restarted";
        expect(await execute(first.stop(target))).toBe("kept");
        expect(recovers(s)).toBe(1);
        expect(s.provider.deleteCalls).toBe(0);
        expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
          retainedAt: expect.any(Date),
          deletionState: null,
        });
        s.guest.health = () => undefined;
        const next = await execute(s.final([savedStatus()]));
        expect(await execute(next.recover(target.runId))).toBe("released");
        expect(recovers(s)).toBe(1);
        expect(next.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
          state: "stopped",
          deletionState: "deleted",
          retainedAt: null,
        });
        expect(await released(s, target.runId)).toMatchObject(REMOVED);
      }));

    it("removes the VM of a dead daemon whose recovery boot finds nothing to save (exit 76), without a FINAL", () =>
      test(async (s) => {
        const f = await readyPaths(s, ["unreachable"]);
        s.guest.health = () => daemonExited;
        expect(await execute(f.reconcileExits())).toBe(1);
        s.guest.recovery = "nothing-to-save";
        expect(await execute(f.recover(f.runId))).toBe("released");
        expect(f.daemon.calls).toEqual([]);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await f.drain()).toMatchObject({
          state: "stopped",
          retainedAt: null,
          detail: expect.stringContaining("nothing to save"),
        });
        expect(await released(s, f.runId)).toMatchObject(REMOVED);
      }));

    it("polls a deletion Boat accepted and holds at processing, never drains the run meanwhile, and records it stopped in the visit that finds the deletion complete (harness: deletion stuck in processing)", () =>
      test(async (s) => {
        // A removal waits a second and a half for Boat's operation, so two callers poll it at once.
        const paths = await execute(s.final(["unreachable"], undefined, 1_500));
        const target = await readyRun(s);
        const runId = target.runId;
        s.gateway.allowRemoval = true;
        // The run failed with its VM kept: retained, and its recovery finds nothing to save.
        s.guest.health = () => daemonExited;
        expect(await execute(paths.reconcileExits())).toBe(1);
        // The exit reconciler probed the dead daemon once. From here on, what a drain would
        // leave: a connection to the daemon, a call to it, a line that it did not answer.
        const probed = paths.connects.length;
        const drained = () => ({
          connects: paths.connects.slice(probed),
          calls: paths.daemon.calls,
          unanswered: paths.logged.filter((line) => line.includes("did not answer")),
        });
        const NOT_DRAINED = { connects: [], calls: [], unanswered: [] };
        s.guest.recovery = "nothing-to-save";
        // Boat accepts the DELETE and holds its operation at `processing`; the VM stays readable.
        s.provider.deletionCompleted = false;
        // Recovery removes the VM and waits on the operation. While it is polling, Boat's sweep
        // visits the run.
        let meeting: Promise<BoatConvergenceSweep> | undefined;
        s.provider.beforeDeletionRead = async () => {
          meeting ??= execute(paths.sweep({ limit: 20 }));
        };
        expect(await execute(paths.recover(runId))).toBe("retained");
        // The sweep polled the same operation, sent nothing and started no drain.
        expect((await meeting)?.entries).toEqual([{ runId, outcome: "draining" }]);
        s.provider.beforeDeletionRead = async () => {};
        expect(s.provider.deleteCalls).toBe(1);
        expect(drained()).toEqual(NOT_DRAINED);
        expect(await released(s, runId)).toMatchObject({ pin: false, absent: false });
        // A later tick while it is still stuck: polled again, nothing else.
        expect((await execute(paths.sweep({ limit: 20 }))).entries).toEqual([
          { runId, outcome: "draining" },
        ]);
        expect(drained()).toEqual(NOT_DRAINED);

        // The next tick's poll is the one Boat answers `completed`. A moment before it, another
        // path inspected the VM and its agent did not answer (the VM is being deleted): `running`,
        // which paces the next reads. The sweep's visit follows that read at once.
        s.guest.health = () => {
          throw new Error("connection reset");
        };
        paths.hooks.elapseMs = 0;
        let completed = false;
        s.provider.beforeDeletionRead = async () => {
          if (completed) return;
          completed = true;
          expect(await paths.adapter.inspect({ resourceId: target.sandboxId })).toEqual({
            state: "running",
          });
          s.provider.deletionCompleted = true;
          s.provider.sandboxMissing = true;
        };
        // The visit that finds the deletion complete releases what the VM held and nudges the
        // shared stop, which reads Boat's absence from the run's row and records the run stopped:
        // no drain of a VM that is gone.
        expect((await execute(paths.sweep({ limit: 20 }))).entries).toEqual([
          { runId, outcome: "stopped" },
        ]);
        expect(completed).toBe(true);
        expect(drained()).toEqual(NOT_DRAINED);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await released(s, runId)).toMatchObject({
          runtime: { status: "stopped", removed: true },
          pin: true,
          absent: true,
        });
        expect((await tunnelRecord(s, target)).released).toBe(true);
        expect(s.gateway.removeCalls).toBe(1);
        expect(await vmOf(s, runId)).toMatchObject({
          removal: { kind: "operation", completed: true },
        });
        expect((await execute(s.canonical.getByRunId(runId)))?.retainedAt ?? null).toBeNull();
        // Nothing is left for a later tick of either sweep or of the exit reconciler.
        paths.hooks.elapseMs = BOAT_INSPECT_READ_MS;
        expect(await execute(paths.sweep({ limit: 20 }))).toEqual({ entries: [] });
        expect(await execute(s.allocations.reconcile({ limit: 20 }))).toEqual({ entries: [] });
        expect(await execute(paths.reconcileExits())).toBe(0);
        expect(drained()).toEqual(NOT_DRAINED);
        expect(s.provider.deleteCalls).toBe(1);
      }));

    it("keeps the VM of a dead daemon whose recovery the agent refuses: recorded failed and retained, never deleted, until its owner discards it", () =>
      test(async (s) => {
        const f = await readyPaths(s, ["unreachable"]);
        s.guest.health = () => daemonExited;
        expect(await execute(f.reconcileExits())).toBe(1);
        // The agent cannot bring the daemon back on this boot.
        s.guest.recovery = "recover-state-unknown";
        for (const pass of [1, 2]) {
          expect(await execute(f.recover(f.runId)), `pass ${String(pass)}`).toBe("retained");
          expect(await execute(f.reconcileExits())).toBe(0);
          // Boat's sweep asks the shared stop for the failed run, which keeps it too; the
          // recovery that follows a kept stop is refused as well.
          expect((await execute(f.sweep({ limit: 20 }))).entries).toEqual([
            { runId: f.runId, outcome: "kept" },
          ]);
        }
        // Only recovery attempts asked the agent: two per pass here, none from any other path.
        expect(f.recovers()).toBe(4);
        expect(s.provider.deleteCalls).toBe(0);
        expect(f.daemon.calls).toEqual([]);
        expect(await f.row()).toMatchObject({ status: "failed", removedAt: null });
        expect(await vmOf(s, f.runId)).toMatchObject({ phase: "bound" });
        expect(await released(s, f.runId)).toMatchObject({ pin: false, absent: false });
        expect((await tunnelRecord(s, f.target)).released).toBeUndefined();
        expect(await f.drain()).toMatchObject({
          retainedAt: expect.any(Date),
          deletionState: null,
          lastRecoveryError: expect.stringContaining("recover-state-unknown"),
        });
        // Only the owner's discard removes it.
        await discardedBy(s, f.runId);
        expect(await execute(f.stop({ runId: f.runId }, "failed"))).toBe("stopped");
        expect(s.provider.deleteCalls).toBe(1);
        expect(await f.drain()).toMatchObject({ state: "discarded", retainedAt: null });
        expect(await released(s, f.runId)).toMatchObject(REMOVED);
      }));

    it("keeps a VM whose daemon lacks the recovery boot, or whose capture token was not kept, and never asks its agent to restart it", () =>
      test(async (s) => {
        const f = await readyPaths(s, ["unreachable"]);
        s.guest.health = () => daemonExited;
        expect(await execute(f.reconcileExits())).toBe(1);
        const refused = (input: {
          readonly secretEnv?: Record<string, string>;
          readonly boot: boolean | null;
        }) =>
          f.adapter.recover({
            resourceId: f.target.sandboxId,
            runId: f.runId,
            ...(input.secretEnv === undefined ? {} : { secretEnv: input.secretEnv }),
            daemonRecoveryBoot: input.boot,
          });
        const token = { SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN };
        expect(await refused({ secretEnv: token, boot: false })).toMatchObject({
          outcome: "unsupported",
          detail: expect.stringContaining("predates sealantd's recovery boot"),
        });
        expect(await refused({ secretEnv: token, boot: null })).toMatchObject({
          outcome: "unsupported",
          detail: expect.stringContaining("cannot tell"),
        });
        expect(await refused({ boot: true })).toMatchObject({
          outcome: "unsupported",
          detail: expect.stringContaining("no capture token"),
        });
        expect(f.recovers()).toBe(0);
        // Fenced all the same: nothing can start on the VM again.
        expect(await launchPhase(s, f.runId)).toBe("held");
        expect(s.provider.deleteCalls).toBe(0);
        // An answer that is no deletion basis authorizes no deletion.
        const kept = await stopFailure(f.adapter.stop({ resourceId: f.target.sandboxId }));
        expect(kept).toMatchObject({ code: "close-held" });
      }));

    it("concludes a VM missing only from Boat's own answer, and then records it lost and releases what it held, as for any runtime's lost executor", () =>
      test(async (s) => {
        const f = await readyPaths(s, ["unreachable"]);
        await execute(s.canonical.storeCaptureToken({ runId: f.runId, sealed: "sealed-token" }));
        // Boat does not answer: nothing is concluded, however often it is asked.
        s.provider.beforeSandboxRead = async () => {
          throw new Error("Boat is down");
        };
        expect(await execute(f.reconcileExits())).toBe(0);
        expect(await execute(f.reconcileExits())).toBe(0);
        expect(await f.row()).toMatchObject({ status: "ready", removedAt: null });
        expect(await f.observed()).toEqual(["present"]);
        // A person deletes the VM in Boat's console; no stop was ever requested.
        s.provider.beforeSandboxRead = async () => {};
        s.provider.sandboxMissing = true;
        expect(await execute(f.reconcileExits())).toBe(1);
        expect(await f.observed()).toEqual(["absent"]);
        expect(await f.row()).toMatchObject({
          status: "failed",
          errorCode: "runtime-exited",
          stopReason: null,
          removedAt: expect.any(Date),
        });
        expect(await f.drain()).toMatchObject({
          state: "gone",
          retainedAt: null,
          captureTokenSealed: null,
          deletionState: null,
        });
        expect(await vmOf(s, f.runId)).toMatchObject({
          phase: "deleted",
          removal: { kind: "absent", completed: true },
        });
        expect((await tunnelRecord(s, f.target)).released).toBe(true);
        expect((await execute(nativeConsumerRows(s.db, f.runId)))[0]?.state).toBe("released");
        expect(s.gateway.removeCalls).toBe(1);
        // Idempotent, whoever comes back.
        expect(await execute(f.reconcileExits())).toBe(0);
        await execute(f.sweep({ limit: 20 }));
        await execute(f.sweep({ limit: 20 }));
        expect(s.gateway.removeCalls).toBe(1);
        expect(s.provider.deleteCalls).toBe(0);
        expect(f.daemon.calls).toEqual([]);
        expect(f.recovers()).toBe(0);
      }));

    it("leaves a run whose stop is requested and whose daemon is up to that stop: nothing recorded, nothing probed", () =>
      test(async (s) => {
        const f = await readyPaths(s, ["unreachable"]);
        await execute(s.runtimes.markStopRequested({ runId: f.runId, stopReason: "user" }));
        const connects = f.connects.length;
        for (const poll of ["first", "second"])
          expect(await execute(f.reconcileExits()), poll).toBe(0);
        expect(f.connects).toHaveLength(connects);
        expect(await f.row()).toMatchObject({
          status: "ready",
          stopReason: "user",
          errorCode: null,
          removedAt: null,
        });
        expect((await f.drain())?.retainedAt ?? null).toBeNull();
        expect(s.provider.deleteCalls).toBe(0);
      }));

    it("settles a failed Boat launch nothing settled as any runtime's: retained, and its recovery removes a VM no launch was pushed to", () =>
      test(async (s) => {
        const paths = await execute(s.final([]));
        const target = await execute(s.allocations.prepare(s.input));
        // A launch that failed after its VM was created, recorded with no retention.
        await execute(
          recordRetainedBoatLaunch(s.db, {
            runId: target.runId,
            sandboxId: target.sandboxId,
            errorCode: "launch-failed",
          }),
        );
        expect(await execute(paths.reconcileExits())).toBe(0);
        expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
          retainedAt: expect.any(Date),
        });
        expect(s.provider.deleteCalls).toBe(0);
        expect(await execute(paths.recover(target.runId))).toBe("released");
        expect(paths.daemon.calls).toEqual([]);
        expect(s.guest.actions.includes("recover")).toBe(false);
        expect(await launchPhase(s, target.runId)).toBe("aborted");
        expect(s.provider.deleteCalls).toBe(1);
        expect(await execute(s.canonical.getByRunId(target.runId))).toMatchObject({
          state: "stopped",
          retainedAt: null,
        });
      }));
  },
);

describe.runIf(databaseUrl !== undefined)(
  "Boat tunnel slot released by two callers at once",
  () => {
    it("is released once: the caller whose write finds it released by the other succeeds as the other does", () =>
      test(async (s) => {
        const target = await stopLaunched(s);
        const frozen = await execute(s.tunnels.freeze(await tunnelRecord(s, target), randomUUID()));
        await execute(s.repo.recordNotFound(target.runId, target.sandboxId));
        expect(await vmPhase(s, target.runId)).toBe("deleted");
        // One caller's release holds the slot's row from its read to its write.
        const held = Promise.withResolvers<void>();
        const write = Promise.withResolvers<void>();
        const first = execute(
          releaseBoatTunnelHolding(s.db, target.runId, {
            held: () => held.resolve(),
            write: write.promise,
          }),
        );
        await held.promise;
        // The other reads the slot unreleased, and its write waits on the first one's.
        const second = execute(s.tunnels.releaseAbsent(frozen));
        await vi.waitFor(async () => expect(await execute(boatTunnelLockWaiters(s.db))).toBe(1), {
          timeout: 10_000,
        });
        write.resolve();
        await first;
        await second;
        expect((await tunnelRecord(s, target)).released).toBe(true);
        // Released for good: a third release changes nothing.
        await execute(s.tunnels.releaseAbsent(frozen));
        expect((await tunnelRecord(s, target)).released).toBe(true);
      }));
  },
);

describe.runIf(databaseUrl !== undefined).each([
  { name: "a run with a tunnel", options: {} },
  { name: "a run launched without resources", options: { resources: "none" } as const },
])("Boat stop of $name beside a second observer of its deletion", ({ options }) => {
  const tunnelled = options.resources === undefined;
  /**
   * A stopping run and its stop on the shared path, with the other observers of the same VM that
   * run beside every stop: the exit reconciler, whose `inspect` commits Boat's 404 once it reads
   * it; Boat's convergence sweep, which releases whatever a VM Boat is recorded not to have still
   * holds; and a second stop of the same run (the expiry reaper's, the sweep's nudge).
   */
  const stopping = async (s: AllocationFixture, deletionWaitMs?: number) => {
    const f = await adapterFixture(s, deletionWaitMs === undefined ? {} : { deletionWaitMs });
    // A session that was ready, as every ordinary stop finds it: the exit reconciler polls it.
    const target = await readyRun(s);
    await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
    s.gateway.allowRemoval = true;
    const reconciled: number[] = [];
    const swept: unknown[] = [];
    const flushedAtDelete: unknown[] = [];
    const absent = () => observedAll(s);
    return {
      ...f,
      target,
      reconciled,
      swept,
      flushedAtDelete,
      absent,
      /** What the daemon had been asked for when Boat received the DELETE. */
      noteDelete: () => {
        flushedAtDelete.push(f.close.daemon.flushRequests.map((request) => request?.kind));
      },
      /**
       * Boat answers 404 for the VM from now on, and the exit reconciler polls: its `inspect`
       * reads that, commits the absence and answers `missing`.
       */
      reconcilerSeesItGone: async () => {
        s.provider.sandboxMissing = true;
        reconciled.push(await execute(f.close.reconcileExits()));
        expect(await absent()).toEqual(["absent"]);
      },
      sweep: async () => {
        swept.push((await execute(f.close.sweep({ limit: 20 }))).entries);
      },
      /** The stop job's route: the shared stop. */
      stopRun: () => execute(f.close.stop({ runId: target.runId })),
    };
  };
  /**
   * The stop ended as an undisturbed one does, in the one pass: FINAL, one DELETE, everything
   * released and recorded, and no error logged by any of the paths.
   */
  const stoppedCleanly = async (s: AllocationFixture, f: Awaited<ReturnType<typeof stopping>>) => {
    const runId = f.target.runId;
    expect(f.flushedAtDelete).toEqual([["final"]]);
    expect(f.close.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
    expect(s.provider.deleteCalls).toBe(1);
    // Nothing at warning level or above, from any path or from the adapter's own runtime. (The
    // fixture's run has no stored attempt, which the stop's credential sync-back says.)
    const said = () =>
      f.close.logged.filter((line) => !line.includes("Credential sync-back skipped"));
    expect(said()).toEqual([]);
    expect(await released(s, runId)).toMatchObject(REMOVED);
    expect(await execute(s.runtimes.getRuntimeInstanceByRunId(runId))).toMatchObject({
      status: "stopped",
      stopReason: "user",
      errorCode: null,
    });
    expect(await vmOf(s, runId)).toMatchObject({ phase: "deleted" });
    expect(await execute(s.canonical.getByRunId(runId))).toMatchObject({
      state: "stopped",
      deletionState: "deleted",
      retainedAt: null,
    });
    expect(await f.absent()).toEqual(["absent"]);
    if (tunnelled) {
      expect((await tunnelRecord(s, f.target)).released).toBe(true);
      expect(s.gateway.removeCalls).toBe(1);
    } else await expectNoGateway(s);
    // A later pass of every path, and a later stop, find nothing left to do.
    expect(await execute(f.close.reconcileExits())).toBe(0);
    await execute(f.close.sweep({ limit: 20 }));
    expect(await f.stopRun()).toBe("stopped");
    expect(s.provider.deleteCalls).toBe(1);
    expect(said()).toEqual([]);
    if (tunnelled) expect(s.gateway.removeCalls).toBe(1);
  };

  it("stops in one pass when the reconciler commits Boat's 404 after the DELETE and before the operation is recorded", () =>
    test(async (s) => {
      const f = await stopping(s);
      try {
        // Boat's deletion operation reads `processing` for the whole pass.
        s.provider.deletionCompleted = false;
        s.provider.beforeDeletion = async () => {
          f.noteDelete();
          await f.reconcilerSeesItGone();
        };
        expect(await f.stopRun()).toBe("stopped");
        // The reconciler recorded nothing: the removal in flight is its issuer's.
        expect(f.reconciled).toEqual([0]);
        await stoppedCleanly(s, f);
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it(
    "stops in one pass when the reconciler commits Boat's 404 after the operation is recorded and before its poll answers",
    () =>
      test(async (s) => {
        const f = await stopping(s, 10_000);
        try {
          s.provider.deletionCompleted = false;
          s.provider.beforeDeletion = async () => f.noteDelete();
          s.provider.beforeDeletionRead = async () => {
            if (f.reconciled.length === 0) await f.reconcilerSeesItGone();
          };
          expect(await f.stopRun()).toBe("stopped");
          expect(f.reconciled).toEqual([0]);
          // The poll that found the absence committed is the last one: the wait ends there.
          expect(s.provider.deletionReads).toBe(1);
          await stoppedCleanly(s, f);
        } finally {
          await f.runtime.dispose();
        }
      }, options),
    20_000,
  );

  it("stops in one pass when the reconciler sees it gone after the adapter's stop returned and before the shared path recorded anything", () =>
    test(async (s) => {
      const f = await stopping(s);
      try {
        s.provider.beforeDeletion = async () => f.noteDelete();
        let rowThen: unknown;
        f.close.hooks.afterAdapterStop = async () => {
          f.close.hooks.afterAdapterStop = async () => {};
          // The VM is gone by Boat's completed operation, and the run still reads ready.
          rowThen = await execute(s.runtimes.getRuntimeInstanceByRunId(f.target.runId));
          await f.reconcilerSeesItGone();
        };
        expect(await f.stopRun()).toBe("stopped");
        expect(rowThen).toMatchObject({ status: "ready", stopReason: "user", removedAt: null });
        expect(f.reconciled).toEqual([0]);
        await stoppedCleanly(s, f);
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it("stops in one pass when Boat's sweep releases what the VM held on that 404 before the operation is recorded (the live run)", () =>
    test(async (s) => {
      const f = await stopping(s);
      try {
        s.provider.beforeDeletion = async () => {
          f.noteDelete();
          await f.reconcilerSeesItGone();
          await f.sweep();
        };
        expect(await f.stopRun()).toBe("stopped");
        expect(f.reconciled).toEqual([0]);
        // The sweep cleaned up, and its nudge found the stop under way and left the run to it.
        expect(f.swept).toEqual([[{ runId: f.target.runId, outcome: "busy" }]]);
        // As the live run left it: released on Boat's absence, with no operation recorded.
        expect(await vmOf(s, f.target.runId)).toMatchObject({
          removal: { kind: "absent", completed: true },
        });
        await stoppedCleanly(s, f);
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it(
    "stops in one pass when Boat's sweep releases what the VM held between the record and Boat's completed",
    () =>
      test(async (s) => {
        const f = await stopping(s, 10_000);
        try {
          s.provider.deletionCompleted = false;
          s.provider.beforeDeletion = async () => f.noteDelete();
          s.provider.beforeDeletionRead = async () => {
            if (f.reconciled.length > 0) return;
            await f.reconcilerSeesItGone();
            await f.sweep();
            s.provider.deletionCompleted = true;
          };
          expect(await f.stopRun()).toBe("stopped");
          expect(f.reconciled).toEqual([0]);
          await stoppedCleanly(s, f);
        } finally {
          await f.runtime.dispose();
        }
      }, options),
    20_000,
  );

  it("leaves the run to the stop in flight when a second stop of it arrives mid-removal: no second FINAL, no second DELETE", () =>
    test(async (s) => {
      const f = await stopping(s);
      try {
        const second: unknown[] = [];
        s.provider.beforeDeletion = async () => {
          f.noteDelete();
          second.push(await f.stopRun());
        };
        expect(await f.stopRun()).toBe("stopped");
        expect(second).toEqual(["busy"]);
        s.provider.sandboxMissing = true;
        await stoppedCleanly(s, f);
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it("two concurrent stops of one run: one stops it, the other returns without an error, one FINAL and one DELETE", () =>
    test(async (s) => {
      const f = await stopping(s);
      try {
        // The DELETE takes a while, so the two stops are both under way whichever began first.
        s.provider.beforeDeletion = async () => {
          f.noteDelete();
          await new Promise((resolve) => setTimeout(resolve, 150));
        };
        const outcomes = await Promise.all([f.stopRun(), f.stopRun()]);
        // The run's drain claim serializes them, tunnel or none: the loser finds it held and
        // leaves the run to its holder, or arrives after it and finds the run stopped.
        expect(outcomes).toContain("stopped");
        expect(outcomes.filter((outcome) => outcome !== "stopped")).toEqual(
          outcomes.includes("busy") ? ["busy"] : [],
        );
        s.provider.sandboxMissing = true;
        await stoppedCleanly(s, f);
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it(
    "stops in one pass with every other caller of its stop running at once, Boat withdrawing the VM at the DELETE: nobody fails or logs an error",
    () =>
      test(async (s) => {
        const f = await stopping(s, 10_000);
        try {
          // As Boat does it: the VM answers 404 from the DELETE on, its operation still
          // `processing`. The exit reconciler, Boat's sweep (cleanup and nudge) and a second stop
          // (the expiry reaper's) all start while the first stop is removing the VM.
          s.provider.deletionCompleted = false;
          const others: Promise<unknown>[] = [];
          const second: unknown[] = [];
          s.provider.beforeDeletion = async () => {
            f.noteDelete();
            s.provider.sandboxMissing = true;
            others.push(
              execute(f.close.reconcileExits()).then((recorded) => f.reconciled.push(recorded)),
              f.sweep(),
              f.stopRun().then((outcome) => second.push(outcome)),
            );
          };
          expect(await f.stopRun()).toBe("stopped");
          // None of them rejected: a caller that loses returns, it does not fail.
          await Promise.all(others);
          expect(others).toHaveLength(3);
          // The reconciler recorded nothing of its own, and the second stop found the run held
          // by the first, or already stopped by it.
          expect(f.reconciled).toEqual([0]);
          expect(["busy", "stopped"]).toContain(second[0]);
          expect(f.swept).toHaveLength(1);
          await stoppedCleanly(s, f);
        } finally {
          await f.runtime.dispose();
        }
      }, options),
    20_000,
  );

  // The meetings the test above leaves to scheduling, each one forced: one caller is held between
  // its read and its write while the other completes.

  it("the exit reconciler reading the stop's removal as issued, and settling it once the stop has recorded it complete, settles nothing and says nothing", () =>
    test(async (s) => {
      const f = await stopping(s);
      const reading = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      try {
        let reconciler: Promise<unknown> | undefined;
        s.provider.beforeDeletion = async () => {
          f.noteDelete();
          s.provider.sandboxMissing = true;
        };
        // The stop has recorded the run stopped and has not recorded its removal complete: the
        // run is an ended executor nothing settled, and the exit reconciler looks at it.
        f.close.hooks.afterStopRecorded = async () => {
          f.close.hooks.afterStopRecorded = async () => {};
          reconciler = execute(f.close.reconcileExits()).then((exits) => f.reconciled.push(exits));
          await reading.promise;
        };
        // The reconciler has read the removal as issued, and is about to settle it from Boat's
        // 404: held there until the stop has recorded the removal complete.
        f.close.hooks.beforeSettleIssued = async () => {
          f.close.hooks.beforeSettleIssued = async () => {};
          expect(await execute(s.canonical.getByRunId(f.target.runId))).toMatchObject({
            deletionState: "deleting-issued",
          });
          reading.resolve();
          await completed.promise;
        };
        expect(await f.stopRun()).toBe("stopped");
        expect(await execute(s.canonical.getByRunId(f.target.runId))).toMatchObject({
          deletionState: "deleted",
        });
        completed.resolve();
        await reconciler;
        expect(f.reconciled).toEqual([0]);
        await stoppedCleanly(s, f);
      } finally {
        // A failed expectation above must not leave either caller held.
        reading.resolve();
        completed.resolve();
        await f.runtime.dispose();
      }
    }, options));

  it("the sweep's cleanup releasing the pin while the stop's removal is about to release it: released once, and neither says anything", () =>
    test(async (s) => {
      const f = await stopping(s);
      try {
        s.provider.beforeDeletion = async () => {
          f.noteDelete();
          s.provider.sandboxMissing = true;
        };
        // The stop's removal has released the tunnel slot, if the run had one, and is about to
        // release the pin: the sweep's cleanup of the same run runs to its end first.
        s.pin.beforeRelease = async () => {
          s.pin.beforeRelease = async () => {};
          expect((await execute(nativeConsumerRows(s.db, f.target.runId)))[0]?.state).not.toBe(
            "released",
          );
          await f.sweep();
          expect((await execute(nativeConsumerRows(s.db, f.target.runId)))[0]?.state).toBe(
            "released",
          );
        };
        expect(await f.stopRun()).toBe("stopped");
        // The sweep cleaned up, and its nudge found the stop under way and left the run to it.
        expect(f.swept).toEqual([[{ runId: f.target.runId, outcome: "busy" }]]);
        await stoppedCleanly(s, f);
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it.runIf(tunnelled)(
    "the sweep's cleanup arriving while the stop's removal is at the gateway leaves the release to it: one gateway removal, and neither says anything",
    () =>
      test(async (s) => {
        const f = await stopping(s);
        try {
          s.provider.beforeDeletion = async () => {
            f.noteDelete();
            s.provider.sandboxMissing = true;
          };
          // The stop's removal is removing the gateway, the slot not released yet: the sweep's
          // cleanup of the same run arrives, and runs to its end.
          s.gateway.beforeRemove = async () => {
            s.gateway.beforeRemove = async () => {};
            expect((await tunnelRecord(s, f.target)).released).not.toBe(true);
            await f.sweep();
            expect(s.gateway.removeCalls).toBe(1);
            expect((await tunnelRecord(s, f.target)).released).not.toBe(true);
          };
          expect(await f.stopRun()).toBe("stopped");
          // The cleanup found the stop's removal at the gateway, and its nudge found the stop
          // under way: both left the run to it.
          expect(f.swept).toEqual([[{ runId: f.target.runId, outcome: "busy" }]]);
          await stoppedCleanly(s, f);
        } finally {
          await f.runtime.dispose();
        }
      }, options),
  );

  it.runIf(tunnelled)(
    "the stop's removal arriving while the sweep's cleanup is at the gateway leaves the release to the sweep: the stop ends at once, one gateway removal, and neither says anything",
    () =>
      test(async (s) => {
        const f = await stopping(s);
        const removing = Promise.withResolvers<void>();
        const stopped = Promise.withResolvers<void>();
        try {
          let sweeping: Promise<void> | undefined;
          // The sweep's cleanup is removing the gateway on Boat's committed 404, held there
          // until the stop has ended.
          s.gateway.beforeRemove = async () => {
            s.gateway.beforeRemove = async () => {};
            removing.resolve();
            await stopped.promise;
          };
          s.provider.beforeDeletion = async () => {
            f.noteDelete();
            await f.reconcilerSeesItGone();
            sweeping = f.sweep();
            await removing.promise;
          };
          // The stop does not wait for the sweep: Boat no longer has the VM, and what it held is
          // being released.
          expect(await f.stopRun()).toBe("stopped");
          expect((await tunnelRecord(s, f.target)).released).not.toBe(true);
          expect(await released(s, f.target.runId)).toMatchObject({
            runtime: { status: "stopped" },
            pin: false,
            absent: true,
          });
          stopped.resolve();
          await sweeping;
          // The sweep released everything, and its nudge found the run stopped.
          expect(f.swept).toEqual([[{ runId: f.target.runId, outcome: "stopped" }]]);
          await stoppedCleanly(s, f);
        } finally {
          // A failed expectation above must not leave the sweep held at the gateway.
          stopped.resolve();
          await f.runtime.dispose();
        }
      }, options),
  );

  it("the adapter's stop resolves in the same call when Boat's 404 is committed while its operation still reads processing", () =>
    test(async (s) => {
      const f = await stopping(s);
      try {
        await discardedBy(s, f.target.runId);
        s.provider.deletionCompleted = false;
        const seen: unknown[] = [];
        s.provider.beforeDeletion = async () => {
          s.provider.sandboxMissing = true;
          f.close.clock.now += BOAT_INSPECT_READ_MS;
          seen.push(await f.adapter.inspect({ resourceId: f.target.sandboxId }));
        };
        expect(await f.adapter.stop({ resourceId: f.target.sandboxId })).toMatchObject({
          outcome: "stopped",
        });
        expect(seen).toEqual([{ state: "missing" }]);
        expect(s.provider.deleteCalls).toBe(1);
        expect(await released(s, f.target.runId)).toMatchObject(DISCHARGED);
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it("the adapter's stop resolves in the same call on Boat's 404 while its operation still reads processing, when nothing else reads the VM (the live run)", () =>
    test(async (s) => {
      const f = await stopping(s, 5_000);
      try {
        await discardedBy(s, f.target.runId);
        // Boat withdraws the VM at the DELETE and its operation stays `processing`. No reconciler
        // and no second stop reads the VM meanwhile: the removal reads it itself.
        s.provider.deletionCompleted = false;
        s.provider.beforeDeletion = async () => {
          s.provider.sandboxMissing = true;
        };
        expect(await f.adapter.stop({ resourceId: f.target.sandboxId })).toMatchObject({
          outcome: "stopped",
        });
        expect(s.provider.deleteCalls).toBe(1);
        // Boat's own 404, for a VM it had reported past creation: nothing else is absence.
        expect(await observedOf(s, f.target.runId)).toMatchObject({
          presence: "absent",
          basis: "not-found",
        });
        expect(await released(s, f.target.runId)).toMatchObject(DISCHARGED);
      } finally {
        await f.runtime.dispose();
      }
    }, options));

  it("still takes no failed read and no 404 of a VM never seen past creation for the deletion's completion", () =>
    test(async (s) => {
      const f = await stopping(s);
      try {
        const runId = f.target.runId;
        const seen: unknown[] = [];
        const inspect = () => {
          f.close.clock.now += BOAT_INSPECT_READ_MS;
          return f.adapter.inspect({ resourceId: f.target.sandboxId });
        };
        s.provider.deletionCompleted = false;
        s.provider.beforeDeletion = async () => {
          f.noteDelete();
          // Boat cannot be read, then answers 404 with nothing on record that it ever
          // reported the VM past creation: neither is absence, to any observer.
          s.provider.beforeSandboxRead = async () => {
            throw new Error("Boat is down");
          };
          seen.push(await inspect());
          s.provider.beforeSandboxRead = async () => {};
          await execute(forgetCreationSeen(s));
          s.provider.sandboxMissing = true;
          seen.push(await inspect());
        };
        // Boat accepted the deletion and has not finished it: deferred, with no error.
        expect(await f.stopRun()).toBe("draining");
        expect(f.close.errors()).toEqual([]);
        expect(seen).toEqual([{ state: "running" }, { state: "running" }]);
        expect(await observedAll(s)).toEqual([]);
        // The operation is on record and nothing is released while Boat says `processing`.
        expect(await vmOf(s, runId)).toMatchObject({
          phase: "deleting",
          removal: { kind: "operation", id: s.provider.deletionId, completed: false },
        });
        expect(await released(s, runId)).toMatchObject(NOTHING_RELEASED);
        if (tunnelled) expect((await tunnelRecord(s, f.target)).released).toBeUndefined();
        // The next pass polls the recorded operation, and it still reads `processing`.
        expect(await f.stopRun()).toBe("draining");
        expect(await released(s, runId)).toMatchObject(NOTHING_RELEASED);
        // Only Boat's own completed operation ends it, with no second DELETE.
        s.provider.deletionCompleted = true;
        expect(await f.stopRun()).toBe("stopped");
        expect(await vmOf(s, runId)).toMatchObject({
          removal: { kind: "operation", id: s.provider.deletionId, completed: true },
        });
        // Each later pass said that it asked the runtime again for a removal already issued: a
        // warning of the shared path's, for a deletion that outlasted its stop. Never an error.
        expect(f.close.errors()).toEqual([]);
        expect(
          f.close.logged.filter((line) => line.includes("so it is issued again")),
        ).toHaveLength(2);
        f.close.logged.length = 0;
        await stoppedCleanly(s, f);
      } finally {
        await f.runtime.dispose();
      }
    }, options));
});

describe.runIf(databaseUrl !== undefined)("Boat adapter recover", () => {
  const TOKEN = { SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN };
  /** A recovery as the sweep asks for one: with the kept token and a daemon that can recover. */
  const recoverOf = (f: Awaited<ReturnType<typeof adapterFixture>>, target: BoatExecutionTarget) =>
    f.adapter.recover({
      resourceId: target.sandboxId,
      runId: target.runId,
      secretEnv: TOKEN,
      daemonRecoveryBoot: true,
    });

  it("fences a launch that may have been pushed, hands the agent the capture token, and maps each of its answers", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const target = await stopLaunched(s);
        expect(await launchPhase(s, target.runId)).toBe("running");
        // The daemon is up: drain it.
        expect(await recoverOf(f, target)).toEqual({ outcome: "running" });
        // Held before the agent was asked: no launch can be pushed after this, whatever it says.
        expect(await launchPhase(s, target.runId)).toBe("held");
        expect(JSON.parse(s.guest.recoverBodies[0] ?? "{}")).toMatchObject({
          runId: target.runId,
          secretEnvJson: JSON.stringify(TOKEN),
        });
        // sealantd was started again in recovery mode on the VM's disk: drain it.
        s.guest.recovery = "restarted";
        expect(await recoverOf(f, target)).toEqual({ outcome: "restarted" });
        // The recovery boot exited 76: nothing was ever materialized. Only the daemon's own
        // line is repeated from the guest's words, never its free text.
        s.guest.recovery = "nothing-to-save";
        expect(await recoverOf(f, target)).toEqual({
          outcome: "nothing-to-save",
          detail: expect.stringContaining("recovery boot exited 76: nothing to save"),
        });
        // The agent recorded no launch on the boot it was bound on, and no launch is in flight.
        s.guest.recoveryBasis = "no-launch";
        expect(await recoverOf(f, target)).toEqual({
          outcome: "nothing-to-save",
          detail: expect.stringContaining("recorded no launch on the boot it was bound on"),
        });
        expect(recovers(s)).toBe(4);
        // Nothing was deleted or released by any answer: recovering removes nothing.
        expect(s.provider.deleteCalls).toBe(0);
        expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
      } finally {
        await f.runtime.dispose();
      }
    }));

  it.each(["recover-new-boot", "recover-binding-conflict", "recover-state-unknown"] as const)(
    "answers unsupported when the agent refuses with %s: the VM is kept",
    (reason) =>
      test(async (s) => {
        const f = await adapterFixture(s);
        try {
          const target = await stopLaunched(s);
          s.guest.recovery = reason;
          expect(await recoverOf(f, target)).toEqual({
            outcome: "unsupported",
            detail: expect.stringContaining(reason),
          });
          // A refusal authorizes no deletion.
          expect(await stopFailure(f.adapter.stop({ resourceId: target.sandboxId }))).toMatchObject(
            {
              code: "close-held",
            },
          );
          expect(s.provider.deleteCalls).toBe(0);
        } finally {
          await f.runtime.dispose();
        }
      }),
  );

  it.each(["daemon-stop-unverified", "docker-stop-unverified"] as const)(
    "answers unsupported when the agent cannot prove the workspace's processes stopped (503 %s)",
    (reason) =>
      test(async (s) => {
        const f = await adapterFixture(s);
        try {
          const target = await stopLaunched(s);
          s.guest.recoveryUnverified = reason;
          expect(await recoverOf(f, target)).toEqual({
            outcome: "unsupported",
            detail: expect.stringContaining(reason),
          });
          expect(s.provider.deleteCalls).toBe(0);
        } finally {
          await f.runtime.dispose();
        }
      }),
  );

  it("fails the attempt, never answering, when the agent's answer is malformed or lost", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const target = await stopLaunched(s);
        s.guest.malformedRecovery = true;
        await expect(recoverOf(f, target)).rejects.toThrow("invalid-reply");
        s.guest.malformedRecovery = false;
        s.guest.beforeHost = async () => {
          throw new Error("hosting failed");
        };
        await expect(recoverOf(f, target)).rejects.toThrow();
        expect(s.provider.deleteCalls).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("never takes the agent's no-launch for nothing to save while the launch that issued the push is in flight", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const target = await launched(s);
        // The launch's worker still owns the run; a stop was requested meanwhile.
        await execute(holdBoatLaunch(s.db, target.runId));
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        expect(await execute(s.repo.launchInFlight(target.runId))).toBe(true);
        s.guest.recovery = "nothing-to-save";
        s.guest.recoveryBasis = "no-launch";
        expect(await recoverOf(f, target)).toEqual({
          outcome: "unsupported",
          detail: expect.stringContaining("still in flight"),
        });
        expect(await stopFailure(f.adapter.stop({ resourceId: target.sandboxId }))).toMatchObject({
          code: "close-held",
        });
        // The launch is over: asked again, the same answer is taken.
        await execute(
          s.runtimes.upsertRuntimeInstance({
            runId: target.runId,
            status: "failed",
            releaseLaunch: true,
          }),
        );
        expect(await execute(s.repo.launchInFlight(target.runId))).toBe(false);
        expect(await recoverOf(f, target)).toMatchObject({ outcome: "nothing-to-save" });
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("answers nothing to save for a launch never pushed, from Core's own record: it aborts the execution and asks the agent nothing", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const target = await execute(s.allocations.prepare(s.input));
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        expect(await launchPhase(s, target.runId)).toBe("control");
        // No token and a daemon of unknown build: neither is needed when nothing ran.
        expect(
          await f.adapter.recover({ resourceId: target.sandboxId, daemonRecoveryBoot: null }),
        ).toEqual({
          outcome: "nothing-to-save",
          detail: expect.stringContaining("no launch was ever pushed"),
        });
        expect(await launchPhase(s, target.runId)).toBe("aborted");
        expect(recovers(s)).toBe(0);
        // The fence holds: a launch pushed now is refused.
        await expect(execute(s.executor.launch(target.runtimeInstanceId))).rejects.toThrow();
        expect(s.guest.starts).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("answers nothing to save for a VM never bound, and its removal's claim is what fences it", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        s.provider.bootReadUnavailable = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        await execute(s.runtimes.markStopRequested({ runId: f.input.runId, stopReason: "user" }));
        expect(await vmOf(s, f.input.runId)).toMatchObject({
          phase: "allocated",
          target: null,
        });
        expect(await f.adapter.recover({ resourceId: "bx_23456789" })).toEqual({
          outcome: "nothing-to-save",
          detail: expect.stringContaining("never bound"),
        });
        expect(recovers(s)).toBe(0);
        expect(await f.adapter.stop({ resourceId: "bx_23456789" })).toMatchObject({
          outcome: "stopped",
        });
        // Claimed before the DELETE: a launch that tried to bind it after that would have lost.
        expect(await vmOf(s, f.input.runId)).toMatchObject({ phase: "deleted" });
        expect(s.provider.deleteCalls).toBe(1);
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("fences and recovers nothing for a run that is not stopping, a VM Boat cannot be read for, or one it holds no allocation for", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const target = await launched(s);
        // Live: nothing is fenced.
        expect(await recoverOf(f, target)).toEqual({
          outcome: "unsupported",
          detail: expect.stringContaining("is not stopping"),
        });
        expect(await launchPhase(s, target.runId)).toBe("running");
        await execute(s.runtimes.markStopRequested({ runId: target.runId, stopReason: "user" }));
        // Boat does not answer, or answers with a VM that is not the run's: nothing is concluded.
        s.provider.beforeSandboxRead = async () => {
          throw new Error("Boat is down");
        };
        await expect(recoverOf(f, target)).rejects.toThrow("close-unavailable");
        s.provider.beforeSandboxRead = async () => {};
        s.provider.foreign = true;
        await expect(recoverOf(f, target)).rejects.toThrow("close-unavailable");
        s.provider.foreign = false;
        expect(await launchPhase(s, target.runId)).toBe("running");
        expect(await f.adapter.recover({ resourceId: "bx_3456789a" })).toMatchObject({
          outcome: "unsupported",
        });
        expect(recovers(s)).toBe(0);
        // Boat's own word that the VM is gone is the only `missing`.
        s.provider.sandboxMissing = true;
        expect(await recoverOf(f, target)).toEqual({ outcome: "missing" });
      } finally {
        await f.runtime.dispose();
      }
    }));
});

describe.runIf(databaseUrl !== undefined)("Boat adapter locate", () => {
  it("names the VM of a launch that has one, nothing where Boat was never asked or holds none, and refuses to say while a create is unresolved", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const runId = s.input.consumer.runId;
        // No allocation at all: this adapter knows no executor of the run.
        expect(await f.adapter.locate({ runId })).toBeUndefined();
        const reserved = await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
        // Reserved: create was never issued.
        expect(await f.adapter.locate({ runId })).toBeUndefined();
        const issued = await execute(s.repo.issueCreate(reserved.runId));
        // Issued with no VM identity: Boat may hold one. Unknown is never taken for none.
        await expect(f.adapter.locate({ runId })).rejects.toThrow("launch-held");
        const allocated = await execute(s.repo.adopt(issued.runId, "bx_23456789"));
        expect(await f.adapter.locate({ runId })).toEqual({
          adapter: "boat",
          resourceId: "bx_23456789",
          reference: runId,
        });
        // Another deployment's adapter knows nothing of it.
        expect(
          await new BoatRuntimeAdapter({ deploymentId: "other", runtime: f.runtime }).locate({
            runId,
          }),
        ).toBeUndefined();
        expect(boatRunVmPhase(allocated)).toBe("allocated");
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("leaves a launch whose create is unresolved to the allocation sweep: the shared sweep neither adopts nor ends it", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const runId = s.input.consumer.runId;
        const reserved = await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
        await execute(s.repo.issueCreate(reserved.runId));
        const Repos = Layer.merge(WorkspaceRuntimeInstanceRepoLive, WorkspaceAttemptRepoLive).pipe(
          Layer.provide(Layer.succeed(SealantDB, s.db)),
        );
        expect(
          await execute(
            adoptStrandedLaunchesEffect({
              runtimeAdapters: [f.adapter],
              unownedGraceMs: 0,
              lostLaunchGraceMs: 0,
            }).pipe(Effect.provide(Repos), Effect.provide(Logger.layer([]))),
          ),
        ).toEqual([]);
        // Not ended as lost: a VM Boat accepted would be orphaned by that.
        expect(await execute(s.runtimes.getRuntimeInstanceByRunId(runId))).toMatchObject({
          status: "pending",
          resourceId: null,
          errorCode: null,
        });
      } finally {
        await f.runtime.dispose();
      }
    }));
});

describe.runIf(databaseUrl !== undefined)("Boat convergence: what stays Boat's own", () => {
  it("ends a launch stopped before its create was ever issued: Boat was never asked, so nothing is deleted and its pin is released", () =>
    test(async (s) => {
      const runId = s.input.consumer.runId;
      await execute(s.repo.reserve(s.input, AGENT_MANIFEST_DIGEST));
      await execute(s.canonical.storeCaptureToken({ runId, sealed: "sealed-token" }));
      await execute(s.runtimes.markStopRequested({ runId, stopReason: "user" }));
      // The allocation sweep finds the run stopped and holds the reservation unissued.
      await execute(s.allocations.reconcile({ limit: 20 }));
      expect(await vmOf(s, runId)).toMatchObject({
        phase: "held",
        reason: "run-stopped",
        sandboxId: null,
      });
      const paths = await execute(s.final([]));
      expect((await execute(paths.sweep({ limit: 20 }))).entries).toEqual([
        { runId, outcome: "cleaned" },
      ]);
      expect(s.provider.creates).toHaveLength(0);
      expect(s.provider.deleteCalls).toBe(0);
      expect(await vmOf(s, runId)).toMatchObject({
        phase: "deleted",
        removal: { kind: "never-created", completed: true },
      });
      expect((await runOf(s, runId)).absentBasis).toBe("never-created");
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(runId))).toMatchObject({
        status: "stopped",
        stopReason: "user",
        resourceId: null,
      });
      // Nothing ran, so nothing was to save; the kept capture token goes with it.
      expect(await execute(s.canonical.getByRunId(runId))).toMatchObject({
        state: "gone",
        retainedAt: null,
        captureTokenSealed: null,
      });
      expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("released");
      // Settled: its row, its pin, its stop and its capture record are all ended, so a later pass
      // does not read it.
      expect(await execute(paths.sweep({ limit: 20 }))).toEqual({ entries: [] });
    }));

  it("removes a VM adopted by its labels after its run was already recorded stopped: never bound, so nothing ran on it", () =>
    test(async (s) => {
      const f = await adapterFixture(s);
      try {
        const runId = f.input.runId;
        // Its create reply was lost, its owner discarded the launch (the session ended, the
        // allocation stayed held), and discovery then found the VM Boat had made.
        s.provider.bootReadUnavailable = true;
        await expect(f.adapter.launch(f.input)).rejects.toBeInstanceOf(LaunchRetainedError);
        await execute(s.runtimes.markStopped({ runId, stopReason: "user" }));
        expect(await vmOf(s, runId)).toMatchObject({
          phase: "allocated",
          target: null,
        });
        expect((await execute(f.close.sweep({ limit: 20 }))).entries).toEqual([
          { runId, outcome: "cleaned" },
        ]);
        expect(s.provider.deleteCalls).toBe(1);
        expect(s.guest.starts).toBe(0);
        expect(await vmOf(s, runId)).toMatchObject({ phase: "deleted" });
        expect((await execute(nativeConsumerRows(s.db, runId)))[0]?.state).toBe("released");
      } finally {
        await f.runtime.dispose();
      }
    }));

  it("does not nudge a run while another caller's first DELETE is out: no drain is started, and the nudge resumes once that claim has lapsed", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      const runId = target.runId;
      const paths = await execute(s.final([savedStatus()]));
      // A caller fenced the run and claimed the DELETE. Boat has not answered it: no operation is
      // on record, and nobody but that caller knows whether it was sent.
      await execute(s.executor.hold(target));
      await execute(s.tunnels.freeze(await tunnelRecord(s, target), randomUUID()));
      await execute(claimBoatDeletionAgo(s.db, runId, 0));
      for (const pass of [1, 2])
        expect((await execute(paths.sweep({ limit: 20 }))).entries, `pass ${String(pass)}`).toEqual(
          [{ runId, outcome: "draining" }],
        );
      // The shared stop was not asked: no FINAL to a VM that is being deleted, and no DELETE.
      expect(paths.daemon.calls).toEqual([]);
      expect(paths.connects).toEqual([]);
      expect(s.provider.deleteCalls).toBe(0);
      expect(await released(s, runId)).toMatchObject(NOTHING_RELEASED);
      // The claim's caller vanished and its claim lapsed: the nudge asks the shared stop again,
      // which drains FINAL and deletes the VM.
      await execute(claimBoatDeletionAgo(s.db, runId, BOAT_REMOVAL_CLAIM_MS + 1));
      expect((await execute(paths.sweep({ limit: 20 }))).entries).toEqual([
        { runId, outcome: "stopped" },
      ]);
      expect(paths.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
      expect(s.provider.deleteCalls).toBe(1);
      expect(await released(s, runId)).toMatchObject(REMOVED);
    }));

  it("never deletes a VM a daemon may have run on for a run already recorded stopped: held, and said so", () =>
    test(async (s) => {
      const target = await launched(s);
      await execute(s.runtimes.markStopped({ runId: target.runId, stopReason: "user" }));
      s.gateway.allowRemoval = true;
      const paths = await execute(s.final([savedStatus()]));
      for (const pass of [1, 2])
        expect((await execute(paths.sweep({ limit: 20 }))).entries, `pass ${String(pass)}`).toEqual(
          [{ runId: target.runId, outcome: "held" }],
        );
      expect(s.provider.deleteCalls).toBe(0);
      expect(paths.daemon.calls).toEqual([]);
      expect(await released(s, target.runId)).toMatchObject({ pin: false, absent: false });
    }));

  it("says once an hour that a VM is kept, for as long as it is, and never discards it", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      // A FINAL that never completes.
      const paths = await execute(s.final([captureStatus({ complete: false })]));
      // The sweep says it as a warning, which the paths record.
      const convergenceLog = paths.logged;
      const kept = () => convergenceLog.filter((line) => line.includes("is kept")).length;
      const pass = (at: number) =>
        execute(
          Effect.gen(function* () {
            yield* TestClock.setTime(at);
            return yield* paths.sweep({ limit: 20 });
          }).pipe(Effect.provide(TestClock.layer())),
        );
      const start = Date.now();
      // Twenty passes over ten minutes: the VM is kept on each, and said so once.
      for (let tick = 0; tick < 20; tick += 1)
        expect((await pass(start + tick * 30_000)).entries).toEqual([
          { runId: target.runId, outcome: "kept" },
        ]);
      expect(kept()).toBe(1);
      expect(convergenceLog.find((line) => line.includes("is kept"))).toContain(
        "until its final capture is confirmed saved or its owner discards it",
      );
      // An hour on: said again.
      await pass(start + BOAT_KEPT_REPORT_MS);
      expect(kept()).toBe(2);
      // Still there, however long: nothing discards it.
      await pass(start + 30 * 24 * BOAT_KEPT_REPORT_MS);
      expect(kept()).toBe(3);
      expect(s.provider.deleteCalls).toBe(0);
      expect(await released(s, target.runId)).toMatchObject(NOTHING_RELEASED);
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(target.runId))).toMatchObject({
        stopReason: "user",
        removedAt: null,
      });
    }));
});

describe.runIf(databaseUrl !== undefined)("Boat stop across a worker restart", () => {
  /** A ready session whose stop a worker began, and the paths of the worker that died doing it. */
  const begun = async (s: AllocationFixture, script: readonly CaptureDaemonScriptEntry[]) => {
    const dead = await execute(s.final(script));
    const target = await readyRun(s);
    s.gateway.allowRemoval = true;
    return { dead, target, runId: target.runId };
  };
  /** The run ended as an undisturbed stop ends, with one FINAL at most per worker and one DELETE. */
  const ended = async (s: AllocationFixture, runId: string) => {
    expect(s.provider.deleteCalls).toBe(1);
    expect(await released(s, runId)).toMatchObject(REMOVED);
    expect(await execute(s.canonical.getByRunId(runId))).toMatchObject({
      state: "stopped",
      deletionState: "deleted",
      retainedAt: null,
    });
  };
  const expireHold = (s: AllocationFixture, runId: string) =>
    execute(lapseCaptureDeletionHold(s.db, runId));

  it("before FINAL: the next worker waits out the dead one's claim, then drains and deletes", () =>
    test(async (s) => {
      const { runId } = await begun(s, []);
      // The dead worker took the run's drain and recorded the stop, and no more.
      const died = databaseCaptureDrainLedger({ db: s.db, owner: "dead-worker", leaseMs: 400 });
      expect(await execute(died.claim(runId))).toBeDefined();
      await execute(s.runtimes.markStopRequested({ runId, stopReason: "user" }));
      const restarted = await execute(s.final([savedStatus()]));
      expect(await execute(restarted.stop({ runId }))).toBe("busy");
      expect(restarted.daemon.calls).toEqual([]);
      expect(s.provider.deleteCalls).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await execute(restarted.stop({ runId }))).toBe("stopped");
      expect(restarted.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
      await ended(s, runId);
    }));

  it("FINAL sent and its answer never recorded: nothing rests on what it may have said, and FINAL is asked again", () =>
    test(async (s) => {
      const { dead, runId } = await begun(s, []);
      await execute(s.runtimes.markStopRequested({ runId, stopReason: "user" }));
      // The request went out under its fence, and the worker died before any answer was recorded.
      expect(await execute(dead.ledger.openObservation(runId, 400))).toBeDefined();
      const restarted = await execute(s.final([savedStatus()]));
      // While that observation may still be answered, what is on record is not known current.
      expect(await execute(restarted.stop({ runId }))).toBe("kept");
      expect(restarted.daemon.flushRequests.length).toBeGreaterThan(0);
      expect(s.provider.deleteCalls).toBe(0);
      expect(await released(s, runId)).toMatchObject(NOTHING_RELEASED);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await execute(restarted.stop({ runId }))).toBe("stopped");
      await ended(s, runId);
    }));

  it("authorized and not issued: nothing was asked of Boat, and the next worker decides again once the hold lapses", () =>
    test(async (s) => {
      const { dead, runId } = await begun(s, []);
      await execute(s.runtimes.markStopRequested({ runId, stopReason: "user" }));
      await execute(dead.ledger.recordStatus(runId, savedStatus(), Date.now()));
      const read = await execute(dead.ledger.read(runId));
      const authorized = await execute(
        dead.ledger.authorizeDeletion(
          runId,
          read.readable ? (read.entry?.evidenceVersion ?? 0) : -1,
        ),
      );
      expect(authorized.kind).toBe("authorized");
      const restarted = await execute(s.final([savedStatus()]));
      // The dead worker's hold is live: no observation is admitted under it, nothing is removed.
      expect(await execute(restarted.stop({ runId }))).toBe("draining");
      expect(s.provider.deleteCalls).toBe(0);
      expect(await vmOf(s, runId)).toMatchObject({ phase: "bound" });
      await expireHold(s, runId);
      expect(await execute(restarted.stop({ runId }))).toBe("stopped");
      expect(restarted.daemon.flushRequests.map((request) => request?.kind)).toEqual(["final"]);
      await ended(s, runId);
    }));

  it("issued with the DELETE's outcome unknown: no second DELETE while its claim may still be in flight, then one, after reading the VM again", () =>
    test(async (s) => {
      const { dead, target, runId } = await begun(s, []);
      await execute(s.runtimes.markStopRequested({ runId, stopReason: "user" }));
      await execute(dead.ledger.recordStatus(runId, savedStatus(), Date.now()));
      const read = await execute(dead.ledger.read(runId));
      const authorized = await execute(
        dead.ledger.authorizeDeletion(
          runId,
          read.readable ? (read.entry?.evidenceVersion ?? 0) : -1,
        ),
      );
      if (authorized.kind !== "authorized") throw new Error(authorized.kind);
      expect(await execute(dead.ledger.issueDeletion(runId, authorized.ticket))).toBe(true);
      // It fenced the run and claimed the DELETE, and nobody knows whether it was sent.
      await execute(s.executor.hold(target));
      await execute(s.tunnels.freeze(await tunnelRecord(s, target), randomUUID()));
      await execute(claimBoatDeletionAgo(s.db, runId, 0));
      const restarted = await execute(s.final(["unreachable"]));
      // The dead worker's hold on the removal is live: the run is left to it.
      expect(await execute(restarted.stop({ runId }))).toBe("busy");
      expect(s.provider.deleteCalls).toBe(0);
      // Its hold lapsed. Boat still has the VM and the evidence stands: issued again. The claim
      // on the DELETE has not lapsed, so nothing is sent yet.
      await expireHold(s, runId);
      expect(await execute(restarted.stop({ runId }))).toBe("draining");
      expect(s.provider.deleteCalls).toBe(0);
      expect(await released(s, runId)).toMatchObject(NOTHING_RELEASED);
      // The claim lapsed too: the exact owned VM is read again and the one DELETE is sent.
      await execute(claimBoatDeletionAgo(s.db, runId, BOAT_REMOVAL_CLAIM_MS + 1));
      expect(await execute(restarted.stop({ runId }))).toBe("stopped");
      // No guest was asked again: the FINAL it was authorized on still stands.
      expect(restarted.daemon.calls).toEqual([]);
      await ended(s, runId);
    }));

  it("Boat's operation recorded complete and nothing released: the next worker releases, with no second DELETE", () =>
    test(async (s) => {
      const { dead, runId } = await begun(s, [savedStatus()]);
      s.provider.deletionCompleted = false;
      expect(await execute(dead.stop({ runId }))).toBe("draining");
      // Boat completed it, and the worker died with that recorded and nothing released.
      s.provider.deletionCompleted = true;
      const recorded = await runOf(s, runId);
      if (recorded.deletionOperationId === null || recorded.sandboxId === null)
        throw new Error("missing operation");
      await execute(
        s.repo.recordDeletion(runId, {
          id: recorded.deletionOperationId,
          sandboxId: recorded.sandboxId,
          completed: true,
        }),
      );
      expect(await released(s, runId)).toMatchObject(ABSENT_NOT_RELEASED);
      const restarted = await execute(s.final(["unreachable"]));
      expect(await execute(restarted.stop({ runId }))).toBe("stopped");
      expect(restarted.daemon.calls).toEqual([]);
      await ended(s, runId);
    }));

  it("the adapter's stop returned and the worker died before recording anything: the next worker finds the VM gone and records the stop", () =>
    test(async (s) => {
      const { dead, runId } = await begun(s, [savedStatus()]);
      dead.hooks.afterAdapterStop = async () => {
        throw new Error("the worker died here");
      };
      await expect(execute(dead.stop({ runId }))).rejects.toThrow("the worker died here");
      // Boat no longer has the VM and what it held is released; the run still reads ready.
      expect(s.provider.deleteCalls).toBe(1);
      expect(await execute(s.runtimes.getRuntimeInstanceByRunId(runId))).toMatchObject({
        status: "ready",
        stopReason: "user",
        removedAt: null,
      });
      expect((await execute(s.canonical.getByRunId(runId)))?.deletionState).toBe("deleting-issued");
      s.provider.sandboxMissing = true;
      const restarted = await execute(s.final(["unreachable"]));
      expect(await execute(restarted.stop({ runId }))).toBe("stopped");
      expect(restarted.daemon.calls).toEqual([]);
      expect(restarted.errors()).toEqual([]);
      await ended(s, runId);
    }));
});

describe.runIf(databaseUrl !== undefined)("Boat run row: one guarded statement per fact", () => {
  it("lets the fence and the launch push compete on the row: fenced first, no push is ever issued; issued first, the fence says a daemon may have run and keeps its bearer", () =>
    test(async (s) => {
      const target = await execute(s.allocations.prepare(s.input));
      await execute(s.executor.stage(target.runId, Redacted.make(launchMaterial())));
      await execute(s.executor.recordIsolation(target, ISOLATION));
      // Both at once, as a stop meeting a launch: exactly one order is recorded, and it decides.
      const [fenced, issued] = await Promise.allSettled([
        execute(s.repo.fence(target.runId)),
        execute(s.repo.issueLaunch(target.runId)),
      ]);
      if (fenced.status !== "fulfilled") throw new Error("the fence always lands");
      const run = await runOf(s, target.runId);
      expect(run.fencedAt).toBeInstanceOf(Date);
      if (issued.status === "fulfilled") {
        // The push won: nothing reads this as never launched, and the bearer stays for FINAL.
        expect(boatRunLaunchPhase(run)).toBe("held");
        expect(run.launchIssuedAt).toBeInstanceOf(Date);
        expect(run.sealedControl).not.toBeNull();
      } else {
        // The fence won: the push was refused, and the bearer and the launch are erased.
        expect(String(issued.reason)).toContain("stale-transition");
        expect(boatRunLaunchPhase(run)).toBe("aborted");
        expect(run.launchIssuedAt).toBeNull();
        expect(run.sealedControl).toBeNull();
        expect(run.sealedLaunch).toBeNull();
      }
      // Either way nothing is pushed from here on, and a second fence changes nothing.
      await expect(execute(s.repo.issueLaunch(target.runId))).rejects.toThrow("stale-transition");
      await expect(execute(s.executor.launch(target.runId))).rejects.toThrow();
      expect(await execute(s.repo.fence(target.runId))).toEqual(run);
      expect(s.guest.starts).toBe(0);
    }));

  it("keeps a pushed launch's bearer through a fence, and never lets a fenced run be bound, exchanged or staged again", () =>
    test(async (s) => {
      const target = await launched(s);
      const before = await runOf(s, target.runId);
      const fenced = await execute(s.repo.fence(target.runId));
      expect(boatRunLaunchPhase(fenced)).toBe("held");
      expect(fenced.sealedControl).toBe(before.sealedControl);
      expect(fenced.sealedLaunch).toBe(before.sealedLaunch);
      await expect(execute(s.repo.acceptLaunch(target.runId))).rejects.toThrow("stale-transition");
      await expect(
        execute(s.repo.isolate(target.runId, { ...ISOLATION, tunnelReceipt: "a".repeat(64) })),
      ).rejects.toThrow("stale-transition");
      await expect(
        execute(s.repo.bind(target.runId, { ...target, bootId: randomUUID() })),
      ).rejects.toThrow("stale-transition");
    }));

  it("records Boat's deletion operation and its 404 on one row in either order: the loser finds the row where it wanted it", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      await execute(s.repo.fence(target.runId));
      const operation = {
        id: s.provider.deletionId,
        sandboxId: target.sandboxId,
        completed: false,
      };
      // The 404 first: the operation is not written over an absence, and nothing fails.
      const absent = await execute(s.repo.recordNotFound(target.runId, target.sandboxId));
      expect(absent).toMatchObject({ absentBasis: "not-found", deletionOperationId: null });
      expect(await execute(s.repo.recordDeletion(target.runId, operation))).toEqual(absent);
      expect(
        await execute(s.repo.recordDeletion(target.runId, { ...operation, completed: true })),
      ).toEqual(absent);
      // The first absence stands, whoever reads the VM afterwards.
      expect(await execute(s.repo.seen(target.runId, target.sandboxId, true))).toEqual(absent);
      expect(await execute(s.repo.recordNotFound(target.runId, target.sandboxId))).toEqual(absent);
    }));

  it("records Boat's 404 after its deletion operation was recorded, and both at once without a failure", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      await execute(s.repo.fence(target.runId));
      const operation = {
        id: s.provider.deletionId,
        sandboxId: target.sandboxId,
        completed: false,
      };
      const [recorded, gone] = await Promise.all([
        execute(s.repo.recordDeletion(target.runId, operation)),
        execute(s.repo.recordNotFound(target.runId, target.sandboxId)),
      ]);
      expect(gone.sandboxId).toBe(target.sandboxId);
      expect(recorded.sandboxId).toBe(target.sandboxId);
      // Whichever landed first, the row ends absent on Boat's 404; a completion read later does
      // not rewrite how Core came to know.
      expect(await runOf(s, target.runId)).toMatchObject({
        absentBasis: "not-found",
        absentAt: expect.any(Date),
      });
      expect(
        await execute(s.repo.recordDeletion(target.runId, { ...operation, completed: true })),
      ).toMatchObject({ absentBasis: "not-found" });
    }));

  it("refuses an issue time in the future, whoever writes it, and measures a create's age by the database's clock", () =>
    test(async (s) => {
      const run = await reserve(s);
      await expect(
        execute(corruptBoatRun(s.db, run.runId, { createIssuedAt: new Date(Date.now() + 60_000) })),
      ).rejects.toThrow();
      expect((await runOf(s, run.runId)).createIssuedAt).toBeNull();
      expect(await execute(s.repo.createAgeMs(run.runId))).toBeUndefined();
      const issued = await execute(s.repo.issueCreate(run.runId));
      expect(issued.createIssuedAt).toBeInstanceOf(Date);
      const age = await execute(s.repo.createAgeMs(run.runId));
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(60_000);
      // Issued once: a second issuer gets nothing, and the issue time does not move.
      await expect(execute(s.repo.issueCreate(run.runId))).rejects.toThrow("stale-transition");
      expect((await runOf(s, run.runId)).createIssuedAt).toEqual(issued.createIssuedAt);
      await expect(
        execute(corruptBoatRun(s.db, run.runId, { createIssuedAt: new Date(Date.now() + 60_000) })),
      ).rejects.toThrow();
      await execute(backdateBoatCreate(s.db, run.runId, 25 * HOUR));
      expect(await execute(s.repo.createAgeMs(run.runId))).toBeGreaterThanOrEqual(25 * HOUR);
    }));
});

describe.runIf(databaseUrl !== undefined)("Boat sealed bearers at worker start", () => {
  /** The check as the worker runs it, with what it logged at error level. */
  const verify = async (s: AllocationFixture) => {
    const log = logRecorder();
    const result = await execute(
      verifyBoatBearers("test").pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(BoatRunRepo, s.repo),
            Layer.succeed(BoatExecution, s.executor),
            log.recorder,
          ),
        ),
      ),
    );
    return { ...result, errors: log.logged.filter((line) => line.startsWith("Error")) };
  };

  it("opens every live run's bearer once, asks Boat and the guest nothing, and says by run which do not open, without failing", () =>
    test(async (s) => {
      const target = await launched(s);
      const asked = { boat: s.provider.reads.length, guest: s.guest.actions.length };
      expect(await verify(s)).toEqual({ checked: 1, unopened: [], errors: [] });
      // A bearer sealed for another purpose, as a row whose seal no longer matches: it does
      // not open, and the worker says so for this run and goes on.
      const run = await runOf(s, target.runId);
      if (run.sealedLaunch === null) throw new Error("missing launch");
      await execute(corruptBoatRun(s.db, target.runId, { sealedControl: run.sealedLaunch }));
      const failed = await verify(s);
      expect(failed).toMatchObject({ checked: 1, unopened: [target.runId] });
      expect(failed.errors).toEqual([
        expect.stringContaining(`run ${target.runId}: its sealed control bearer does not open`),
      ]);
      expect(failed.errors.join("\n")).not.toContain(run.sealedLaunch);
      // Ciphertext that is not the cipher's at all reads the same way.
      await execute(corruptBoatRun(s.db, target.runId, { sealedControl: "not-ciphertext" }));
      expect(await verify(s)).toMatchObject({ checked: 1, unopened: [target.runId] });
      expect(s.provider.reads.length).toBe(asked.boat);
      expect(s.guest.actions.length).toBe(asked.guest);
    }));

  it("checks a fenced session still awaiting its FINAL, and no run Boat no longer has a VM for or that never sealed a bearer", () =>
    test(async (s) => {
      const target = await stopLaunched(s);
      await execute(s.executor.hold(target));
      expect(await verify(s)).toMatchObject({ checked: 1, unopened: [] });
      // Boat no longer has the VM: its bearer reaches nothing, and is not checked.
      await execute(s.repo.recordNotFound(target.runId, target.sandboxId));
      expect(await verify(s)).toEqual({ checked: 0, unopened: [], errors: [] });
    }));
});
