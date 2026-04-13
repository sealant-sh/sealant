import { makeSealantDBLayer, SealantDB, type DB } from "@sealant/db";
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
import { Effect, ManagedRuntime } from "effect";

const createDatabaseRuntimeFromEnv = async (env: WorkerEnv) => {
  const runtime = ManagedRuntime.make(makeSealantDBLayer(env.DATABASE_URL));
  const db = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* SealantDB;
    }),
  );

  return {
    db,
    stop: async () => {
      await runtime.dispose();
    },
  };
};

/**
 * Starts the sandbox worker loop and returns a graceful shutdown handle.
 */
export const startSandboxWorker = async (env: WorkerEnv) => {
  const database = await createDatabaseRuntimeFromEnv(env);
  const db: DB = database.db;
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
      ...(env.DEFAULT_DOCKER_SANDBOX_NETWORK === undefined
        ? {}
        : { sandboxNetwork: env.DEFAULT_DOCKER_SANDBOX_NETWORK }),
      defaultSshAuthorizedKeysFile: env.DEFAULT_SSH_AUTHORIZED_KEYS_FILE,
      sshBindHost: env.DEFAULT_SSH_BIND_HOST,
      sshEndpointExposureStrategy: env.DEFAULT_SSH_ENDPOINT_EXPOSURE_STRATEGY,
    }),
    new K8sRuntimeAdapter(),
    new K3sRuntimeAdapter(),
  ];

  let consumer: Awaited<ReturnType<typeof consumeSandboxBuildJobs>> | undefined;

  try {
    consumer = await consumeSandboxBuildJobs({
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
  } catch (error) {
    await database.stop().catch(() => null);
    throw error;
  }

  return {
    stop: async () => {
      await consumer.cancel();
      await rabbitMq.close();
      await database.stop();
    },
  };
};
