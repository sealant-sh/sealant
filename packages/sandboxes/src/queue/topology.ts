import {
  assertRabbitMqTopology,
  createRabbitMqService,
  type RabbitMqTopology,
} from "@sealant/rabbitmq";
import type { Channel } from "amqplib";

/**
 * Primary queue used for sandbox build job orchestration.
 */
export const sandboxBuildQueueName = "sandbox-image-builds";

/**
 * Dead-letter exchange for sandbox build job failures.
 */
export const sandboxBuildDeadLetterExchangeName = "sandbox-image-builds.dlx";

/**
 * Dead-letter queue bound to the sandbox build DLX.
 */
export const sandboxBuildDeadLetterQueueName = "sandbox-image-builds.dlq";

/**
 * Canonical RabbitMQ topology used by all sandbox build queue producers/consumers.
 */
export const sandboxBuildQueueTopology: RabbitMqTopology = {
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
};

/**
 * Asserts sandbox build topology on a provided channel.
 */
export const assertSandboxBuildQueueTopology = async (channel: Channel) => {
  await assertRabbitMqTopology(channel, sandboxBuildQueueTopology);
};

/**
 * Ensures topology exists on both publish and consume channels for a connection.
 */
export const ensureSandboxBuildQueueTopology = async (connectionUrl: string) => {
  const rabbitMq = createRabbitMqService(connectionUrl);

  await rabbitMq.assertTopology(sandboxBuildQueueTopology);
};
