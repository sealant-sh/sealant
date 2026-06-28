import type { WorkerEnv } from "@sealant/validators/env";

import { startSandboxWorker } from "./sandboxes.js";

// NOTE: the telemetry-ingest worker (`startTelemetryWorker`) is intentionally NOT started here.
// Telemetry now keys its `run_id` FK to the `runs` table (a harness execution), not to
// `sandbox_attempts`. Ingestion is therefore owned by whoever STARTS a run: the SDK forks the
// ingester inline per `harness.run()`. The old per-runtime-instance auto-ingest keyed on the
// attempt id and would violate the new FK. Re-enable it once it is reworked to be run-keyed
// (poll active `runs`, not runtime instances) — see the SDK plan, Phase 3.
export const startWorkers = async (env: WorkerEnv) => {
  const sandboxWorker = await startSandboxWorker(env);

  return {
    stop: async () => {
      await sandboxWorker.stop();
    },
  };
};
