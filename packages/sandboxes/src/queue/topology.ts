import { assertRabbitMqTopology, getRabbitMqSingleton } from "@sealant/rabbitmq";
import type { Channel } from "amqplib";

export const workspaceBuildQueueName = "workspace-image-builds";
export const workspaceBuildDeadLetterExchangeName = "workspace-image-builds.dlx";
export const workspaceBuildDeadLetterQueueName = "workspace-image-builds.dlq";

export const assertWorkspaceBuildQueueTopology = async (channel: Channel) => {
  await assertRabbitMqTopology(channel, {
    exchanges: [
      {
        name: workspaceBuildDeadLetterExchangeName,
        type: "direct",
        options: {
          durable: true,
        },
      },
    ],
    queues: [
      {
        name: workspaceBuildDeadLetterQueueName,
        options: {
          durable: true,
          arguments: {
            "x-queue-type": "quorum",
          },
        },
      },
      {
        name: workspaceBuildQueueName,
        options: {
          durable: true,
          arguments: {
            "x-dead-letter-exchange": workspaceBuildDeadLetterExchangeName,
            "x-dead-letter-routing-key": workspaceBuildDeadLetterQueueName,
            "x-queue-type": "quorum",
          },
        },
      },
    ],
    bindings: [
      {
        queueName: workspaceBuildDeadLetterQueueName,
        exchangeName: workspaceBuildDeadLetterExchangeName,
        routingKey: workspaceBuildDeadLetterQueueName,
      },
    ],
  });
};

export const ensureWorkspaceBuildQueueTopology = async (connectionUrl: string) => {
  const singleton = await getRabbitMqSingleton(connectionUrl);

  await assertWorkspaceBuildQueueTopology(singleton.publishChannel);
  await assertWorkspaceBuildQueueTopology(singleton.consumeChannel);
};
