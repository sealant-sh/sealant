/**
 * The sandbox RUN-EXEC queue — mirrors the sandbox-build queue, but for executing a harness run
 * server-side. The API enqueues a message when a run is created with a `command`; the worker consumes
 * it, docker-execs the harness in the sandbox, ingests telemetry, and marks the run terminal. This is
 * what lets the SDK be a thin HTTP client (it no longer docker-execs or writes telemetry itself).
 */
import {
  assertRabbitMqTopology,
  createRabbitMqService,
  type RabbitMqConsumerMessage,
  type RabbitMqTopology,
} from "@sealant/rabbitmq";
import type { Channel } from "amqplib";

export const runExecQueueName = "sandbox-run-exec";
export const runExecDeadLetterExchangeName = "sandbox-run-exec.dlx";
export const runExecDeadLetterQueueName = "sandbox-run-exec.dlq";

export const runExecRequestedMessageKind = "sandbox.run-exec.requested";

/** The harness invocation the worker execs in the sandbox. */
export interface RunExecCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export interface RunExecRequestedMessage {
  readonly kind: typeof runExecRequestedMessageKind;
  readonly runId: string;
  readonly command: RunExecCommand;
}

export const runExecQueueTopology: RabbitMqTopology = {
  exchanges: [
    { name: runExecDeadLetterExchangeName, type: "direct", options: { durable: true } },
  ],
  queues: [
    {
      name: runExecDeadLetterQueueName,
      options: { durable: true, arguments: { "x-queue-type": "quorum" } },
    },
    {
      name: runExecQueueName,
      options: {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": runExecDeadLetterExchangeName,
          "x-dead-letter-routing-key": runExecDeadLetterQueueName,
          "x-queue-type": "quorum",
        },
      },
    },
  ],
  bindings: [
    {
      queueName: runExecDeadLetterQueueName,
      exchangeName: runExecDeadLetterExchangeName,
      routingKey: runExecDeadLetterQueueName,
    },
  ],
};

export const assertRunExecQueueTopology = async (channel: Channel): Promise<void> => {
  await assertRabbitMqTopology(channel, runExecQueueTopology);
};

export const parseRunExecRequestedMessage = (input: unknown): RunExecRequestedMessage => {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid run-exec message: not an object.");
  }
  const obj = input as Record<string, unknown>;
  if (obj.kind !== runExecRequestedMessageKind) {
    throw new Error(`Invalid run-exec message: unexpected kind ${String(obj.kind)}.`);
  }
  if (typeof obj.runId !== "string" || obj.runId.length === 0) {
    throw new Error("Invalid run-exec message: missing runId.");
  }
  const command = obj.command as Record<string, unknown> | undefined;
  if (
    command === undefined ||
    typeof command.executable !== "string" ||
    command.executable.length === 0 ||
    !Array.isArray(command.args)
  ) {
    throw new Error("Invalid run-exec message: missing/invalid command.");
  }
  return {
    kind: runExecRequestedMessageKind,
    runId: obj.runId,
    command: {
      executable: command.executable,
      args: command.args.map((arg) => String(arg)),
      ...(typeof command.cwd === "string" ? { cwd: command.cwd } : {}),
    },
  };
};

/** Publishes a run-exec request to RabbitMQ (called by the API on createRun when a command is present). */
export const publishRunExecRequested = async (
  connectionUrl: string,
  input: { readonly runId: string; readonly command: RunExecCommand },
): Promise<void> => {
  const message: RunExecRequestedMessage = {
    kind: runExecRequestedMessageKind,
    runId: input.runId,
    command: input.command,
  };
  const rabbitMq = createRabbitMqService(connectionUrl);
  await rabbitMq.assertTopology(runExecQueueTopology);
  await rabbitMq.publishJsonMessage({
    queueName: runExecQueueName,
    message,
    properties: { messageId: message.runId, type: runExecRequestedMessageKind },
  });
};

export type RunExecConsumerMessage = RabbitMqConsumerMessage<RunExecRequestedMessage>;

export interface ConsumeRunExecJobsOptions {
  readonly connectionUrl: string;
  readonly prefetch?: number;
  readonly onMessage: (message: RunExecConsumerMessage) => Promise<void>;
}

export const consumeRunExecJobs = async (options: ConsumeRunExecJobsOptions) => {
  const rabbitMq = createRabbitMqService(options.connectionUrl);
  await rabbitMq.assertTopology(runExecQueueTopology);
  return rabbitMq.consumeJsonMessages({
    queueName: runExecQueueName,
    ...(options.prefetch === undefined ? {} : { prefetch: options.prefetch }),
    parseMessage: parseRunExecRequestedMessage,
    onMessage: options.onMessage,
  });
};
