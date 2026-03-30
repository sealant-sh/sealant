import { assertRabbitMqTopology, getRabbitMqSingleton } from "@sealant/rabbitmq";
import type { Channel } from "amqplib";

export const sandboxBuildQueueName = "sandbox-image-builds";
export const sandboxBuildDeadLetterExchangeName = "sandbox-image-builds.dlx";
export const sandboxBuildDeadLetterQueueName = "sandbox-image-builds.dlq";

export const assertSandboxBuildQueueTopology = async (channel: Channel) => {
  await assertRabbitMqTopology(channel, {
    exchanges: [
      {
        name: sandboxBuildDeadLetterExchangeName,
        type: "direct",
        options: {
          durable: true,
        },
      },
    ],
    queues: [
      {
        name: sandboxBuildDeadLetterQueueName,
        options: {
          durable: true,
          arguments: {
            "x-queue-type": "quorum",
          },
        },
      },
      {
        name: sandboxBuildQueueName,
        options: {
          durable: true,
          arguments: {
            "x-dead-letter-exchange": sandboxBuildDeadLetterExchangeName,
            "x-dead-letter-routing-key": sandboxBuildDeadLetterQueueName,
            "x-queue-type": "quorum",
          },
        },
      },
    ],
    bindings: [
      {
        queueName: sandboxBuildDeadLetterQueueName,
        exchangeName: sandboxBuildDeadLetterExchangeName,
        routingKey: sandboxBuildDeadLetterQueueName,
      },
    ],
  });
};

export const ensureSandboxBuildQueueTopology = async (connectionUrl: string) => {
  const singleton = await getRabbitMqSingleton(connectionUrl);

  await assertSandboxBuildQueueTopology(singleton.publishChannel);
  await assertSandboxBuildQueueTopology(singleton.consumeChannel);
};
