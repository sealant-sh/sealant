import { createDatabaseClientFromEnv, closeDatabaseClient } from "@sealant/db";
import { NixOsExecutor } from "@sealant/os-integration-nix";
import { closeRabbitMqSingleton, consumeWorkspaceBuildJobs } from "@sealant/workspace-build-queue";

import { createRegistryClient } from "./create-registry-client.js";
import type { WorkerEnv } from "./env.js";
import { processWorkspaceBuildJob } from "./process-workspace-build-job.js";

export const startWorker = async (env: WorkerEnv) => {
  const dbClient = await createDatabaseClientFromEnv(env);
  const registryClient = createRegistryClient(env);
  const executor = new NixOsExecutor();

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
          executor,
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
