import { createRabbitMqService, type RabbitMqConsumerMessage } from "@sealant/rabbitmq";

import {
  parseWorkspaceBuildJobRequestedMessage,
  type WorkspaceBuildJobRequestedMessage,
} from "./messages.js";
import { workspaceBuildQueueName, workspaceBuildQueueTopology } from "./topology.js";

/**
 * Typed message shape delivered to workspace build queue consumers.
 */
export type WorkspaceBuildJobConsumerMessage =
  RabbitMqConsumerMessage<WorkspaceBuildJobRequestedMessage>;

/**
 * Runtime options for workspace build queue consumption.
 */
export interface ConsumeWorkspaceBuildJobsOptions {
  readonly connectionUrl: string;
  readonly prefetch?: number;
  readonly onMessage: (message: WorkspaceBuildJobConsumerMessage) => Promise<void>;
}

/**
 * Starts consuming workspace build job messages with topology checks.
 */
export const consumeWorkspaceBuildJobs = async (options: ConsumeWorkspaceBuildJobsOptions) => {
  const rabbitMq = createRabbitMqService(options.connectionUrl);

  await rabbitMq.assertTopology(workspaceBuildQueueTopology);

  return rabbitMq.consumeJsonMessages({
    queueName: workspaceBuildQueueName,
    ...(options.prefetch === undefined ? {} : { prefetch: options.prefetch }),
    parseMessage: parseWorkspaceBuildJobRequestedMessage,
    onMessage: options.onMessage,
  });
};
