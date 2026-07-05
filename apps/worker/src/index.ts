import { env } from "./runtime-env.js";
import { startWorkers } from "./workers/index.js";

const retryDelayMs = 2000;
const databaseUrl = new URL(env.DATABASE_URL);

console.log("Sealant worker starting", {
  workerId: env.WORKER_ID,
  rabbitMqUrl: env.RABBITMQ_URL,
  registryBaseUrl: env.REGISTRY_BASE_URL,
  database: `${databaseUrl.protocol}//${databaseUrl.host}${databaseUrl.pathname}`,
  defaultRuntimeAdapter: env.DEFAULT_RUNTIME_ADAPTER,
  defaultSshBindHost: env.DEFAULT_SSH_BIND_HOST,
});

const wait = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

let worker = await (async () => {
  while (true) {
    try {
      return await startWorkers(env);
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
