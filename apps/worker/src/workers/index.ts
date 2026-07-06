import type { WorkerEnv } from "@sealant/validators/env";

import { startSandboxWorker } from "./sandboxes.js";
import { startTelemetryWorker } from "./telemetry.js";

// The telemetry worker is RUN-KEYED (the rework its old per-runtime-instance version was disabled
// pending): it polls running INTERACTIVE runs — real `runs` rows, so the telemetry FKs hold — and
// ingests each on its own control connection. One-shot harness runs are still ingested inline by
// the run-exec worker (captureRun); the two paths dedup on (runtime_id, sequence) and agree on
// attribution via execution ids.
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
