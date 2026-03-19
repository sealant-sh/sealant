import type { ConsumeMessage } from "amqplib";

import {
  parseWorkspaceBuildJobRequestedMessage,
  type WorkspaceBuildJobRequestedMessage,
} from "./messages.js";
import { getRabbitMqSingleton } from "./singleton.js";
import { workspaceBuildQueueName } from "./topology.js";

export interface WorkspaceBuildJobConsumerMessage {
  readonly message: WorkspaceBuildJobRequestedMessage;
  readonly rawMessage: ConsumeMessage;
  ack(): void;
  nack(requeue?: boolean): void;
}

export interface ConsumeWorkspaceBuildJobsOptions {
  readonly connectionUrl: string;
  readonly prefetch?: number;
  readonly onMessage: (message: WorkspaceBuildJobConsumerMessage) => Promise<void>;
}

export const consumeWorkspaceBuildJobs = async (options: ConsumeWorkspaceBuildJobsOptions) => {
  const singleton = await getRabbitMqSingleton(options.connectionUrl);
  await singleton.consumeChannel.prefetch(options.prefetch ?? 1);

  const consumeResult = await singleton.consumeChannel.consume(
    workspaceBuildQueueName,
    async (rawMessage) => {
      if (rawMessage === null) {
        return;
      }

      try {
        const message = parseWorkspaceBuildJobRequestedMessage(
          JSON.parse(rawMessage.content.toString("utf8")) as unknown,
        );

        await options.onMessage({
          message,
          rawMessage,
          ack() {
            singleton.consumeChannel.ack(rawMessage);
          },
          nack(requeue = false) {
            singleton.consumeChannel.nack(rawMessage, false, requeue);
          },
        });
      } catch {
        singleton.consumeChannel.nack(rawMessage, false, false);
      }
    },
    {
      noAck: false,
    },
  );

  return {
    consumerTag: consumeResult.consumerTag,
    cancel: async () => {
      await singleton.consumeChannel.cancel(consumeResult.consumerTag);
    },
  };
};
