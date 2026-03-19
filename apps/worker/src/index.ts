import { env } from "./env.js";
import { startWorker } from "./worker.js";

console.log("Sealant worker starting", {
  workerId: env.WORKER_ID,
  rabbitMqUrl: env.RABBITMQ_URL,
  registryBaseUrl: env.REGISTRY_BASE_URL,
  databaseFilePath: env.DATABASE_FILE_PATH,
});

const worker = await startWorker(env);

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
