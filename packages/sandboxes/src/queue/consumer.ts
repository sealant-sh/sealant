import { consumeRabbitMqJsonMessages, type RabbitMqConsumerMessage } from "@sealant/rabbitmq";

import {
  parseWorkspaceBuildJobRequestedMessage,
  type WorkspaceBuildJobRequestedMessage,
} from "./messages.js";
import { ensureWorkspaceBuildQueueTopology, workspaceBuildQueueName } from "./topology.js";

export type WorkspaceBuildJobConsumerMessage =
  RabbitMqConsumerMessage<WorkspaceBuildJobRequestedMessage>;

export interface ConsumeWorkspaceBuildJobsOptions {
  readonly connectionUrl: string;
  readonly prefetch?: number;
  readonly onMessage: (message: WorkspaceBuildJobConsumerMessage) => Promise<void>;
}

export const consumeWorkspaceBuildJobs = async (options: ConsumeWorkspaceBuildJobsOptions) => {
  await ensureWorkspaceBuildQueueTopology(options.connectionUrl);

  return consumeRabbitMqJsonMessages({
    connectionUrl: options.connectionUrl,
    queueName: workspaceBuildQueueName,
    ...(options.prefetch === undefined ? {} : { prefetch: options.prefetch }),
    parseMessage: parseWorkspaceBuildJobRequestedMessage,
    onMessage: options.onMessage,
  });
};
