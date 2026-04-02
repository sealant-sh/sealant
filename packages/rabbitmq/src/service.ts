import { Context, Effect, Layer } from "effect";

import {
  consumeRabbitMqJsonMessages,
  type ConsumeRabbitMqJsonMessagesOptions,
} from "./consumer.js";
import { publishRabbitMqJsonMessage, type PublishRabbitMqJsonMessageInput } from "./publisher.js";
import {
  closeRabbitMqSingleton,
  getRabbitMqSingleton,
  type RabbitMqSingleton,
} from "./singleton.js";
import { assertRabbitMqTopology, type RabbitMqTopology } from "./topology.js";

export class RabbitMqConnectionConfig extends Context.Tag(
  "@sealant/rabbitmq/RabbitMqConnectionConfig",
)<
  RabbitMqConnectionConfig,
  {
    readonly connectionUrl: string;
  }
>() {}

export class RabbitMqServiceTag extends Context.Tag("@sealant/rabbitmq/RabbitMqService")<
  RabbitMqServiceTag,
  {
    readonly getSingleton: () => Promise<RabbitMqSingleton>;
    readonly publishJsonMessage: (
      input: Omit<PublishRabbitMqJsonMessageInput, "connectionUrl">,
    ) => Promise<void>;
    readonly consumeJsonMessages: <TMessage>(
      options: Omit<ConsumeRabbitMqJsonMessagesOptions<TMessage>, "connectionUrl">,
    ) => Promise<{
      readonly consumerTag: string;
      cancel(): Promise<void>;
    }>;
    readonly assertTopology: (topology: RabbitMqTopology) => Promise<void>;
    readonly close: () => Promise<void>;
  }
>() {}

export const rabbitMqServiceLiveLayer = Layer.effect(
  RabbitMqServiceTag,
  Effect.gen(function* () {
    const config = yield* RabbitMqConnectionConfig;

    return {
      getSingleton: () => getRabbitMqSingleton(config.connectionUrl),
      publishJsonMessage: (input) =>
        publishRabbitMqJsonMessage({
          connectionUrl: config.connectionUrl,
          ...input,
        }),
      consumeJsonMessages: (options) =>
        consumeRabbitMqJsonMessages({
          connectionUrl: config.connectionUrl,
          ...options,
        }),
      assertTopology: async (topology) => {
        const singleton = await getRabbitMqSingleton(config.connectionUrl);

        await assertRabbitMqTopology(singleton.publishChannel, topology);
        await assertRabbitMqTopology(singleton.consumeChannel, topology);
      },
      close: () => closeRabbitMqSingleton(),
    };
  }),
);

export const rabbitMqServiceLayer = (connectionUrl: string) => {
  const configLayer = Layer.succeed(RabbitMqConnectionConfig, {
    connectionUrl,
  });

  return rabbitMqServiceLiveLayer.pipe(Layer.provide(configLayer));
};

export type RabbitMqService = Context.Tag.Service<typeof RabbitMqServiceTag>;

export const createRabbitMqService = (connectionUrl: string): RabbitMqService => {
  return Effect.runSync(
    RabbitMqServiceTag.pipe(Effect.provide(rabbitMqServiceLayer(connectionUrl))),
  );
};
