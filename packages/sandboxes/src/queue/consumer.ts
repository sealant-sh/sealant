import { consumeRabbitMqJsonMessages, type RabbitMqConsumerMessage } from "@sealant/rabbitmq";

import {
  parseSandboxBuildJobRequestedMessage,
  type SandboxBuildJobRequestedMessage,
} from "./messages.js";
import { ensureSandboxBuildQueueTopology, sandboxBuildQueueName } from "./topology.js";

export type SandboxBuildJobConsumerMessage =
  RabbitMqConsumerMessage<SandboxBuildJobRequestedMessage>;

export interface ConsumeSandboxBuildJobsOptions {
  readonly connectionUrl: string;
  readonly prefetch?: number;
  readonly onMessage: (message: SandboxBuildJobConsumerMessage) => Promise<void>;
}

export const consumeSandboxBuildJobs = async (options: ConsumeSandboxBuildJobsOptions) => {
  await ensureSandboxBuildQueueTopology(options.connectionUrl);

  return consumeRabbitMqJsonMessages({
    connectionUrl: options.connectionUrl,
    queueName: sandboxBuildQueueName,
    ...(options.prefetch === undefined ? {} : { prefetch: options.prefetch }),
    parseMessage: parseSandboxBuildJobRequestedMessage,
    onMessage: options.onMessage,
  });
};
