import { closeDatabaseClient, createDatabaseClientFromEnv } from "@sealant/db";
import { closeRabbitMqSingleton } from "@sealant/rabbitmq";
import {
  consumeWorkspaceBuildJobs,
  createBuildkitOsExecutor,
  createZotRegistryClient,
  DockerRuntimeAdapter,
  K3sRuntimeAdapter,
  K8sRuntimeAdapter,
  processSandboxBuildJob,
} from "@sealant/sandboxes";
import { createGitHubSourceIntegration } from "@sealant/source-integrations";

import type { WorkerEnv } from "../env.js";

export const startSandboxWorker = async (env: WorkerEnv) => {
  const dbClient = await createDatabaseClientFromEnv(env);
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
  const executors = [
    createBuildkitOsExecutor("fedora"),
    createBuildkitOsExecutor("arch"),
    createBuildkitOsExecutor("nix"),
  ];
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

  const consumer = await consumeWorkspaceBuildJobs({
    connectionUrl: env.RABBITMQ_URL,
    prefetch: env.WORKSPACE_BUILD_QUEUE_PREFETCH,
    onMessage: async ({ message, ack, nack }) => {
      try {
        await processSandboxBuildJob({
          jobId: message.jobId,
          workerId: env.WORKER_ID,
          leaseDurationMs: env.WORKSPACE_BUILD_JOB_LEASE_DURATION_MS,
          dbClient,
          executors,
          runtimeAdapters,
          defaultRuntimeAdapterId: env.DEFAULT_RUNTIME_ADAPTER,
          defaultStartupMode: env.DEFAULT_WORKSPACE_STARTUP_MODE,
          defaultIdleCommand: env.DEFAULT_WORKSPACE_IDLE_COMMAND,
          defaultSshEnabled: env.DEFAULT_WORKSPACE_SSH_ENABLED,
          defaultSshListenPort: env.DEFAULT_WORKSPACE_SSH_LISTEN_PORT,
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
      await closeRabbitMqSingleton();
      closeDatabaseClient(dbClient);
    },
  };
};
