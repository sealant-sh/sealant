import { env } from "./env.js";
import { startWorkers } from "./workers/index.js";

const retryDelayMs = 2000;

console.log("Sealant worker starting", {
  workerId: env.WORKER_ID,
  rabbitMqUrl: env.RABBITMQ_URL,
  registryBaseUrl: env.REGISTRY_BASE_URL,
  databaseFilePath: env.DATABASE_FILE_PATH,
  defaultRuntimeAdapter: env.DEFAULT_RUNTIME_ADAPTER,
  defaultWorkspaceStartupMode: env.DEFAULT_WORKSPACE_STARTUP_MODE,
  defaultWorkspaceSshEnabled: env.DEFAULT_WORKSPACE_SSH_ENABLED,
  defaultWorkspaceSshListenPort: env.DEFAULT_WORKSPACE_SSH_LISTEN_PORT,
  defaultSshAuthorizedKeysFile: env.DEFAULT_SSH_AUTHORIZED_KEYS_FILE,
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
