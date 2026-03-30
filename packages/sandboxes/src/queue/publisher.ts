import { publishRabbitMqJsonMessage } from "@sealant/rabbitmq";

import {
  parseWorkspaceBuildJobRequestedMessage,
  workspaceBuildJobRequestedMessageKind,
  type WorkspaceBuildJobRequestedMessage,
} from "./messages.js";
import { ensureWorkspaceBuildQueueTopology, workspaceBuildQueueName } from "./topology.js";

export const publishWorkspaceBuildJobRequested = async (
  connectionUrl: string,
  input: WorkspaceBuildJobRequestedMessage,
) => {
  const message = parseWorkspaceBuildJobRequestedMessage(input);

  await ensureWorkspaceBuildQueueTopology(connectionUrl);
  await publishRabbitMqJsonMessage({
    connectionUrl,
    queueName: workspaceBuildQueueName,
    message,
    properties: {
      messageId: message.jobId,
      type: workspaceBuildJobRequestedMessageKind,
    },
  });
};
