export { rabbitMqEnvSchema, parseRabbitMqEnv, type RabbitMqEnv } from "@sealant/rabbitmq";

export {
  parseWorkspaceBuildJobRequestedMessage,
  workspaceBuildJobRequestedMessageKind,
  workspaceBuildJobRequestedMessageSchema,
  type WorkspaceBuildJobRequestedMessage,
} from "./messages.js";

export {
  consumeWorkspaceBuildJobs,
  type ConsumeWorkspaceBuildJobsOptions,
  type WorkspaceBuildJobConsumerMessage,
} from "./consumer.js";

export { publishWorkspaceBuildJobRequested } from "./publisher.js";

export {
  closeRabbitMqSingleton,
  getRabbitMqSingleton,
  type RabbitMqSingleton,
} from "@sealant/rabbitmq";

export {
  assertWorkspaceBuildQueueTopology,
  ensureWorkspaceBuildQueueTopology,
  workspaceBuildDeadLetterExchangeName,
  workspaceBuildDeadLetterQueueName,
  workspaceBuildQueueName,
} from "./topology.js";
