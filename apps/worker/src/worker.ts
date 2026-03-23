import { createDatabaseClientFromEnv, closeDatabaseClient } from "@sealant/db";
import { createBuildkitOsExecutor } from "@sealant/os-integration-buildkit";
import {
  DockerRuntimeAdapter,
  K3sRuntimeAdapter,
  K8sRuntimeAdapter,
} from "@sealant/runtime-adapters-api";
import { closeRabbitMqSingleton, consumeWorkspaceBuildJobs } from "@sealant/workspace-build-queue";

import { createRegistryClient } from "./create-registry-client.js";
import type { WorkerEnv } from "./env.js";
import { processWorkspaceBuildJob } from "./process-workspace-build-job.js";

export const startWorker = async (env: WorkerEnv) => {
  const dbClient = await createDatabaseClientFromEnv(env);
  const registryClient = createRegistryClient(env);
  const executors = [createBuildkitOsExecutor("fedora"), createBuildkitOsExecutor("arch")];
  const runtimeAdapters = [
    new DockerRuntimeAdapter({
      defaultSshAuthorizedKeysFile: env.DEFAULT_SSH_AUTHORIZED_KEYS_FILE,
      sshBindHost: env.DEFAULT_SSH_BIND_HOST,
    }),
    new K8sRuntimeAdapter(),
    new K3sRuntimeAdapter(),
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
          dbClient,
          executors,
          runtimeAdapters,
          defaultRuntimeAdapterId: env.DEFAULT_RUNTIME_ADAPTER,
          defaultStartupMode: env.DEFAULT_WORKSPACE_STARTUP_MODE,
          defaultIdleCommand: env.DEFAULT_WORKSPACE_IDLE_COMMAND,
          defaultSshEnabled: env.DEFAULT_WORKSPACE_SSH_ENABLED,
          defaultSshListenPort: env.DEFAULT_WORKSPACE_SSH_LISTEN_PORT,
          registryClient,
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

  return {
    stop: async () => {
      await consumer.cancel();
      await closeRabbitMqSingleton();
      closeDatabaseClient(dbClient);
    },
  };
};
