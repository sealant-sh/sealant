import { publishRabbitMqJsonMessage } from "@sealant/rabbitmq";

import {
  parseSandboxBuildJobRequestedMessage,
  sandboxBuildJobRequestedMessageKind,
  type SandboxBuildJobRequestedMessage,
} from "./messages.js";
import { ensureSandboxBuildQueueTopology, sandboxBuildQueueName } from "./topology.js";

export const publishSandboxBuildJobRequested = async (
  connectionUrl: string,
  input: SandboxBuildJobRequestedMessage,
) => {
  const message = parseSandboxBuildJobRequestedMessage(input);

  await ensureSandboxBuildQueueTopology(connectionUrl);
  await publishRabbitMqJsonMessage({
    connectionUrl,
    queueName: sandboxBuildQueueName,
    message,
    properties: {
      messageId: message.jobId,
      type: sandboxBuildJobRequestedMessageKind,
    },
  });
};
