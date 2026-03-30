import {
  publishWorkspaceBuildJobRequested,
  workspaceBuildJobRequestedMessageKind,
} from "@sealant/sandboxes";

import type { AppEnv } from "../env.js";
import type { WorkspaceBuildJobPublisher } from "./types.js";

export const createWorkspaceBuildJobPublisher = (env: AppEnv): WorkspaceBuildJobPublisher => {
  return {
    async publishRequested(input) {
      await publishWorkspaceBuildJobRequested(env.RABBITMQ_URL, {
        kind: workspaceBuildJobRequestedMessageKind,
        jobId: input.jobId,
      });
    },
  };
};
