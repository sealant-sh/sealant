import { createJobQueueService } from "@sealant/jobs";
import type { TraceCarrier } from "@sealant/observability";

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
  /** The sender's trace, which the build continues. */
  trace?: TraceCarrier,
) => {
  const message = parseWorkspaceBuildJobRequestedMessage(input);
  const jobs = createJobQueueService(databaseUrl);

  await jobs.publishJson({ queue: workspaceBuildQueue, message, trace });
};
