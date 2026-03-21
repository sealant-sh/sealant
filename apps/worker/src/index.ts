import { env } from "./env.js";
import { startWorker } from "./worker.js";

const retryDelayMs = 2000;

console.log("Sealant worker starting", {
  workerId: env.WORKER_ID,
  rabbitMqUrl: env.RABBITMQ_URL,
  registryBaseUrl: env.REGISTRY_BASE_URL,
  databaseFilePath: env.DATABASE_FILE_PATH,
  composeProjectName: env.COMPOSE_PROJECT_NAME,
  nixBuilderService: env.NIX_BUILDER_SERVICE,
  defaultRuntimeAdapter: env.DEFAULT_RUNTIME_ADAPTER,
});

const wait = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

let worker = await (async () => {
  while (true) {
    try {
      return await startWorker(env);
    } catch (error) {
      console.error("Sealant worker failed to start; retrying", {
        error,
        retryDelayMs,
      });
      await wait(retryDelayMs);
    }
  }
})();

const shutdown = async () => {
  await worker.stop();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
