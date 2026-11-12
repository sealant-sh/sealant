import { randomUUID } from "node:crypto";

import {
  CredentialCipher,
  credentialCipherLayer,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  createSealantDB,
  SealantDB,
  CredentialPlacementRepoLive,
  type ResourceWorkspaceLink,
  ResourceInstanceRepo,
  ResourceInstanceRepoLive,
  ResourceDomainRepo,
  ResourceDomainRepoLive,
  WorkspaceCredentialHomeRepoLive,
  type DB,
} from "@sealant/db";
import { createJobQueueService } from "@sealant/jobs";
import { createGitHubSourceIntegration } from "@sealant/source-integrations";
import { deleteExpiredRunRecords } from "@sealant/telemetry";
import type { WorkerEnv } from "@sealant/validators/env";
import {
  BOAT_RESOURCE_PASS,
  boatConnectMaterial,
  boatDrainConnectMaterial,
  boatAllocationObligations,
  boatConvergenceObligations,
  boatKeptReports,
  boatResourceObligations,
  DockerResourceRuntime,
  KubernetesCallerRuntime,
  parseResourceCallers,
  makeResourceReconciler,
  repositorySubnets,
  resourceSubnetPools,
  consumeBoatResourceLinkJobs,
  consumeRunExecJobs,
  sweepRunExecJobRows,
  sweepCredentialPlacements,
  type PlacementSweepBackoff,
  consumeWorkspaceBuildJobs,
  consumeWorkspaceLifecycleJobs,
  databaseCaptureDrainLedger,
  notifyingRetention,
  DEFAULT_CAPTURE_DRAIN_SETTINGS,
  createKubernetesLaunchMaterialStager,
  createLiveKubernetesApi,
  createLiveKubernetesBuildApi,
  createLocalDockerImageStore,
  createZotRegistryClient,
  CloudflareRuntimeAdapter,
  cloudflareRuntimeConfigFromEnv,
  createDockerWorkspaceImageBuilder,
  dockerDaemonImagePlatform,
  DockerRuntimeAdapter,
  K3sRuntimeAdapter,
  K8sRuntimeAdapter,
  MicrovmEndpointTokens,
  MicrovmRuntimeAdapter,
  MicrovmWorkspaceImageBuilder,
  createLiveMicrovmApi,
  createLiveMicrovmImageApi,
  loadMicrovmContextFiles,
  createS3MicrovmArtifactStore,
  microvmRuntimeConfigFromEnv,
  parseDockerRegistryMirrors,
  parseDockerVolumeMappings,
  preserveBeforeDeadline,
  processImagePlatform,
  processWorkspaceBuildJob,
  processWorkspaceStop,
  reapExpiredWorkspaces,
  reapOrphanedKubernetesResources,
  kubernetesBuildConfigFromEnv,
  kubernetesRuntimeConfigFromEnv,
  KubernetesWorkspaceImageBuilder,
  reapStaleWorkspaceBuildJobs,
  reapWorkspaceImages,
  reconcileRuntimeExits,
  recoverRetainedExecutors,
  runBuildkitCommand,
  sweepStaleBuildContexts,
  targetDerivationOptionsFromEnv,
  watchRuntimeExits,
  UnsupportedImagePlatformError,
  type BoatSharedStop,
  type CaptureDrainSettings,
  type RegistryClient,
  type RuntimeAdapterId,
  type RuntimeAdapterLifecycle,
} from "@sealant/workspaces";
import { Effect, Layer } from "effect";

import { assembleBoat, type BoatWorkerStack } from "./boat-assembly.js";
import { processRunExecJob } from "./process-run-exec-job.js";
import {
  CLAUDE_SESSION_REFRESH_INTERVAL_MS,
  refreshClaudeSessionCredentials,
} from "./refresh-claude-sessions.js";
import {
  CODEX_SESSION_REFRESH_INTERVAL_MS,
  refreshCodexSessionCredentials,
} from "./refresh-codex-sessions.js";

// Build scratch older than this is a leftover, never a build in flight.
const STALE_BUILD_CONTEXT_AGE_MS = 6 * 60 * 60 * 1000;
const IMAGE_RETENTION_BOOT_DELAY_MS = 30_000;
/** Run-record retention runs hourly, its first pass five minutes after boot. */
const RECORD_RETENTION_BOOT_DELAY_MS = 5 * 60 * 1000;
const RECORD_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** The run-exec job sweep runs hourly, its first pass a minute after boot. */
const RUN_EXEC_JOB_SWEEP_BOOT_DELAY_MS = 60 * 1000;
const RUN_EXEC_JOB_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/**
 * How many retained-executor recovery sweeps may run at once (review 9 #8). Each executor's
 * attempt holds its own recovery claim, so overlapping sweeps never recover one executor twice.
 */
const MAX_OVERLAPPING_RECOVERY_SWEEPS = 4;
// A lifecycle stop waits this long on a capture queue, inside the queue's 15-minute active
// window; a drain that needs longer is finished by the reaper (the stop intent is durable).
const LIFECYCLE_STOP_DRAIN_BUDGET_MS = 10 * 60 * 1000;
/**
 * How long a stop of a retained launch, or one Boat's convergence sweep asks for, waits on one
 * executor's capture queue (the expiry reaper's own budget per executor).
 */
const RETAINED_LAUNCH_DRAIN_BUDGET_MS = 60_000;

const createDatabaseFromEnv = async (env: WorkerEnv): Promise<DB> => {
  return createSealantDB(env.DATABASE_URL);
};

/**
 * Materialize the connected-account credential cipher from SEALANT_CREDENTIALS_KEY. Undefined
 * when the key is unset — launches without credentialRefs are unaffected, and launches WITH
 * credentialRefs fail with a typed misconfiguration error inside the job pipeline (never a
 * silent no-auth workspace). The env schema already validated the key decodes to 32 bytes, so
 * building the layer here cannot fail in practice; a bad key would throw loudly at startup.
 */
const createCredentialCipherFromEnv = (env: WorkerEnv): CredentialCipherService | undefined => {
  if (env.SEALANT_CREDENTIALS_KEY === undefined) {
    return undefined;
  }

  // The service key is itself an Effect that resolves the service from context.
  return Effect.runSync(
    Effect.provide(CredentialCipher, credentialCipherLayer({ key: env.SEALANT_CREDENTIALS_KEY })),
  );
};

/**
 * Starts the workspace worker loop and returns a graceful shutdown handle.
 */
/**
 * What this worker's Docker daemon builds for. A daemon that does not answer yet (it is still
 * starting) leaves the worker's own architecture, which is the daemon's wherever the two share a
 * host; one that answers with an architecture images are not built for stops the worker.
 */
const dockerImagePlatform = () =>
  dockerDaemonImagePlatform(runBuildkitCommand).catch((error: unknown) => {
    if (error instanceof UnsupportedImagePlatformError) throw error;
    const platform = processImagePlatform();
    console.warn(
      "The Docker daemon did not name its architecture; workspace images are built for this machine's",
      {
        platform,
        error: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
      },
    );
    return platform;
  });

