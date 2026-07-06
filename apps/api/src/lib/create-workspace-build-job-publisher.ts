import type { AppEnv } from "@sealant/validators/env";
import {
  publishWorkspaceBuildJobRequested,
  workspaceBuildJobRequestedMessageKind,
} from "@sealant/workspaces";

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
