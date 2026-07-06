import { createRabbitMqService } from "@sealant/rabbitmq";

import {
  parseWorkspaceBuildJobRequestedMessage,
  workspaceBuildJobRequestedMessageKind,
  type WorkspaceBuildJobRequestedMessage,
} from "./messages.js";
import { workspaceBuildQueueName, workspaceBuildQueueTopology } from "./topology.js";

/**
 * Publishes a validated workspace build request message to RabbitMQ.
 */
export const publishWorkspaceBuildJobRequested = async (
  connectionUrl: string,
  input: WorkspaceBuildJobRequestedMessage,
) => {
  const message = parseWorkspaceBuildJobRequestedMessage(input);
  const rabbitMq = createRabbitMqService(connectionUrl);

  await rabbitMq.assertTopology(workspaceBuildQueueTopology);
  await rabbitMq.publishJsonMessage({
    queueName: workspaceBuildQueueName,
    message,
    properties: {
      messageId: message.jobId,
      type: workspaceBuildJobRequestedMessageKind,
    },
  });
};
