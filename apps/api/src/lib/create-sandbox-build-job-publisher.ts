import {
  publishSandboxBuildJobRequested,
  sandboxBuildJobRequestedMessageKind,
} from "@sealant/sandboxes";
import type { AppEnv } from "@sealant/validators/env";

import type { SandboxBuildJobPublisher } from "./types.js";

export const createSandboxBuildJobPublisher = (env: AppEnv): SandboxBuildJobPublisher => {
  return {
    async publishRequested(input) {
      await publishSandboxBuildJobRequested(env.RABBITMQ_URL, {
        kind: sandboxBuildJobRequestedMessageKind,
        jobId: input.jobId,
      });
    },
  };
};
