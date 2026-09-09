import { createJobQueueService } from "@sealant/jobs";

import {
  parseWorkspaceBuildJobRequestedMessage,
  type WorkspaceBuildJobRequestedMessage,
} from "./messages.js";
import { workspaceBuildQueue } from "./topology.js";

/**
 * Publishes a validated workspace build request message to the job queue.
 */
export const publishWorkspaceBuildJobRequested = async (
  databaseUrl: string,
  input: WorkspaceBuildJobRequestedMessage,
) => {
  const message = parseWorkspaceBuildJobRequestedMessage(input);
  const jobs = createJobQueueService(databaseUrl);

  await jobs.publishJson({ queue: workspaceBuildQueue, message });
};
