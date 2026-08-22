import {
  CredentialCipher,
  credentialCipherLayer,
  type CredentialCipherService,
} from "@sealant/credentials";
import { createSealantDB, type DB } from "@sealant/db";
import { createRabbitMqService } from "@sealant/rabbitmq";
import { createGitHubSourceIntegration } from "@sealant/source-integrations";
import type { WorkerEnv } from "@sealant/validators/env";
import {
  consumeRunExecJobs,
  consumeWorkspaceBuildJobs,
  consumeWorkspaceLifecycleJobs,
  createKubernetesLaunchMaterialStager,
  createLiveKubernetesApi,
  createLiveKubernetesBuildApi,
  createZotRegistryClient,
  DockerRuntimeAdapter,
  K3sRuntimeAdapter,
  K8sRuntimeAdapter,
  processWorkspaceBuildJob,
  processWorkspaceStop,
  reapExpiredWorkspaces,
  reapOrphanedKubernetesResources,
  kubernetesBuildConfigFromEnv,
  kubernetesRuntimeConfigFromEnv,
  KubernetesWorkspaceImageBuilder,
  reapStaleWorkspaceBuildJobs,
  targetDerivationOptionsFromEnv,
} from "@sealant/workspaces";
import { Effect } from "effect";

import { processRunExecJob } from "./process-run-exec-job.js";
import {
  CLAUDE_SESSION_REFRESH_INTERVAL_MS,
  refreshClaudeSessionCredentials,
} from "./refresh-claude-sessions.js";

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
export const startWorkspaceWorker = async (env: WorkerEnv) => {
  const db = await createDatabaseFromEnv(env);
  const rabbitMq = createRabbitMqService(env.RABBITMQ_URL);
  const credentialCipher = createCredentialCipherFromEnv(env);
  const registryClient = createZotRegistryClient({
    baseUrl: env.REGISTRY_BASE_URL,
    pushRegistry: env.REGISTRY_PUSH_REGISTRY,
    ...(env.REGISTRY_USERNAME === undefined ? {} : { username: env.REGISTRY_USERNAME }),
    ...(env.REGISTRY_PASSWORD === undefined ? {} : { password: env.REGISTRY_PASSWORD }),
  });
  const gitHubSourceIntegration = createGitHubSourceIntegration({
    apiBaseUrl: env.GITHUB_API_BASE_URL,
    ...(env.GITHUB_APP_ID === undefined ? {} : { appId: env.GITHUB_APP_ID }),
    ...(env.GITHUB_APP_PRIVATE_KEY === undefined ? {} : { privateKey: env.GITHUB_APP_PRIVATE_KEY }),
  });
  // How this worker reaches each runtime family: nothing extra for Docker, client mTLS for
  // Kubernetes (sealantd's secure WebSocket frontend).
  const targetOptions = targetDerivationOptionsFromEnv(env);

  // Kubernetes adapters exist only when the worker is configured for a cluster; a Docker worker
  // registers neither, so a blueprint asking for k8s gets a readable "unsupported-runtime".
  const kubernetesConfig = kubernetesRuntimeConfigFromEnv(env);
  const kubernetesAdapters =
    kubernetesConfig === undefined || targetOptions.websocketTls === undefined
      ? []
      : (() => {
          const api = createLiveKubernetesApi({
            namespace: kubernetesConfig.namespace,
            ...(kubernetesConfig.kubeconfigPath === undefined
              ? {}
              : { kubeconfigPath: kubernetesConfig.kubeconfigPath }),
          });
          const shared = { config: kubernetesConfig, api, clientTls: targetOptions.websocketTls };
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
          api: createLiveKubernetesBuildApi({
            namespace: kubernetesBuildConfig.namespace,
            ...(kubernetesBuildConfig.kubeconfigPath === undefined
              ? {}
              : { kubeconfigPath: kubernetesBuildConfig.kubeconfigPath }),
          }),
          registryClient,
        });

  const runtimeAdapters = [
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
    }),
    ...kubernetesAdapters,
  ];

  const consumer = await consumeWorkspaceBuildJobs({
    connectionUrl: env.RABBITMQ_URL,
    prefetch: env.WORKSPACE_BUILD_QUEUE_PREFETCH,
    onMessage: async ({ message, ack, nack }) => {
      try {
        await processWorkspaceBuildJob({
          jobId: message.jobId,
          workerId: env.WORKER_ID,
          leaseDurationMs: env.WORKSPACE_BUILD_JOB_LEASE_DURATION_MS,
          db,
          runtimeAdapters,
          defaultRuntimeAdapterId: env.DEFAULT_RUNTIME_ADAPTER,
          gitHubSourceIntegration,
          registryClient,
          ...(credentialCipher === undefined ? {} : { credentialCipher }),
          ...(launchMaterialStager === undefined ? {} : { launchMaterialStager }),
          ...(imageBuilder === undefined ? {} : { imageBuilder }),
        });
        ack();
      } catch (error) {
        console.error("Workspace build job failed", {
          error,
          jobId: message.jobId,
        });
        nack(false);
      }
    },
  });

  // Run-exec consumer: execute harness runs and deterministic check runs server-side (docker-exec +
  // telemetry ingest), so the SDK can be a thin HTTP client. The API enqueues here when a run is
  // created with a `command` (harness framing) or via execWorkspace (`commands`, exec framing).
  const runExecConsumer = await consumeRunExecJobs({
    connectionUrl: env.RABBITMQ_URL,
    prefetch: env.WORKSPACE_BUILD_QUEUE_PREFETCH,
    onMessage: async ({ message, ack, nack }) => {
      try {
        await processRunExecJob({
          runId: message.runId,
          ...(message.command === undefined ? {} : { command: message.command }),
          ...(message.commands === undefined ? {} : { commands: message.commands }),
          db,
          ...(credentialCipher === undefined ? {} : { credentialCipher }),
          targetOptions,
        });
        ack();
      } catch (error) {
        console.error("Run exec job failed", { error, runId: message.runId });
        nack(false);
      }
    },
  });

  // Lifecycle consumer: execute workspace stop requests (user stop, restart's stop half) — remove
  // the container via the runtime adapter and record the terminal "stopped" state. Runtime mutations
  // stay in the worker so the API never needs a Docker socket.
  const lifecycleConsumer = await consumeWorkspaceLifecycleJobs({
    connectionUrl: env.RABBITMQ_URL,
    prefetch: env.WORKSPACE_BUILD_QUEUE_PREFETCH,
    onMessage: async ({ message, ack, nack }) => {
      try {
        await processWorkspaceStop({
          workspaceId: message.workspaceId,
          runId: message.runId,
          stopReason: message.stopReason,
          db,
          runtimeAdapters,
          // Rotated claude/codex session files are synced back before the container is destroyed.
          ...(credentialCipher === undefined ? {} : { credentialCipher }),
          targetOptions,
          ...(launchMaterialStager === undefined ? {} : { launchMaterialStager }),
        });
        ack();
      } catch (error) {
        console.error("Workspace stop failed", {
          error,
          workspaceId: message.workspaceId,
          runId: message.runId,
        });
        nack(false);
      }
    },
  });

  // Reaper (#5): periodically re-drive build jobs stranded by a dead lease holder. The normal path is
  // RabbitMQ delivery; this is the recovery net for deliveries that were acked-and-discarded when a
  // worker died mid-build. Safe to repeat (idempotent build + container adopt, Stage 1). Retired once
  // pg-boss (Stage 4) provides native per-job lease expiry + single-owner recovery.
  const runReaperTick = (): void => {
    reapStaleWorkspaceBuildJobs({
      db,
      workerId: env.WORKER_ID,
      leaseDurationMs: env.WORKSPACE_BUILD_JOB_LEASE_DURATION_MS,
      runtimeAdapters,
      defaultRuntimeAdapterId: env.DEFAULT_RUNTIME_ADAPTER,
      gitHubSourceIntegration,
      registryClient,
      ...(credentialCipher === undefined ? {} : { credentialCipher }),
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
      reapOrphanedKubernetesResources({ db, adapter: kubernetesAdapter }).catch(
        (error: unknown) => {
          console.error("Kubernetes reconciler tick failed", { error });
        },
      );
    }
    reapExpiredWorkspaces({
      db,
      runtimeAdapters,
      ...(credentialCipher === undefined ? {} : { credentialCipher }),
      targetOptions,
    }).catch((error: unknown) => {
      console.error("Workspace expiry reaper tick failed", { error });
    });
  };
  const expiryReaperTimer = setInterval(
    runExpiryReaperTick,
    env.WORKSPACE_EXPIRY_REAPER_INTERVAL_MS,
  );
  expiryReaperTimer.unref();

  // Keep-fresh sweeper: claude SESSION credentials (kind "credentials-json") only stay fresh when
  // the official CLI runs against them; when no workspace uses an account for hours, the stored
  // access token expires. Every tick, stale accounts are refreshed with a minimal one-turn
  // official-CLI exchange in a private CLAUDE_CONFIG_DIR and persisted newest-wins. Requires the
  // credential cipher — without SEALANT_CREDENTIALS_KEY there is nothing to refresh.
  const claudeRefreshTimer =
    credentialCipher === undefined
      ? undefined
      : setInterval(() => {
          refreshClaudeSessionCredentials({ db, credentialCipher }).catch((error: unknown) => {
            console.error("Claude session refresh tick failed", { error });
          });
        }, CLAUDE_SESSION_REFRESH_INTERVAL_MS);
  claudeRefreshTimer?.unref();

  return {
    stop: async () => {
      clearInterval(reaperTimer);
      clearInterval(expiryReaperTimer);
      if (claudeRefreshTimer !== undefined) {
        clearInterval(claudeRefreshTimer);
      }
      await lifecycleConsumer.cancel();
      await runExecConsumer.cancel();
      await consumer.cancel();
      await rabbitMq.close();
    },
  };
};