export const startWorkspaceWorker = async (env: WorkerEnv) => {
  const db = await createDatabaseFromEnv(env);
  // The job queue lives in the same Postgres database as the control plane (pg-boss); one
  // shared handle per process, closed on shutdown.
  const jobs = createJobQueueService(env.DATABASE_URL);
  const credentialCipher = createCredentialCipherFromEnv(env);
  // Image store: the local Docker Engine unless a registry is configured. Single-host installs
  // build, tag, and launch on one daemon; Kubernetes installs must push to a registry (BuildKit
  // and kubelet are different machines), which `kubernetesBuildConfigFromEnv` enforces below.
  const registryClient: RegistryClient =
    env.REGISTRY_BASE_URL === undefined
      ? createLocalDockerImageStore()
      : createZotRegistryClient({
          baseUrl: env.REGISTRY_BASE_URL,
          ...(env.REGISTRY_PUSH_REGISTRY === undefined
            ? {}
            : { pushRegistry: env.REGISTRY_PUSH_REGISTRY }),
          ...(env.REGISTRY_USERNAME === undefined ? {} : { username: env.REGISTRY_USERNAME }),
          ...(env.REGISTRY_PASSWORD === undefined ? {} : { password: env.REGISTRY_PASSWORD }),
        });
  const gitHubSourceIntegration = createGitHubSourceIntegration({
    apiBaseUrl: env.GITHUB_API_BASE_URL,
    ...(env.GITHUB_APP_ID === undefined ? {} : { appId: env.GITHUB_APP_ID }),
    ...(env.GITHUB_APP_PRIVATE_KEY === undefined ? {} : { privateKey: env.GITHUB_APP_PRIVATE_KEY }),
  });
  // Lambda MicroVMs: registered only when the build role (and the rest of the contract) is set.
  // The adapter and this worker's control connections share one endpoint-token cache.
  const microvmConfig = microvmRuntimeConfigFromEnv(env);
  const microvmApi =
    microvmConfig === undefined
      ? undefined
      : createLiveMicrovmApi({ region: microvmConfig.region });
  const microvmTokens =
    microvmConfig === undefined || microvmApi === undefined
      ? undefined
      : new MicrovmEndpointTokens({
          api: microvmApi,
          port: microvmConfig.agentPort,
          ttlMinutes: microvmConfig.endpointTokenTtlMinutes,
          refreshMarginMs: microvmConfig.endpointTokenRefreshMarginMs,
          webSocketAuth: microvmConfig.endpointWebSocketAuth,
        });
  // A MicroVM boots no container image, so it is registered with a builder of its own: AWS's
  // managed image build, under a role that can read one artifacts prefix and nothing else. The
  // recipe's files are checked here, so a release without them stops the worker at start.
  const microvmImageApi =
    microvmConfig === undefined
      ? undefined
      : createLiveMicrovmImageApi({
          region: microvmConfig.region,
          accountArn: microvmConfig.build.roleArn,
        });
  const microvmContextFiles =
    microvmConfig === undefined ? undefined : await loadMicrovmContextFiles();
  const microvmRuntimes =
    microvmConfig === undefined ||
    microvmContextFiles === undefined ||
    microvmImageApi === undefined ||
    microvmApi === undefined ||
    microvmTokens === undefined
      ? []
      : [
          {
            kind: "microvm" as const,
            adapter: new MicrovmRuntimeAdapter({
              config: microvmConfig,
              api: microvmApi,
              tokens: microvmTokens,
            }),
            imageBuilder: new MicrovmWorkspaceImageBuilder({
              api: microvmImageApi,
              artifacts: createS3MicrovmArtifactStore({
                region: microvmConfig.region,
                bucket: microvmConfig.build.artifactBucket,
              }),
              config: {
                baseImageArn: microvmConfig.build.baseImageArn,
                buildRoleArn: microvmConfig.build.roleArn,
                artifactPrefix: microvmConfig.build.artifactPrefix,
                memoryMiB: microvmConfig.build.memoryMiB,
                agentPort: microvmConfig.agentPort,
                logGroup: microvmConfig.build.logGroup,
                imageNamePrefix: microvmConfig.build.imageNamePrefix,
                dockerService: microvmConfig.dockerService,
                maxImages: microvmConfig.build.maxImages,
                pollIntervalMs: microvmConfig.build.pollIntervalMs,
                buildTimeoutMs: microvmConfig.build.timeoutMs,
              },
              readContextFile: microvmContextFiles.read,
              contextDigest: microvmContextFiles.digest,
            }),
          },
        ];

  // How this worker reaches each runtime family: nothing extra for Docker, client mTLS for
  // Kubernetes (sealantd's secure WebSocket frontend), a bearer token for Cloudflare, and the
  // bearer token plus minted endpoint tokens for MicroVMs.
  const baseTargetOptions = targetDerivationOptionsFromEnv(env, microvmTokens);

  // Kubernetes adapters exist only when the worker is configured for a cluster; a Docker worker
  // registers neither, so a blueprint asking for k8s gets a readable "unsupported-runtime".
  const kubernetesConfig = kubernetesRuntimeConfigFromEnv(env);
  const kubernetesAdapters =
    kubernetesConfig === undefined || baseTargetOptions.websocketTls === undefined
      ? []
      : (() => {
          const api = createLiveKubernetesApi({
            namespace: kubernetesConfig.namespace,
            ...(kubernetesConfig.kubeconfigPath === undefined
              ? {}
              : { kubeconfigPath: kubernetesConfig.kubeconfigPath }),
          });
          const shared = {
            config: kubernetesConfig,
            api,
            clientTls: baseTargetOptions.websocketTls,
          };
          return [new K8sRuntimeAdapter(shared), new K3sRuntimeAdapter(shared)];
        })();
  const launchMaterialStager =
    kubernetesConfig === undefined
      ? undefined
      : createKubernetesLaunchMaterialStager(kubernetesConfig);
  // Kubernetes workers build images with a rootless BuildKit Job that pushes to the registry —
  // no Docker socket. Docker workers keep `docker build/save` + `docker load/tag/push`.
  const kubernetesBuildConfig = kubernetesBuildConfigFromEnv(env);
  const imageBuilder =
    kubernetesBuildConfig === undefined
      ? undefined
      : new KubernetesWorkspaceImageBuilder({
          config: kubernetesBuildConfig,
          // What the workspace Pods run on (kubernetesImagePlatform), in the same node pool.
          platform:
            kubernetesConfig?.imagePlatform ??
            env.SEALANT_WORKSPACE_IMAGE_PLATFORM ??
            processImagePlatform(),
          ...(kubernetesConfig === undefined
            ? {}
            : { nodeSelector: kubernetesConfig.nodeSelector }),
          api: createLiveKubernetesBuildApi({
            namespace: kubernetesBuildConfig.namespace,
            ...(kubernetesBuildConfig.kubeconfigPath === undefined
              ? {}
              : { kubeconfigPath: kubernetesBuildConfig.kubeconfigPath }),
          }),
          registryClient,
        });

  // The Docker adapter exists only where a Docker daemon does; on daemon-less deployments
  // (Kubernetes, hosted) DOCKER_RUNTIME_ENABLED=false keeps "docker" out of the adapter set so
  // selection answers with a readable "unsupported-runtime" instead of a failed socket call.
  const dockerVolumeMappings =
    env.SEALANT_DOCKER_VOLUME_MAPPINGS === undefined
      ? undefined
      : parseDockerVolumeMappings(env.SEALANT_DOCKER_VOLUME_MAPPINGS);
  const dockerRegistryMirrors =
    env.SEALANT_DOCKER_REGISTRY_MIRRORS === undefined
      ? undefined
      : parseDockerRegistryMirrors(env.SEALANT_DOCKER_REGISTRY_MIRRORS);
  // Resource instances (Mend ADR 0019) run on this Docker host: the adapter tells their reach
  // about every executor it launches and removes, and a tick below keeps them at their rows.
  let boatResourceReach: (() => Promise<readonly ResourceWorkspaceLink[]>) | undefined;
  const resourceAssembly = !(
    (env.DEFAULT_RUNTIME_ADAPTER === "docker" && env.DOCKER_RUNTIME_ENABLED) ||
    env.DEFAULT_RUNTIME_ADAPTER === "k8s" ||
    env.DEFAULT_RUNTIME_ADAPTER === "k3s"
  )
    ? undefined
    : await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* ResourceInstanceRepo;
          const budgets = yield* ResourceDomainRepo;
          const callers = parseResourceCallers(env.SEALANT_RESOURCE_CALLERS);
          const dockerResources = () => {
            const subnets = repositorySubnets(
              repo,
              resourceSubnetPools({
                reach: env.SEALANT_RESOURCE_REACH_SUBNETS,
                egress: env.SEALANT_RESOURCE_EGRESS_SUBNETS,
              }),
            );
            return {
              subnets,
              runtime: new DockerResourceRuntime({
                callers,
                subnets,
                dockerSocketPath: env.DOCKER_SOCKET_PATH,
                ...(credentialCipher === undefined ? {} : { cipher: credentialCipher }),
                ...(env.SEALANT_RESOURCE_CALLER_GUARD_IMAGE === undefined
                  ? {}
                  : { callerGuardImage: env.SEALANT_RESOURCE_CALLER_GUARD_IMAGE }),
                ...(env.SEALANT_DOCKER_NETWORK_GUARD_IMAGE === undefined
                  ? {}
                  : { guardImage: env.SEALANT_DOCKER_NETWORK_GUARD_IMAGE }),
              }),
            };
          };
          const host =
            env.DEFAULT_RUNTIME_ADAPTER === "k8s" || env.DEFAULT_RUNTIME_ADAPTER === "k3s"
              ? {
                  runtime: new KubernetesCallerRuntime({
                    namespace: env.SEALANT_RESOURCE_K8S_NAMESPACE,
                    callers,
                    networkPolicyEnforced: env.SEALANT_RESOURCE_K8S_NETWORK_POLICY,
                    ...(credentialCipher === undefined ? {} : { cipher: credentialCipher }),
                    ...(env.SEALANT_RESOURCE_K8S_KUBECONFIG === undefined
                      ? {}
                      : { kubeconfigPath: env.SEALANT_RESOURCE_K8S_KUBECONFIG }),
                  }),
                  subnets: undefined,
                }
              : dockerResources();
          const { runtime, subnets } = host;
          return {
            runtime,
            subnets,
            reconciler: makeResourceReconciler({
              repo,
              budgets,
              runtime,
              externalReach: async () =>
                boatResourceReach === undefined ? [] : boatResourceReach(),
            }),
          };
        }).pipe(
          Effect.provide(
            Layer.merge(ResourceInstanceRepoLive, ResourceDomainRepoLive).pipe(
              Layer.provide(Layer.succeed(SealantDB, db)),
            ),
          ),
        ),
      );
  const resourceReconciler = resourceAssembly?.reconciler;
  // What this worker runs for Boat, from its settings alone (`assembleBoat`): the adapter where
  // the builder is configured, with a resource gateway or without one.
  const boatAssembly = await assembleBoat({
    env,
    db,
    credentialCipher,
    docker: resourceAssembly,
  });
  boatResourceReach = boatAssembly?.reach;
  const targetOptions = {
    ...baseTargetOptions,
    ...(boatAssembly?.control === undefined
      ? {}
      : { boatConnectMaterial: boatConnectMaterial(boatAssembly.control) }),
  };
  // How this worker's own drains reach a Boat daemon: a stop, a reaper, the recovery sweep and the
  // exit reconciler ask a run that is stopping, or never became ready, for its FINAL flush, which
  // `targetOptions` refuses to open. Exec jobs and the telemetry worker keep `targetOptions`.
  const drainTargetOptions = {
    ...baseTargetOptions,
    ...(boatAssembly?.control === undefined
      ? {}
      : {
          boatConnectMaterial: boatDrainConnectMaterial(boatAssembly.control),
          // A launch that failed before its control URL was recorded left a VM to drain too.
          boatEndpointOptional: true,
        }),
  };
  const dockerAdapters = !env.DOCKER_RUNTIME_ENABLED
    ? []
    : [
        new DockerRuntimeAdapter({
          dockerSocketPath: env.DOCKER_SOCKET_PATH,
          sshBindHost: env.DEFAULT_SSH_BIND_HOST,
          sshEndpointExposureStrategy: env.DEFAULT_SSH_ENDPOINT_EXPOSURE_STRATEGY,
          // §2.2: when set, workspaces expose their control socket on the host so the gateway reaches them
          // directly (unix://) and needs no Docker socket.
          ...(env.WORKSPACE_CONTROL_SOCKET_HOST_DIR === undefined
            ? {}
            : { controlSocketHostDir: env.WORKSPACE_CONTROL_SOCKET_HOST_DIR }),
          ...(env.SEALANT_MOUNT_ALLOWED_STORE_ROOTS === undefined
            ? {}
            : { mountAllowedStoreRoots: env.SEALANT_MOUNT_ALLOWED_STORE_ROOTS }),
          ...(dockerVolumeMappings === undefined ? {} : { volumeMappings: dockerVolumeMappings }),
          ...(env.SEALANT_DOCKER_WORKSPACE_NETWORK === undefined
            ? {}
            : { workspaceNetwork: env.SEALANT_DOCKER_WORKSPACE_NETWORK }),
          ...(dockerRegistryMirrors === undefined
            ? {}
            : { registryMirrors: dockerRegistryMirrors }),
          ...(env.SEALANT_DOCKER_REGISTRY_MIRROR_CONTAINER === undefined
            ? {}
            : { registryMirrorContainer: env.SEALANT_DOCKER_REGISTRY_MIRROR_CONTAINER }),
          ...(env.SEALANT_DOCKER_NETWORK_GUARD_IMAGE === undefined
            ? {}
            : { networkGuardImage: env.SEALANT_DOCKER_NETWORK_GUARD_IMAGE }),
          stopGraceSeconds: env.SEALANT_DOCKER_STOP_GRACE_SECONDS,
          captureStopGraceSeconds: env.SEALANT_DOCKER_CAPTURE_STOP_GRACE_SECONDS,
          containerStopTimeoutSeconds: env.SEALANT_DOCKER_CONTAINER_STOP_TIMEOUT_SECONDS,
          ...(resourceReconciler === undefined
            ? {}
            : { executorNetworks: resourceReconciler.hooks }),
        }),
      ];

  // Every Docker launch that does not opt in runs the metadata guard's image: pull it now, so a
  // host that cannot reach it says so in this log at startup instead of at the first session.
  for (const adapter of dockerAdapters) {
    void adapter.prepareNetworkGuard().then(
      ({ image, pulled }) => console.log("Cloud metadata guard image ready", { image, pulled }),
      (error: unknown) =>
        console.error("Cloud metadata guard image unavailable", {
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }

  // Cloudflare: registered only when the bridge Worker is configured (URL + token pair).
  const cloudflareConfig = cloudflareRuntimeConfigFromEnv(env);
  const cloudflareAdapters =
    cloudflareConfig === undefined
      ? []
      : [new CloudflareRuntimeAdapter({ config: cloudflareConfig })];

  const containerAdapters = [...dockerAdapters, ...kubernetesAdapters, ...cloudflareAdapters];

  // Every runtime is registered with the builder of the image it boots
  // (docs/workspace-image-builders-design.md, D1). The container runtimes share one: the BuildKit
  // Job where a build namespace is configured, the host's Docker otherwise. It is made only where
  // one of them is registered, so a MicroVM-only worker needs no Docker and no registry to build.
  // A silent stretch shorter than the stall bound is a build that is still alive: the bound must
  // fall inside the build's overall bound, or the build is stopped as too long before it could
  // ever be found stalled. (The claim's lease is renewed by the worker while it builds, so the
  // lease does not bound a quiet step.)
  if (env.WORKSPACE_IMAGE_BUILD_STALL_MS >= env.WORKSPACE_IMAGE_BUILD_MAX_MS) {
    throw new Error(
      `WORKSPACE_IMAGE_BUILD_STALL_MS (${String(env.WORKSPACE_IMAGE_BUILD_STALL_MS)}) must be shorter than WORKSPACE_IMAGE_BUILD_MAX_MS (${String(env.WORKSPACE_IMAGE_BUILD_MAX_MS)}).`,
    );
  }
  const containerImageBuilder =
    containerAdapters.length === 0
      ? undefined
      : (imageBuilder ??
        createDockerWorkspaceImageBuilder({
          registryClient,
          platform: env.SEALANT_WORKSPACE_IMAGE_PLATFORM ?? (await dockerImagePlatform()),
          stallTimeoutMs: env.WORKSPACE_IMAGE_BUILD_STALL_MS,
          ...(env.WORKSPACE_IMAGE_BUILD_CACHE_DIR === undefined
            ? {}
            : { cacheDirectory: env.WORKSPACE_IMAGE_BUILD_CACHE_DIR }),
        }));
  const runtimes = [
    ...(containerImageBuilder === undefined
      ? []
      : containerAdapters.map((adapter) => ({
          kind: "oci" as const,
          adapter,
          imageBuilder: containerImageBuilder,
        }))),
    ...microvmRuntimes,
    ...(boatAssembly?.registration === undefined ? [] : [boatAssembly.registration]),
  ];
  // Every runtime's adapter, for the paths that stop, inspect and recover executors. A worker
  // that holds Boat's resource gateway and does not launch Boat workspaces still ends them: only
  // it can release their tunnels.
  const runtimeAdapters: readonly RuntimeAdapterLifecycle[] = [
    ...runtimes.map((runtime) => runtime.adapter),
    ...(boatAssembly?.registration === undefined && boatAssembly?.lifecycle !== undefined
      ? [boatAssembly.lifecycle]
      : []),
  ];

  // Drain before stop (no loss of work product): one durable ledger (`workspace_capture_drains`)
  // shared by every path that can tear a capture-sourced runtime down (lifecycle stop, reapers,
  // exit reconciler, deadline sweep) in every worker process, so a drain spans ticks and workers
  // and never runs twice at once. The owner is this process: a restarted worker waits out its
  // predecessor's lease rather than share a drain with it.
  const captureDrainSettings: CaptureDrainSettings = {
    ...DEFAULT_CAPTURE_DRAIN_SETTINGS,
    pollIntervalMs: env.WORKSPACE_CAPTURE_DRAIN_POLL_INTERVAL_MS,
    stallWindowMs: env.WORKSPACE_CAPTURE_DRAIN_STALL_WINDOW_MS,
    unreachableWindowMs: env.WORKSPACE_CAPTURE_DRAIN_UNREACHABLE_WINDOW_MS,
    requestTimeoutMs: env.WORKSPACE_CAPTURE_DRAIN_REQUEST_TIMEOUT_MS,
    ...(env.WORKSPACE_CAPTURE_DRAIN_FINAL_DEADLINE_MS === undefined
      ? {}
      : { finalFlushDeadlineMs: env.WORKSPACE_CAPTURE_DRAIN_FINAL_DEADLINE_MS }),
    finalFlushGraceMs: env.WORKSPACE_CAPTURE_DRAIN_FINAL_GRACE_MS,
    leaseMs: env.WORKSPACE_CAPTURE_DRAIN_LEASE_MS,
  };
  // Every executor a stop, the exit reconciler or a launch records retained starts a recovery
  // sweep at once (`requestRecoverySweep`, below): its first attempt follows its exit within
  // seconds, while the session that owns it still honours its capture token.
  let requestRecoverySweep: ((runId: string) => void) | undefined;
  const captureDrainLedger = notifyingRetention(
    databaseCaptureDrainLedger({
      db,
      owner: `${env.WORKER_ID}:${String(process.pid)}:${randomUUID()}`,
      leaseMs: env.WORKSPACE_CAPTURE_DRAIN_LEASE_MS,
    }),
    (runId) => requestRecoverySweep?.(runId),
  );

  // A Boat launch that failed after its VM was created is stopped at once, by the same stop the
  // retained-launch sweep would make on its next tick: a paid VM does not wait a minute for a
  // decision that needs none, and a launch whose daemon never ran reads terminal within seconds.
  // Every other runtime keeps the sweep's tick.
  const stopRetainedLaunch = (runId: string, adapter: RuntimeAdapterId): void => {
    if (adapter !== "boat") {
      return;
    }
    processWorkspaceStop({
      runId,
      stopReason: "failed",
      db,
      runtimeAdapters,
      ...(credentialCipher === undefined ? {} : { credentialCipher }),
      targetOptions: drainTargetOptions,
      ...(launchMaterialStager === undefined ? {} : { launchMaterialStager }),
      captureDrain: {
        ledger: captureDrainLedger,
        settings: captureDrainSettings,
        budgetMs: RETAINED_LAUNCH_DRAIN_BUDGET_MS,
        label: "retained launch",
      },
    }).catch((error: unknown) => {
      console.error("Stopping a retained Boat launch failed; the retained-launch sweep retries", {
        error,
        runId,
      });
    });
  };

  // Every consumer below: resolving completes the delivery, throwing dead-letters it (no retries).
  // Failures are recorded on the domain rows by the handlers themselves; the rethrow only keeps the
  // failed delivery visible in the queue's DLQ.
  const consumer = await consumeWorkspaceBuildJobs({
    databaseUrl: env.DATABASE_URL,
    concurrency: env.WORKSPACE_BUILD_QUEUE_PREFETCH,
    onMessage: async ({ message }) => {
      try {
        await processWorkspaceBuildJob({
          jobId: message.jobId,
          workerId: env.WORKER_ID,
          leaseDurationMs: env.WORKSPACE_BUILD_JOB_LEASE_DURATION_MS,
          imageBuildMaxMs: env.WORKSPACE_IMAGE_BUILD_MAX_MS,
          launchLeaseMs: env.WORKSPACE_LAUNCH_LEASE_MS,
          preservationLeadMs: env.WORKSPACE_CAPTURE_DEADLINE_LEAD_MS,
          db,
          runtimes,
          defaultRuntimeAdapterId: env.DEFAULT_RUNTIME_ADAPTER,
          gitHubSourceIntegration,
          registryClient,
          ...(credentialCipher === undefined ? {} : { credentialCipher }),
          ...(launchMaterialStager === undefined ? {} : { launchMaterialStager }),
          onLaunchRetained: stopRetainedLaunch,
        });
      } catch (error) {
        console.error("Workspace build job failed", {
          error,
          jobId: message.jobId,
        });
        throw error;
      }
    },
  });

  // Run-exec consumer: execute harness runs and deterministic check runs server-side (docker-exec +
  // telemetry ingest), so the SDK can be a thin HTTP client. The API enqueues here when a run is
  // created with a `command` (harness framing) or via execWorkspace (`commands`, exec framing).
  const runExecConsumer = await consumeRunExecJobs({
    databaseUrl: env.DATABASE_URL,
    concurrency: env.RUN_EXEC_QUEUE_CONCURRENCY,
    onMessage: async ({ message }) => {
      try {
        await processRunExecJob({
          runId: message.runId,
          ...(message.command === undefined ? {} : { command: message.command }),
          ...(message.commands === undefined ? {} : { commands: message.commands }),
          ...(message.dotfiles === undefined ? {} : { dotfiles: message.dotfiles }),
          ...(message.user === undefined ? {} : { user: message.user }),
          ...(message.checkedExecutorRunId === undefined
            ? {}
            : { checkedExecutorRunId: message.checkedExecutorRunId }),
          db,
          ...(credentialCipher === undefined ? {} : { credentialCipher }),
          targetOptions,
        });
      } catch (error) {
        console.error("Run exec job failed", { error, runId: message.runId });
        throw error;
      }
    },
  });

  // Lifecycle consumer: execute workspace stop requests (user stop, restart's stop half) — remove
  // the container via the runtime adapter and record the terminal "stopped" state. Runtime mutations
  // stay in the worker so the API never needs a Docker socket.
  const lifecycleConsumer = await consumeWorkspaceLifecycleJobs({
    databaseUrl: env.DATABASE_URL,
    concurrency: env.WORKSPACE_BUILD_QUEUE_PREFETCH,
    onMessage: async ({ message }) => {
      try {
        const outcome = await processWorkspaceStop({
          workspaceId: message.workspaceId,
          runId: message.runId,
          stopReason: message.stopReason,
          db,
          runtimeAdapters,
          // Rotated claude/codex session files are synced back before the container is destroyed.
          ...(credentialCipher === undefined ? {} : { credentialCipher }),
          targetOptions: drainTargetOptions,
          ...(launchMaterialStager === undefined ? {} : { launchMaterialStager }),
          captureDrain: {
            ledger: captureDrainLedger,
            settings: captureDrainSettings,
            budgetMs: LIFECYCLE_STOP_DRAIN_BUDGET_MS,
            label: "lifecycle stop",
          },
        });
        if (outcome !== "stopped") {
          // The stop intent is durable (a stopped workspace is `stranded` to the reaper, a
          // replaced run `superseded`): the reaper finishes the drain and the stop.
          console.warn(
            "Workspace stop deferred to the reaper: capture work not yet confirmed saved",
            {
              workspaceId: message.workspaceId,
              runId: message.runId,
              outcome,
            },
          );
        }
      } catch (error) {
        console.error("Workspace stop failed", {
          error,
          workspaceId: message.workspaceId,
          runId: message.runId,
        });
        throw error;
      }
    },
  });

  const runReaperTick = (): void => {
    reapStaleWorkspaceBuildJobs({
      db,
      workerId: env.WORKER_ID,
      leaseDurationMs: env.WORKSPACE_BUILD_JOB_LEASE_DURATION_MS,
      imageBuildMaxMs: env.WORKSPACE_IMAGE_BUILD_MAX_MS,
      launchLeaseMs: env.WORKSPACE_LAUNCH_LEASE_MS,
      preservationLeadMs: env.WORKSPACE_CAPTURE_DEADLINE_LEAD_MS,
      // The reaper re-drives the same pipeline as the consumer, so it takes the same registered
      // runtimes: a reaped job builds with the same builder a first delivery would.
      runtimes,
      defaultRuntimeAdapterId: env.DEFAULT_RUNTIME_ADAPTER,
      gitHubSourceIntegration,
      registryClient,
      ...(credentialCipher === undefined ? {} : { credentialCipher }),
      ...(launchMaterialStager === undefined ? {} : { launchMaterialStager }),
      onLaunchRetained: stopRetainedLaunch,
    }).catch((error: unknown) => {
      console.error("Workspace build job reaper tick failed", { error });
    });
  };
  const reaperTimer = setInterval(runReaperTick, env.WORKSPACE_BUILD_JOB_REAPER_INTERVAL_MS);
  // Don't let the reaper interval keep the process alive on its own.
  reaperTimer.unref();

  // Expiry reaper: stop live runtimes whose workspace TTL elapsed (and stranded containers whose
  // stop was lost), so a self-host install doesn't accumulate dead containers.
  const runExpiryReaperTick = (): void => {
    // Kubernetes: objects that outlived their runtime instance row (worker crash, lost stop).
    const kubernetesAdapter = kubernetesAdapters[0];
    if (kubernetesAdapter !== undefined) {
      // Through the one preservation policy: a capture Pod goes only with evidence it may.
      reapOrphanedKubernetesResources({
        db,
        adapter: kubernetesAdapter,
        ledger: captureDrainLedger,
      }).catch((error: unknown) => {
        console.error("Kubernetes reconciler tick failed", { error });
      });
    }
    reapExpiredWorkspaces({
      db,
      runtimeAdapters,
      ...(credentialCipher === undefined ? {} : { credentialCipher }),
      targetOptions: drainTargetOptions,
      captureDrain: { ledger: captureDrainLedger, settings: captureDrainSettings },
    }).catch((error: unknown) => {
      console.error("Workspace expiry reaper tick failed", { error });
    });
  };
  const expiryReaperTimer = setInterval(
    runExpiryReaperTick,
    env.WORKSPACE_EXPIRY_REAPER_INTERVAL_MS,
  );
  expiryReaperTimer.unref();

  // Deadline preservation: a runtime with its own lifetime (a MicroVM's maximum duration) gets
  // its final drain and a planned stop early enough to finish before the platform ends it. Every
  // due runtime is driven every tick; a tick still driving drains is not overlapped by the next.
  let deadlineSweepRunning = false;
  const runDeadlineSweepTick = (): void => {
    if (deadlineSweepRunning) {
      return;
    }
    deadlineSweepRunning = true;
    preserveBeforeDeadline({
      db,
      runtimeAdapters,
      ...(credentialCipher === undefined ? {} : { credentialCipher }),
      targetOptions: drainTargetOptions,
      captureDrain: { ledger: captureDrainLedger, settings: captureDrainSettings },
      ...(launchMaterialStager === undefined ? {} : { launchMaterialStager }),
      deadline: {
        leadMs: env.WORKSPACE_CAPTURE_DEADLINE_LEAD_MS,
        watchWindowMs: env.WORKSPACE_CAPTURE_DEADLINE_WATCH_MS,
      },
    })
      .catch((error: unknown) => {
        console.error("Workspace deadline preservation tick failed", { error });
      })
      .finally(() => {
        deadlineSweepRunning = false;
      });
  };
  const deadlineSweepTimer = setInterval(
    runDeadlineSweepTick,
    env.WORKSPACE_CAPTURE_DEADLINE_SWEEP_INTERVAL_MS,
  );
  deadlineSweepTimer.unref();

  // Recovery of retained executors: a capture executor kept because its disk holds work not
  // confirmed saved is restarted on its own disk where the runtime can (Docker), drained with a
  // FINAL flush and only then removed; elsewhere it is reported and kept. Backoff per executor.
  // A sweep runs as soon as an executor is recorded retained, and every
  // WORKSPACE_RECOVERY_SWEEP_INTERVAL_MS for attempts that fall due. Sweeps may overlap (review 9
  // #8): each executor's attempt holds its own recovery claim, so a sweep busy with one slow
  // attempt never keeps another executor's first attempt waiting; one asked for while the most
  // sweeps allowed run follows them.
  let recoverySweepsRunning = 0;
  let recoverySweepAgain = false;
  // Executors recorded retained since the last sweep began: the next sweep takes exactly them.
  const justRetained = new Set<string>();
  const runRecoverySweepTick = (): void => {
    if (recoverySweepsRunning >= MAX_OVERLAPPING_RECOVERY_SWEEPS) {
      recoverySweepAgain = true;
      return;
    }
    recoverySweepsRunning += 1;
    recoverySweepAgain = false;
    const runIds = justRetained.size === 0 ? undefined : [...justRetained];
    justRetained.clear();
    recoverRetainedExecutors({
      db,
      runtimeAdapters,
      targetOptions: drainTargetOptions,
      // A restarted executor boots again: its capture token is unsealed and staged where it
      // was created to read it.
      ...(credentialCipher === undefined ? {} : { credentialCipher }),
      ...(launchMaterialStager === undefined ? {} : { launchMaterialStager }),
      captureDrain: { ledger: captureDrainLedger, settings: captureDrainSettings },
      ...(runIds === undefined ? {} : { runIds }),
    })
      .catch((error: unknown) => {
        console.error("Retained executor recovery tick failed", { error });
      })
      .finally(() => {
        recoverySweepsRunning -= 1;
        if (recoverySweepAgain) {
          setImmediate(runRecoverySweepTick);
        }
      });
  };
  requestRecoverySweep = (runId) => {
    justRetained.add(runId);
    setImmediate(runRecoverySweepTick);
  };
  const recoverySweepTimer = setInterval(
    runRecoverySweepTick,
    env.WORKSPACE_RECOVERY_SWEEP_INTERVAL_MS,
  );
  recoverySweepTimer.unref();

  // Exit reconciler: a runtime that dies on its own (`docker kill`, OOM, node loss) is recorded
  // `failed` with its exit code instead of staying `ready` until a client probes it. Docker
  // (`docker events`) and Kubernetes (a Pod watch) push exits as they happen; the poll is the
  // convergence net behind those streams. The first sweep runs at boot so a worker restart
  // catches up.
  const runExitReconcilerTick = (): void => {
    reconcileRuntimeExits({
      db,
      runtimeAdapters,
      ...(launchMaterialStager === undefined ? {} : { launchMaterialStager }),
      targetOptions: drainTargetOptions,
      captureDrain: { ledger: captureDrainLedger, settings: captureDrainSettings },
    }).catch((error: unknown) => {
      console.error("Runtime exit reconciler tick failed", { error });
    });
  };
  runExitReconcilerTick();
  const exitReconcilerTimer = setInterval(
    runExitReconcilerTick,
    env.WORKSPACE_RUNTIME_EXIT_POLL_INTERVAL_MS,
  );
  exitReconcilerTimer.unref();
  const exitWatch = watchRuntimeExits({
    db,
    runtimeAdapters,
    ...(launchMaterialStager === undefined ? {} : { launchMaterialStager }),
    targetOptions: drainTargetOptions,
    captureDrain: { ledger: captureDrainLedger, settings: captureDrainSettings },
    onError: (error: unknown) => {
      console.error("Runtime exit watch failed; reconnecting", { error });
    },
  });

  // Image retention: images no live workspace launched from and no retained plan needs are
  // deleted from the store; build scratch that outlived its build (a worker that died mid-build,
  // or a version that never cleaned up) is swept from the OS temp dir. The first pass runs shortly
  // after boot so an upgrade reclaims a full disk without waiting an interval.
  const runImageRetentionTick = (): void => {
    void (async () => {
      const contexts = await sweepStaleBuildContexts({ olderThanMs: STALE_BUILD_CONTEXT_AGE_MS });
      const images = await reapWorkspaceImages({
        db,
        registryClient,
        retainedPlans: env.WORKSPACE_IMAGE_RETAINED_PLANS,
        minAgeMs: env.WORKSPACE_IMAGE_MIN_AGE_HOURS * 60 * 60 * 1000,
        // MicroVM images are in no registry: retention deletes them with the image API.
        ...(microvmConfig === undefined || microvmImageApi === undefined
          ? {}
          : {
              microvmImages: {
                api: microvmImageApi,
                namePrefix: microvmConfig.build.imageNamePrefix,
              },
            }),
      });
      if (contexts.removed > 0 || images.deleted > 0 || images.failed > 0) {
        console.log("Workspace image retention", {
          ...images,
          staleBuildContextsRemoved: contexts.removed,
          staleBuildContextBytes: contexts.reclaimedBytes,
        });
      }
    })().catch((error: unknown) => {
      console.error("Workspace image retention tick failed", { error });
    });
  };
  const imageRetentionBootTimer = env.WORKSPACE_IMAGE_GC_ENABLED
    ? setTimeout(runImageRetentionTick, IMAGE_RETENTION_BOOT_DELAY_MS)
    : undefined;
  imageRetentionBootTimer?.unref();
  const imageRetentionTimer = env.WORKSPACE_IMAGE_GC_ENABLED
    ? setInterval(runImageRetentionTick, env.WORKSPACE_IMAGE_GC_INTERVAL_MS)
    : undefined;
  imageRetentionTimer?.unref();

  // Run-record retention, only when the operator set SEALANT_RUN_RECORD_RETENTION_DAYS: the
  // records of runs that finished longer ago are deleted, in bounded chunks of rows. A tick still
  // running when the next falls due makes that one skip.
  const recordRetentionDays = env.SEALANT_RUN_RECORD_RETENTION_DAYS;
  let recordRetentionRunning = false;
  const runRecordRetentionTick = (days: number): void => {
    if (recordRetentionRunning) {
      return;
    }
    recordRetentionRunning = true;
    const finishedBefore = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    void (async () => {
      const deleted = await Effect.runPromise(deleteExpiredRunRecords(db, { finishedBefore }));
      if (deleted.rows > 0) {
        console.log("Run record retention", { ...deleted, retentionDays: days, finishedBefore });
      }
    })()
      .catch((error: unknown) => {
        console.error("Run record retention tick failed", { error });
      })
      .finally(() => {
        recordRetentionRunning = false;
      });
  };
  const recordRetentionBootTimer =
    recordRetentionDays === undefined
      ? undefined
      : setTimeout(
          () => runRecordRetentionTick(recordRetentionDays),
          RECORD_RETENTION_BOOT_DELAY_MS,
        );
  recordRetentionBootTimer?.unref();
  const recordRetentionTimer =
    recordRetentionDays === undefined
      ? undefined
      : setInterval(
          () => runRecordRetentionTick(recordRetentionDays),
          RECORD_RETENTION_INTERVAL_MS,
        );
  recordRetentionTimer?.unref();

  // Run-exec job rows hold a command's arguments. The worker deletes each when it takes it; this
  // sweep removes what a failed delete or an older worker left (finished, dead-lettered, or
  // `active` for over ten minutes). Hourly, first a minute after boot.
  const runRunExecJobSweep = (): void => {
    sweepRunExecJobRows(env.DATABASE_URL)
      .then((deleted) => {
        if (deleted > 0) console.log("Run-exec job sweep", { deleted });
        return deleted;
      })
      .catch((error: unknown) => {
        console.error("Run-exec job sweep failed", { error });
      });
  };
  const runExecJobSweepBootTimer = setTimeout(runRunExecJobSweep, RUN_EXEC_JOB_SWEEP_BOOT_DELAY_MS);
  runExecJobSweepBootTimer.unref();
  const runExecJobSweepTimer = setInterval(runRunExecJobSweep, RUN_EXEC_JOB_SWEEP_INTERVAL_MS);
  runExecJobSweepTimer.unref();

  // Keep-fresh sweeper: claude SESSION credentials (kind "credentials-json") only stay fresh when
  // the official CLI runs against them; when no workspace uses an account for hours, the stored
  // access token expires. Every tick, stale accounts are refreshed with a minimal one-turn
  // official-CLI exchange in a private CLAUDE_CONFIG_DIR and persisted newest-wins. Requires the
  // credential cipher — without SEALANT_CREDENTIALS_KEY there is nothing to refresh.
  const claudeRefreshTimer =
    credentialCipher === undefined
      ? undefined
      : setInterval(() => {
          refreshClaudeSessionCredentials({ db, credentialCipher, targetOptions }).catch(
            (error: unknown) => {
              console.error("Claude session refresh tick failed", { error });
            },
          );
        }, CLAUDE_SESSION_REFRESH_INTERVAL_MS);
  claudeRefreshTimer?.unref();

  // The only refresher of a Codex login (docs/connected-accounts-design.md §6a): workspaces and
  // inference hold copies that cannot refresh.
  const codexRefreshTimer =
    credentialCipher === undefined
      ? undefined
      : setInterval(() => {
          refreshCodexSessionCredentials({ db, credentialCipher, targetOptions }).catch(
            (error: unknown) => {
              console.error("Codex session refresh tick failed", { error });
            },
          );
        }, CODEX_SESSION_REFRESH_INTERVAL_MS);
  codexRefreshTimer?.unref();

  const placementLayer = Layer.mergeAll(
    CredentialPlacementRepoLive,
    WorkspaceCredentialHomeRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));
  const placementSweepBackoff: PlacementSweepBackoff = new Map();
  let placementSweepRunning = false;
  const sweepPlacements = () => {
    if (placementSweepRunning) return;
    placementSweepRunning = true;
    void Effect.runPromise(
      sweepCredentialPlacements({ targetOptions, backoff: placementSweepBackoff }).pipe(
        Effect.provide(placementLayer),
      ),
    )
      .catch(() => console.error("Credential placement sweep failed; will retry."))
      .finally(() => {
        placementSweepRunning = false;
      });
  };
  sweepPlacements();
  const placementSweepTimer = setInterval(sweepPlacements, 30_000);
  placementSweepTimer.unref();

  // Resource instances: restart what ended on its own, stop what nobody reached for its idle time,
  // converge every reach network. One tick at a time; the first at start.
  let resourceTickRunning = false;
  const resourceTick = () => {
    if (resourceReconciler === undefined || resourceTickRunning) return;
    resourceTickRunning = true;
    void resourceReconciler
      .tick()
      .then((report) => {
        const acted =
          report.restarted.length + report.stopped.length + report.idleStopped.length > 0;
        if (acted || report.problems.length > 0) {
          console.log("Resource instances reconciled", report);
        }
        return report;
      })
      .catch((error: unknown) =>
        console.error("Resource instance tick failed; will retry.", {
          error: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
        }),
      )
      .finally(() => {
        resourceTickRunning = false;
      });
  };

  resourceTick();
  const resourceTickTimer = setInterval(resourceTick, env.SEALANT_RESOURCE_TICK_MS);
  let boatSweepRunning = false;
  // A run held as it is stays in the sweeps' pages and is visited on every tick: each line lists
  // it when it is first held, then once an hour.
  const boatAllocationHeldDue = boatKeptReports();
  const boatConvergenceHeldDue = boatKeptReports();
  // The nudge: Boat's convergence sweep calls the shared stop for a Boat run that is stopping or
  // failed, as the expiry reaper calls it for every runtime. The stop decides; the sweep only asks.
  const stopBoatRun: BoatSharedStop = ({ runId, stopReason }) =>
    processWorkspaceStop({
      runId,
      stopReason,
      db,
      runtimeAdapters,
      ...(credentialCipher === undefined ? {} : { credentialCipher }),
      targetOptions: drainTargetOptions,
      ...(launchMaterialStager === undefined ? {} : { launchMaterialStager }),
      captureDrain: {
        ledger: captureDrainLedger,
        settings: captureDrainSettings,
        budgetMs: RETAINED_LAUNCH_DRAIN_BUDGET_MS,
        label: "Boat convergence",
      },
    });
  /**
   * One tick of Boat's sweeps for one account, each sweep from where it stopped last for that
   * account: its creates, its stops and cleanups, its resource links, its build journals.
   */
  const sweepBoatAccount = async (stack: BoatWorkerStack) => {
    const { cursors } = stack;
    const account = stack.accountId ?? "default";
    const report = await stack.reconcileAllocations({
      limit: 20,
      ...(cursors.vm === undefined ? {} : { after: cursors.vm }),
    });
    cursors.vm = report.next;
    if (stack.reconcileConvergence !== undefined) {
      const converged = await stack.reconcileConvergence({
        limit: 20,
        ...(cursors.convergence === undefined ? {} : { after: cursors.convergence }),
        stop: stopBoatRun,
      });
      cursors.convergence = converged.next;
      // A stop still draining or busy is at work, and a kept VM is reported by the sweep itself,
      // once an hour: only what nothing is settling is listed every tick.
      const held = boatConvergenceObligations(converged.entries, (runId) =>
        boatConvergenceHeldDue(runId, Date.now()),
      );
      if (held.length > 0) console.warn("Boat stop obligations remain", { account, entries: held });
    }
    if (stack.reconcileResources !== undefined) {
      const resources = await stack.reconcileResources({
        limit: 20,
        ...(cursors.resource === undefined ? {} : { after: cursors.resource }),
        live: {
          limit: BOAT_RESOURCE_PASS.livePage,
          ...(cursors.liveResource === undefined ? {} : { after: cursors.liveResource }),
        },
      });
      cursors.resource = resources.next;
      cursors.liveResource = resources.live?.next;
      // A live run both pages reached is listed once: the second reports the first's outcome.
      const paged = new Set(resources.entries.map((entry) => entry.runId));
      const held = boatResourceObligations([
        ...(resources.live?.entries ?? []).filter((entry) => !paged.has(entry.runId)),
        ...resources.entries,
      ]);
      if (held.length > 0)
        console.warn("Boat resource obligations remain", { account, entries: held });
    }
    await stack.reconcileCatalog?.();
    // A launch still being created is not an obligation, and a run held as it is is listed
    // once an hour: a failed read and a launch with more than one VM are listed every tick.
    const unresolved = boatAllocationObligations(report.entries, (runId) =>
      boatAllocationHeldDue(runId, Date.now()),
    );
    if (unresolved.length > 0)
      console.warn("Boat allocation obligations remain", { account, entries: unresolved });
  };
  /** Every Boat account that has runs, the default one first; one failing stops no other. */
  const runBoatSweep = async () => {
    if (boatAssembly === undefined || boatSweepRunning) return;
    boatSweepRunning = true;
    try {
      for (const stack of await boatAssembly.sweptStacks()) {
        await sweepBoatAccount(stack).catch(() => {
          console.error("Boat allocation reconciliation tick failed", {
            account: stack.accountId ?? "default",
          });
        });
      }
      const removals = await boatAssembly.reconcileRemovals?.();
      for (const removal of removals ?? [])
        if (removal.outcome === "removed")
          console.log("Boat account removed; its saved images are deleted", {
            account: removal.accountId,
          });
    } catch {
      console.error("Boat allocation reconciliation tick failed");
    } finally {
      boatSweepRunning = false;
    }
  };
  // A link written or removed for a live Boat run is applied when the API says so, not at the
  // run's next visit by the sweep above. The sweep is the fallback: a delivery that is lost, or
  // that finds the run not ready to configure, is completed and nothing is retried.
  const applyBoatLink = boatAssembly?.applyLink;
  const boatLinkConsumer =
    applyBoatLink === undefined
      ? undefined
      : await consumeBoatResourceLinkJobs({
          databaseUrl: env.DATABASE_URL,
          concurrency: BOAT_RESOURCE_PASS.linkJobs,
          onMessage: async ({ message }) => {
            try {
              const outcome = await applyBoatLink(message.runId);
              if (outcome !== "configured")
                console.log("Boat resource link left to the sweep", {
                  workspaceId: message.workspaceId,
                  runId: message.runId,
                  outcome,
                });
            } catch (error) {
              console.error("Boat resource link job failed; the sweep applies the link", {
                workspaceId: message.workspaceId,
                runId: message.runId,
                error:
                  error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
              });
              throw error;
            }
          },
        });
  const boatSweepTimer = boatAssembly === undefined ? undefined : setInterval(runBoatSweep, 30_000);
  boatSweepTimer?.unref();
  void runBoatSweep();
  // A restart dropped every tunnel carrier this worker held. The sweep above reopens a run's only
  // when it configures it: twenty live runs a tick, each after a full configuration. Reopen every
  // live run's carrier now, beside the sweep: a carrier the sweep opens first is left as it is.
  const reopenBoatCarriers = async () => {
    if (boatAssembly?.reopenCarriers === undefined) return;
    try {
      const { runIds } = await boatAssembly.reopenCarriers();
      if (runIds.length > 0) console.log("Boat tunnel carriers reopened", { runs: runIds.length });
    } catch {
      console.error("Boat tunnel carriers could not be reopened at start");
    }
  };
  void reopenBoatCarriers();
  // A session whose sealed bearer no longer opens cannot be drained: said at start, by run (the
  // check logs each one at error level). It reads the database only and never stops the worker.
  const verifyBoatBearers = async () => {
    if (boatAssembly?.verifyBearers === undefined) return;
    try {
      const { checked, unopened } = await boatAssembly.verifyBearers();
      if (unopened.length > 0)
        console.error("Boat sealed bearers do not open; their sessions cannot be drained", {
          runs: unopened,
          checked,
        });
      else if (checked > 0) console.log("Boat sealed bearers open", { runs: checked });
    } catch {
      console.error("Boat sealed bearers could not be checked at start");
    }
  };
  void verifyBoatBearers();

  resourceTickTimer.unref();

  return {
    /**
     * How this worker reaches a Boat run's daemon: fresh hosted authority per connection, through
     * the agent's control relay (the path readiness probes). The telemetry worker beside it attaches
     * its recorder the same way; without this a Boat run has no control target there.
     */
    boatConnectMaterial: targetOptions.boatConnectMaterial,
    stop: async () => {
      clearInterval(placementSweepTimer);
      clearInterval(resourceTickTimer);
      clearInterval(reaperTimer);
      clearInterval(expiryReaperTimer);
      clearInterval(deadlineSweepTimer);
      clearInterval(recoverySweepTimer);
      clearInterval(exitReconcilerTimer);
      if (boatSweepTimer !== undefined) clearInterval(boatSweepTimer);
      // Before the Boat runtime goes: a delivery in flight finishes its configuration on it.
      await boatLinkConsumer?.cancel();
      await boatAssembly?.dispose();
      exitWatch.close();
      if (imageRetentionBootTimer !== undefined) clearTimeout(imageRetentionBootTimer);
      if (imageRetentionTimer !== undefined) clearInterval(imageRetentionTimer);
      if (recordRetentionBootTimer !== undefined) clearTimeout(recordRetentionBootTimer);
      if (recordRetentionTimer !== undefined) clearInterval(recordRetentionTimer);
      clearTimeout(runExecJobSweepBootTimer);
      clearInterval(runExecJobSweepTimer);
      if (claudeRefreshTimer !== undefined) {
        clearInterval(claudeRefreshTimer);
      }
      if (codexRefreshTimer !== undefined) {
        clearInterval(codexRefreshTimer);
      }
      await lifecycleConsumer.cancel();
      await runExecConsumer.cancel();
      await consumer.cancel();
      await jobs.close();
    },
  };
};
