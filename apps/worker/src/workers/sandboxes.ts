import { closeDatabaseClient, createDatabaseClientFromEnv } from "@sealant/db";
import { createRabbitMqService } from "@sealant/rabbitmq";
import {
  consumeSandboxBuildJobs,
  createZotRegistryClient,
  DockerRuntimeAdapter,
  K3sRuntimeAdapter,
  K8sRuntimeAdapter,
  processSandboxBuildJob,
} from "@sealant/sandboxes";
import { createGitHubSourceIntegration } from "@sealant/source-integrations";
import type { WorkerEnv } from "@sealant/validators/env";

/**
 * Starts the sandbox worker loop and returns a graceful shutdown handle.
 */
export const startSandboxWorker = async (env: WorkerEnv) => {
  const dbClient = await createDatabaseClientFromEnv(env);
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
          dbClient,
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

  return {
    stop: async () => {
      await consumer.cancel();
      await rabbitMq.close();
      closeDatabaseClient(dbClient);
    },
  };
};
