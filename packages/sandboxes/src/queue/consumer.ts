import { createRabbitMqService, type RabbitMqConsumerMessage } from "@sealant/rabbitmq";

import {
  parseSandboxBuildJobRequestedMessage,
  type SandboxBuildJobRequestedMessage,
} from "./messages.js";
import { sandboxBuildQueueName, sandboxBuildQueueTopology } from "./topology.js";

/**
 * Typed message shape delivered to sandbox build queue consumers.
 */
export type SandboxBuildJobConsumerMessage =
  RabbitMqConsumerMessage<SandboxBuildJobRequestedMessage>;

/**
 * Runtime options for sandbox build queue consumption.
 */
export interface ConsumeSandboxBuildJobsOptions {
  readonly connectionUrl: string;
  readonly prefetch?: number;
  readonly onMessage: (message: SandboxBuildJobConsumerMessage) => Promise<void>;
}

/**
 * Starts consuming sandbox build job messages with topology checks.
 */
export const consumeSandboxBuildJobs = async (options: ConsumeSandboxBuildJobsOptions) => {
  const rabbitMq = createRabbitMqService(options.connectionUrl);

  await rabbitMq.assertTopology(sandboxBuildQueueTopology);

  return rabbitMq.consumeJsonMessages({
    queueName: sandboxBuildQueueName,
    ...(options.prefetch === undefined ? {} : { prefetch: options.prefetch }),
    parseMessage: parseSandboxBuildJobRequestedMessage,
    onMessage: options.onMessage,
  });
};
