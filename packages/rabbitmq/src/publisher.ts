import type { Options } from "amqplib";

import { getRabbitMqSingleton } from "./singleton.js";

const encodeJsonMessage = (message: unknown): Buffer => {
  return Buffer.from(JSON.stringify(message), "utf8");
};

export interface PublishRabbitMqJsonMessageInput {
  readonly connectionUrl: string;
  readonly queueName: string;
  readonly message: unknown;
  readonly properties?: Options.Publish;
}

export const publishRabbitMqJsonMessage = async (input: PublishRabbitMqJsonMessageInput) => {
  const singleton = await getRabbitMqSingleton(input.connectionUrl);

  await new Promise<void>((resolve, reject) => {
    singleton.publishChannel.sendToQueue(
      input.queueName,
      encodeJsonMessage(input.message),
      {
        contentType: "application/json",
        deliveryMode: 2,
        persistent: true,
        timestamp: Date.now(),
        ...input.properties,
      },
      (error) => {
        if (error === null || error === undefined) {
          resolve();
          return;
        }

        reject(error);
      },
    );
  });
};
