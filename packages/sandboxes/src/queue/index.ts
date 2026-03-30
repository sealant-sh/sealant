export { rabbitMqEnvSchema, parseRabbitMqEnv, type RabbitMqEnv } from "@sealant/rabbitmq";

export {
  parseSandboxBuildJobRequestedMessage,
  sandboxBuildJobRequestedMessageKind,
  sandboxBuildJobRequestedMessageSchema,
  type SandboxBuildJobRequestedMessage,
} from "./messages.js";

export {
  consumeSandboxBuildJobs,
  type ConsumeSandboxBuildJobsOptions,
  type SandboxBuildJobConsumerMessage,
} from "./consumer.js";

export { publishSandboxBuildJobRequested } from "./publisher.js";

export {
  closeRabbitMqSingleton,
  getRabbitMqSingleton,
  type RabbitMqSingleton,
} from "@sealant/rabbitmq";

export {
  assertSandboxBuildQueueTopology,
  ensureSandboxBuildQueueTopology,
  sandboxBuildDeadLetterExchangeName,
  sandboxBuildDeadLetterQueueName,
  sandboxBuildQueueName,
} from "./topology.js";
