import { createRabbitMqService, type RabbitMqConsumerMessage } from "@sealant/rabbitmq";

import {
  parseSandboxBuildJobRequestedMessage,
  type SandboxBuildJobRequestedMessage,
} from "./messages.js";
import { sandboxBuildQueueName, sandboxBuildQueueTopology } from "./topology.js";

export type SandboxBuildJobConsumerMessage =
  RabbitMqConsumerMessage<SandboxBuildJobRequestedMessage>;

export interface ConsumeSandboxBuildJobsOptions {
  readonly connectionUrl: string;
  readonly prefetch?: number;
  readonly onMessage: (message: SandboxBuildJobConsumerMessage) => Promise<void>;
}

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
