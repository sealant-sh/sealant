import type { WorkerEnv } from "@sealant/validators/env";

import { startTelemetryWorker } from "./telemetry.js";
import { startWorkspaceWorker } from "./workspaces.js";

// The telemetry worker is RUN-KEYED (the rework its old per-runtime-instance version was disabled
// pending): it polls running INTERACTIVE runs — real `runs` rows, so the telemetry FKs hold — and
// ingests each on its own control connection. One-shot harness runs are still ingested inline by
// the run-exec worker (captureRun); the two paths dedup on (runtime_id, sequence) and agree on
// attribution via execution ids.
export const startWorkers = async (env: WorkerEnv) => {
  const workspaceWorker = await startWorkspaceWorker(env);
  const telemetryWorker = await startTelemetryWorker(env);

  return {
    stop: async () => {
      await telemetryWorker.stop();
      await workspaceWorker.stop();
    },
  };
};
