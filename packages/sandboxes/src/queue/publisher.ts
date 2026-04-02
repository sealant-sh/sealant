import { createRabbitMqService } from "@sealant/rabbitmq";

import {
  parseSandboxBuildJobRequestedMessage,
  sandboxBuildJobRequestedMessageKind,
  type SandboxBuildJobRequestedMessage,
} from "./messages.js";
import { sandboxBuildQueueName, sandboxBuildQueueTopology } from "./topology.js";

export const publishSandboxBuildJobRequested = async (
  connectionUrl: string,
  input: SandboxBuildJobRequestedMessage,
) => {
  const message = parseSandboxBuildJobRequestedMessage(input);
  const rabbitMq = createRabbitMqService(connectionUrl);

  await rabbitMq.assertTopology(sandboxBuildQueueTopology);
  await rabbitMq.publishJsonMessage({
    queueName: sandboxBuildQueueName,
    message,
    properties: {
      messageId: message.jobId,
      type: sandboxBuildJobRequestedMessageKind,
    },
  });
};
