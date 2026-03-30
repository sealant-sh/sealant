import type { Channel, Options } from "amqplib";

export interface RabbitMqExchangeDefinition {
  readonly name: string;
  readonly type: "direct" | "fanout" | "topic" | "headers";
  readonly options?: Options.AssertExchange;
}

export interface RabbitMqQueueDefinition {
  readonly name: string;
  readonly options?: Options.AssertQueue;
}

export interface RabbitMqQueueBinding {
  readonly queueName: string;
  readonly exchangeName: string;
  readonly routingKey: string;
}

export interface RabbitMqTopology {
  readonly exchanges?: readonly RabbitMqExchangeDefinition[];
  readonly queues?: readonly RabbitMqQueueDefinition[];
  readonly bindings?: readonly RabbitMqQueueBinding[];
}

export const assertRabbitMqTopology = async (channel: Channel, topology: RabbitMqTopology) => {
  for (const exchange of topology.exchanges ?? []) {
    await channel.assertExchange(exchange.name, exchange.type, exchange.options);
  }

  for (const queue of topology.queues ?? []) {
    await channel.assertQueue(queue.name, queue.options);
  }

  for (const binding of topology.bindings ?? []) {
    await channel.bindQueue(binding.queueName, binding.exchangeName, binding.routingKey);
  }
};
