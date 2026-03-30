import type { ConsumeMessage } from "amqplib";

import { getRabbitMqSingleton } from "./singleton.js";

export interface RabbitMqConsumerMessage<TMessage> {
  readonly message: TMessage;
  readonly rawMessage: ConsumeMessage;
  ack(): void;
  nack(requeue?: boolean): void;
}

export interface ConsumeRabbitMqJsonMessagesOptions<TMessage> {
  readonly connectionUrl: string;
  readonly queueName: string;
  readonly prefetch?: number;
  readonly parseMessage: (input: unknown) => TMessage;
  readonly onMessage: (message: RabbitMqConsumerMessage<TMessage>) => Promise<void>;
}

export const consumeRabbitMqJsonMessages = async <TMessage>(
  options: ConsumeRabbitMqJsonMessagesOptions<TMessage>,
) => {
  const singleton = await getRabbitMqSingleton(options.connectionUrl);
  await singleton.consumeChannel.prefetch(options.prefetch ?? 1);

  const consumeResult = await singleton.consumeChannel.consume(
    options.queueName,
    async (rawMessage) => {
      if (rawMessage === null) {
        return;
      }

      try {
        const message = options.parseMessage(
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
