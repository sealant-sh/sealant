/**
 * The workspace RUN-EXEC queue — mirrors the workspace-build queue, but for executing a harness run
 * server-side. The API enqueues a message when a run is created with a `command`; the worker consumes
 * it, docker-execs the harness in the workspace, ingests telemetry, and marks the run terminal. This is
 * what lets the SDK be a thin HTTP client (it no longer docker-execs or writes telemetry itself).
 */
import {
  assertRabbitMqTopology,
  createRabbitMqService,
  type RabbitMqConsumerMessage,
  type RabbitMqTopology,
} from "@sealant/rabbitmq";
import type { Channel } from "amqplib";

export const runExecQueueName = "workspace-run-exec";
export const runExecDeadLetterExchangeName = "workspace-run-exec.dlx";
export const runExecDeadLetterQueueName = "workspace-run-exec.dlq";

export const runExecRequestedMessageKind = "workspace.run-exec.requested";

/** One invocation the worker execs in the workspace. */
export interface RunExecCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

/**
 * Exactly one of the two framings is set:
 *
 * - `command` — HARNESS framing: one invocation; a nonzero exit marks the run failed.
 * - `commands` — EXEC (check-run) framing: an ordered list; every command executes regardless of
 *   exit codes (exit codes are check DATA), and the run completes iff all of them executed and were
 *   recorded. See `execWorkspaceRequestSchema` in @sealant/api-contracts for the full semantics.
 */
export interface RunExecRequestedMessage {
  readonly kind: typeof runExecRequestedMessageKind;
  readonly runId: string;
  readonly command?: RunExecCommand;
  readonly commands?: readonly RunExecCommand[];
}

export const runExecQueueTopology: RabbitMqTopology = {
  exchanges: [{ name: runExecDeadLetterExchangeName, type: "direct", options: { durable: true } }],
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

const parseCommand = (input: unknown, label: string): RunExecCommand => {
  const command = input as Record<string, unknown> | undefined;
  if (
    command === undefined ||
    command === null ||
    typeof command !== "object" ||
    typeof command.executable !== "string" ||
    command.executable.length === 0 ||
    !Array.isArray(command.args)
  ) {
    throw new Error(`Invalid run-exec message: missing/invalid ${label}.`);
  }
  return {
    executable: command.executable,
    args: command.args.map((arg) => String(arg)),
    ...(typeof command.cwd === "string" ? { cwd: command.cwd } : {}),
  };
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
  if (obj.commands !== undefined) {
    if (!Array.isArray(obj.commands) || obj.commands.length === 0) {
      throw new Error("Invalid run-exec message: commands must be a non-empty array.");
    }
    return {
      kind: runExecRequestedMessageKind,
      runId: obj.runId,
      commands: obj.commands.map((entry, index) => parseCommand(entry, `commands[${index}]`)),
    };
  }
  return {
    kind: runExecRequestedMessageKind,
    runId: obj.runId,
    command: parseCommand(obj.command, "command"),
  };
};

/** Publishes a run-exec request to RabbitMQ (called by the API: createRun with a command, or execWorkspace). */
export const publishRunExecRequested = async (
  connectionUrl: string,
  input: {
    readonly runId: string;
    readonly command?: RunExecCommand;
    readonly commands?: readonly RunExecCommand[];
  },
): Promise<void> => {
  if ((input.command === undefined) === (input.commands === undefined)) {
    throw new Error("A run-exec request carries exactly one of `command` or `commands`.");
  }
  const message: RunExecRequestedMessage = {
    kind: runExecRequestedMessageKind,
    runId: input.runId,
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.commands === undefined ? {} : { commands: input.commands }),
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
