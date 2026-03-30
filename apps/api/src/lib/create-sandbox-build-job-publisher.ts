import {
  publishSandboxBuildJobRequested,
  sandboxBuildJobRequestedMessageKind,
} from "@sealant/sandboxes";

import type { AppEnv } from "../env.js";
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
