import { createSealantDB, type DB } from "@sealant/db";
import { createRabbitMqService } from "@sealant/rabbitmq";
import {
  consumeRunExecJobs,
  consumeSandboxBuildJobs,
  createZotRegistryClient,
  DockerRuntimeAdapter,
  K3sRuntimeAdapter,
  K8sRuntimeAdapter,
  processSandboxBuildJob,
  reapStaleSandboxBuildJobs,
} from "@sealant/sandboxes";

import { processRunExecJob } from "./process-run-exec-job.js";
import { createGitHubSourceIntegration } from "@sealant/source-integrations";
import type { WorkerEnv } from "@sealant/validators/env";

const createDatabaseFromEnv = async (env: WorkerEnv): Promise<DB> => {
  return createSealantDB(env.DATABASE_URL);
};

/**
 * Starts the sandbox worker loop and returns a graceful shutdown handle.
 */
export const startSandboxWorker = async (env: WorkerEnv) => {
  const db = await createDatabaseFromEnv(env);
  const rabbitMq = createRabbitMqService(env.RABBITMQ_URL);
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
  const runtimeAdapters = [
    new DockerRuntimeAdapter({
      dockerSocketPath: env.DOCKER_SOCKET_PATH,
      defaultSshAuthorizedKeysFile: env.DEFAULT_SSH_AUTHORIZED_KEYS_FILE,
      sshBindHost: env.DEFAULT_SSH_BIND_HOST,
      sshEndpointExposureStrategy: env.DEFAULT_SSH_ENDPOINT_EXPOSURE_STRATEGY,
    }),
    new K8sRuntimeAdapter(),
    new K3sRuntimeAdapter(),
  ];

  const consumer = await consumeSandboxBuildJobs({
    connectionUrl: env.RABBITMQ_URL,
    prefetch: env.SANDBOX_BUILD_QUEUE_PREFETCH,
    onMessage: async ({ message, ack, nack }) => {
      try {
        await processSandboxBuildJob({
          jobId: message.jobId,
          workerId: env.WORKER_ID,
          leaseDurationMs: env.SANDBOX_BUILD_JOB_LEASE_DURATION_MS,
          db,
          runtimeAdapters,
          defaultRuntimeAdapterId: env.DEFAULT_RUNTIME_ADAPTER,
          gitHubSourceIntegration,
          registryClient,
        });
        ack();
      } catch (error) {
        console.error("Sandbox build job failed", {
          error,
          jobId: message.jobId,
        });
        nack(false);
      }
    },
  });

  // Run-exec consumer: execute harness runs server-side (docker-exec + telemetry ingest), so the SDK
  // can be a thin HTTP client. The API enqueues here when a run is created with a `command`.
  const runExecConsumer = await consumeRunExecJobs({
    connectionUrl: env.RABBITMQ_URL,
    prefetch: env.SANDBOX_BUILD_QUEUE_PREFETCH,
    onMessage: async ({ message, ack, nack }) => {
      try {
        await processRunExecJob({ runId: message.runId, command: message.command, db });
        ack();
      } catch (error) {
        console.error("Run exec job failed", { error, runId: message.runId });
        nack(false);
      }
    },
  });

  // Reaper (#5): periodically re-drive build jobs stranded by a dead lease holder. The normal path is
  // RabbitMQ delivery; this is the recovery net for deliveries that were acked-and-discarded when a
  // worker died mid-build. Safe to repeat (idempotent build + container adopt, Stage 1). Retired once
  // pg-boss (Stage 4) provides native per-job lease expiry + single-owner recovery.
  const runReaperTick = (): void => {
    reapStaleSandboxBuildJobs({
      db,
      workerId: env.WORKER_ID,
      leaseDurationMs: env.SANDBOX_BUILD_JOB_LEASE_DURATION_MS,
      runtimeAdapters,
      defaultRuntimeAdapterId: env.DEFAULT_RUNTIME_ADAPTER,
      gitHubSourceIntegration,
      registryClient,
    }).catch((error: unknown) => {
      console.error("Sandbox build job reaper tick failed", { error });
    });
  };
  const reaperTimer = setInterval(runReaperTick, env.SANDBOX_BUILD_JOB_REAPER_INTERVAL_MS);
  // Don't let the reaper interval keep the process alive on its own.
  reaperTimer.unref();

  return {
    stop: async () => {
      clearInterval(reaperTimer);
      await runExecConsumer.cancel();
      await consumer.cancel();
      await rabbitMq.close();
    },
  };
};
