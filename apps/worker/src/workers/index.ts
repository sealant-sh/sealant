import type { WorkerEnv } from "@sealant/validators/env";

import { startSandboxWorker } from "./sandboxes.js";
import { startTelemetryWorker } from "./telemetry.js";

export const startWorkers = async (env: WorkerEnv) => {
  const sandboxWorker = await startSandboxWorker(env);
  const telemetryWorker = await startTelemetryWorker(env);

  return {
    stop: async () => {
      await telemetryWorker.stop();
      await sandboxWorker.stop();
    },
  };
};
