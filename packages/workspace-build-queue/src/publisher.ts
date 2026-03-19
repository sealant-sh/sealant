import {
  parseWorkspaceBuildJobRequestedMessage,
  workspaceBuildJobRequestedMessageKind,
  type WorkspaceBuildJobRequestedMessage,
} from "./messages.js";
import { getRabbitMqSingleton } from "./singleton.js";
import { workspaceBuildQueueName } from "./topology.js";

const encodeMessage = (message: WorkspaceBuildJobRequestedMessage): Buffer => {
  return Buffer.from(JSON.stringify(message), "utf8");
};

export const publishWorkspaceBuildJobRequested = async (
  connectionUrl: string,
  input: WorkspaceBuildJobRequestedMessage,
) => {
  const message = parseWorkspaceBuildJobRequestedMessage(input);
  const singleton = await getRabbitMqSingleton(connectionUrl);

  await new Promise<void>((resolve, reject) => {
    singleton.publishChannel.sendToQueue(
      workspaceBuildQueueName,
      encodeMessage(message),
      {
        contentType: "application/json",
        deliveryMode: 2,
        messageId: message.jobId,
        persistent: true,
        timestamp: Date.now(),
        type: workspaceBuildJobRequestedMessageKind,
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
