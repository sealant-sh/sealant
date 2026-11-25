import {
  bundledRelease,
  describeSetting,
  installProcessObservability,
  observabilitySettingFromEnv,
} from "@sealant/observability";
import { urlForDisplay } from "@sealant/validators/url-for-display";

import { env } from "./runtime-env.js";
import { startWorkers } from "./workers/index.js";

const retryDelayMs = 2000;
const databaseUrl = new URL(env.DATABASE_URL);

// Before any Effect root runs: each runs with these observers (traces, logs and errors to Sentry
// when SENTRY_DSN is set; the credential redaction always).
const observability = await installProcessObservability(
  observabilitySettingFromEnv(process.env, {
    serviceName: "sealant-worker",
    buildRelease: bundledRelease(),
  }),
);

console.log("Sealant worker starting", {
  workerId: env.WORKER_ID,
  imageStore:
    env.REGISTRY_BASE_URL === undefined ? "docker-engine" : urlForDisplay(env.REGISTRY_BASE_URL),
  database: `${databaseUrl.protocol}//${databaseUrl.host}${databaseUrl.pathname}`,
  defaultRuntimeAdapter: env.DEFAULT_RUNTIME_ADAPTER,
  defaultSshBindHost: env.DEFAULT_SSH_BIND_HOST,
  telemetry: describeSetting(observability.setting),
});

const wait = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

let worker = await (async () => {
  let reported = false;
  while (true) {
    try {
      return await startWorkers(env);
    } catch (error) {
      console.error("Sealant worker failed to start; retrying", {
        error,
        retryDelayMs,
      });
      // The first failure is the issue; the retries every two seconds after it would only repeat it.
      if (!reported) {
        observability.captureError(error, { tags: { "sealant.boundary": "worker.start" } });
        reported = true;
      }
      await wait(retryDelayMs);
    }
  }
})();

const shutdown = async () => {
  await worker.stop();
  await observability.shutdown();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
