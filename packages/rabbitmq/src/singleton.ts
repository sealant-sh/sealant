import amqp from "amqplib";
import type { Channel, ChannelModel, ConfirmChannel } from "amqplib";

export interface RabbitMqSingleton {
  readonly connectionUrl: string;
  readonly connection: ChannelModel;
  readonly publishChannel: ConfirmChannel;
  readonly consumeChannel: Channel;
}

let singletonPromise: Promise<RabbitMqSingleton> | undefined;
let singletonConnectionUrl: string | undefined;

const createRabbitMqSingleton = async (connectionUrl: string): Promise<RabbitMqSingleton> => {
  const connection = await amqp.connect(connectionUrl);
  const publishChannel = await connection.createConfirmChannel();
  const consumeChannel = await connection.createChannel();

  connection.on("close", () => {
    singletonPromise = undefined;
    singletonConnectionUrl = undefined;
  });

  connection.on("error", () => {
    singletonPromise = undefined;
    singletonConnectionUrl = undefined;
  });

  return {
    connectionUrl,
    connection,
    publishChannel,
    consumeChannel,
  };
};

export const getRabbitMqSingleton = async (connectionUrl: string): Promise<RabbitMqSingleton> => {
  if (singletonPromise !== undefined && singletonConnectionUrl === connectionUrl) {
    return singletonPromise;
  }

  singletonConnectionUrl = connectionUrl;
  const connectingPromise = createRabbitMqSingleton(connectionUrl).catch((error) => {
    if (singletonPromise === connectingPromise) {
      singletonPromise = undefined;
      singletonConnectionUrl = undefined;
    }

    throw error;
  });
  singletonPromise = connectingPromise;

  return singletonPromise;
};

export const closeRabbitMqSingleton = async () => {
  const current = singletonPromise;

  singletonPromise = undefined;
  singletonConnectionUrl = undefined;

  if (current === undefined) {
    return;
  }

  const singleton = await current;
  await singleton.publishChannel.close();
  await singleton.consumeChannel.close();
  await singleton.connection.close();
};
