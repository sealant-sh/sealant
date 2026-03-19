import type { Channel } from "amqplib";

export const workspaceBuildQueueName = "workspace-image-builds";
export const workspaceBuildDeadLetterExchangeName = "workspace-image-builds.dlx";
export const workspaceBuildDeadLetterQueueName = "workspace-image-builds.dlq";

export const assertWorkspaceBuildQueueTopology = async (channel: Channel) => {
  await channel.assertExchange(workspaceBuildDeadLetterExchangeName, "direct", {
    durable: true,
  });

  await channel.assertQueue(workspaceBuildDeadLetterQueueName, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
    },
  });

  await channel.bindQueue(
    workspaceBuildDeadLetterQueueName,
    workspaceBuildDeadLetterExchangeName,
    workspaceBuildDeadLetterQueueName,
  );

  await channel.assertQueue(workspaceBuildQueueName, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": workspaceBuildDeadLetterExchangeName,
      "x-dead-letter-routing-key": workspaceBuildDeadLetterQueueName,
      "x-queue-type": "quorum",
    },
  });
};
