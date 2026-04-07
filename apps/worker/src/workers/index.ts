import type { WorkerEnv } from "@sealant/validators/env";

import { startSandboxWorker } from "./sandboxes.js";

export const startWorkers = async (env: WorkerEnv) => {
  const sandboxWorker = await startSandboxWorker(env);

  return {
    stop: async () => {
      await sandboxWorker.stop();
    },
  };
};
