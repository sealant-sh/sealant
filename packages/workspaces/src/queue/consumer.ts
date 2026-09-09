import { createJobQueueService, type JobQueueConsumerMessage } from "@sealant/jobs";

import {
  parseWorkspaceBuildJobRequestedMessage,
  type WorkspaceBuildJobRequestedMessage,
} from "./messages.js";
import { workspaceBuildQueue } from "./topology.js";

/**
 * Typed message shape delivered to workspace build queue consumers.
 */
export type WorkspaceBuildJobConsumerMessage =
  JobQueueConsumerMessage<WorkspaceBuildJobRequestedMessage>;

/**
 * Runtime options for workspace build queue consumption.
 */
export interface ConsumeWorkspaceBuildJobsOptions {
  readonly databaseUrl: string;
  readonly concurrency?: number;
  /** Throwing fails the delivery (dead-lettered, never retried). */
  readonly onMessage: (message: WorkspaceBuildJobConsumerMessage) => Promise<void>;
}

/**
 * Starts consuming workspace build job messages.
 */
export const consumeWorkspaceBuildJobs = async (options: ConsumeWorkspaceBuildJobsOptions) => {
  const jobs = createJobQueueService(options.databaseUrl);

  return jobs.consumeJson({
    queue: workspaceBuildQueue,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    parseMessage: parseWorkspaceBuildJobRequestedMessage,
    onMessage: options.onMessage,
  });
};
