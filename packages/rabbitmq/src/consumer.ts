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

      // Settle each delivery exactly once. A second ack/nack on the same delivery is a
      // channel-level protocol error in AMQP and would tear the channel down, so ack/nack are
      // made idempotent and the catch-all only nacks when nothing settled it yet.
      let settled = false;
      const settleOnce = (settle: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        settle();
      };

      try {
        const message = options.parseMessage(
          JSON.parse(rawMessage.content.toString("utf8")) as unknown,
        );

        await options.onMessage({
          message,
          rawMessage,
          ack() {
            settleOnce(() => singleton.consumeChannel.ack(rawMessage));
          },
          nack(requeue = false) {
            settleOnce(() => singleton.consumeChannel.nack(rawMessage, false, requeue));
          },
        });

        // A handler that resolved without settling would otherwise leak the delivery (and stall
        // the prefetch window). Nack it (the queue dead-letters requeue=false) and warn, so a
        // forgotten ack/nack surfaces instead of silently dropping the message.
        if (!settled) {
          console.warn("[rabbitmq] message handler resolved without ack/nack; dead-lettering", {
            queue: options.queueName,
            deliveryTag: rawMessage.fields.deliveryTag,
          });
          settleOnce(() => singleton.consumeChannel.nack(rawMessage, false, false));
        }
      } catch (error) {
        console.error("[rabbitmq] message handler failed; dead-lettering delivery", {
          queue: options.queueName,
          deliveryTag: rawMessage.fields.deliveryTag,
          error: error instanceof Error ? error.message : String(error),
        });
        settleOnce(() => singleton.consumeChannel.nack(rawMessage, false, false));
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
