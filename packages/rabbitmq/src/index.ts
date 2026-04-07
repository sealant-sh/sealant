export { rabbitMqEnvSchema, parseRabbitMqEnv, type RabbitMqEnv } from "@sealant/validators/env";

export {
  consumeRabbitMqJsonMessages,
  type ConsumeRabbitMqJsonMessagesOptions,
  type RabbitMqConsumerMessage,
} from "./consumer.js";

export { publishRabbitMqJsonMessage, type PublishRabbitMqJsonMessageInput } from "./publisher.js";

export {
  assertRabbitMqTopology,
  type RabbitMqExchangeDefinition,
  type RabbitMqQueueBinding,
  type RabbitMqQueueDefinition,
  type RabbitMqTopology,
} from "./topology.js";

export {
  closeRabbitMqSingleton,
  getRabbitMqSingleton,
  type RabbitMqSingleton,
} from "./singleton.js";

export {
  createRabbitMqService,
  rabbitMqServiceLayer,
  rabbitMqServiceLiveLayer,
  RabbitMqServiceTag,
  RabbitMqConnectionConfig,
  type RabbitMqService,
} from "./service.js";
