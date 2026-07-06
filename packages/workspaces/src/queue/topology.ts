import {
  assertRabbitMqTopology,
  createRabbitMqService,
  type RabbitMqTopology,
} from "@sealant/rabbitmq";
import type { Channel } from "amqplib";

/**
 * Primary queue used for workspace build job orchestration.
 */
export const workspaceBuildQueueName = "workspace-image-builds";

/**
 * Dead-letter exchange for workspace build job failures.
 */
export const workspaceBuildDeadLetterExchangeName = "workspace-image-builds.dlx";

/**
 * Dead-letter queue bound to the workspace build DLX.
 */
export const workspaceBuildDeadLetterQueueName = "workspace-image-builds.dlq";

/**
 * Canonical RabbitMQ topology used by all workspace build queue producers/consumers.
 */
export const workspaceBuildQueueTopology: RabbitMqTopology = {
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
};

/**
 * Asserts workspace build topology on a provided channel.
 */
export const assertWorkspaceBuildQueueTopology = async (channel: Channel) => {
  await assertRabbitMqTopology(channel, workspaceBuildQueueTopology);
};

/**
 * Ensures topology exists on both publish and consume channels for a connection.
 */
export const ensureWorkspaceBuildQueueTopology = async (connectionUrl: string) => {
  const rabbitMq = createRabbitMqService(connectionUrl);

  await rabbitMq.assertTopology(workspaceBuildQueueTopology);
};
