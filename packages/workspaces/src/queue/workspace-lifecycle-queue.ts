/**
 * The workspace LIFECYCLE queue — mirrors the run-exec queue, but for runtime teardown. The API
 * enqueues a stop request (user stop, or the stop half of a restart); the worker consumes it, removes
 * the container via the runtime adapter, and records the terminal "stopped" state. Runtime mutations
 * stay in the worker: the API never needs a Docker socket (or, later, kube credentials).
 */
import {
  assertRabbitMqTopology,
  createRabbitMqService,
  type RabbitMqConsumerMessage,
  type RabbitMqTopology,
} from "@sealant/rabbitmq";
import type { Channel } from "amqplib";

export const workspaceLifecycleQueueName = "workspace-lifecycle";
export const workspaceLifecycleDeadLetterExchangeName = "workspace-lifecycle.dlx";
export const workspaceLifecycleDeadLetterQueueName = "workspace-lifecycle.dlq";

export const workspaceStopRequestedMessageKind = "workspace.stop.requested";

export type WorkspaceStopReason = "user" | "expired" | "failed";

export interface WorkspaceStopRequestedMessage {
  readonly kind: typeof workspaceStopRequestedMessageKind;
  readonly workspaceId: string;
  /** The attempt whose runtime instance is being stopped. */
  readonly runId: string;
  readonly stopReason: WorkspaceStopReason;
}

export const workspaceLifecycleQueueTopology: RabbitMqTopology = {
  exchanges: [
    { name: workspaceLifecycleDeadLetterExchangeName, type: "direct", options: { durable: true } },
  ],
  queues: [
    {
      name: workspaceLifecycleDeadLetterQueueName,
      options: { durable: true, arguments: { "x-queue-type": "quorum" } },
    },
    {
      name: workspaceLifecycleQueueName,
      options: {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": workspaceLifecycleDeadLetterExchangeName,
          "x-dead-letter-routing-key": workspaceLifecycleDeadLetterQueueName,
          "x-queue-type": "quorum",
        },
      },
    },
  ],
  bindings: [
    {
      queueName: workspaceLifecycleDeadLetterQueueName,
      exchangeName: workspaceLifecycleDeadLetterExchangeName,
      routingKey: workspaceLifecycleDeadLetterQueueName,
    },
  ],
};

export const assertWorkspaceLifecycleQueueTopology = async (channel: Channel): Promise<void> => {
  await assertRabbitMqTopology(channel, workspaceLifecycleQueueTopology);
};

const stopReasons: readonly WorkspaceStopReason[] = ["user", "expired", "failed"];

export const parseWorkspaceStopRequestedMessage = (
  input: unknown,
): WorkspaceStopRequestedMessage => {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid workspace-lifecycle message: not an object.");
  }
  const obj = input as Record<string, unknown>;
  if (obj.kind !== workspaceStopRequestedMessageKind) {
    throw new Error(`Invalid workspace-lifecycle message: unexpected kind ${String(obj.kind)}.`);
  }
  if (typeof obj.workspaceId !== "string" || obj.workspaceId.length === 0) {
    throw new Error("Invalid workspace-lifecycle message: missing workspaceId.");
  }
  if (typeof obj.runId !== "string" || obj.runId.length === 0) {
    throw new Error("Invalid workspace-lifecycle message: missing runId.");
  }
  const stopReason = stopReasons.find((reason) => reason === obj.stopReason);
  if (stopReason === undefined) {
    throw new Error(
      `Invalid workspace-lifecycle message: unexpected stopReason ${String(obj.stopReason)}.`,
    );
  }
  return {
    kind: workspaceStopRequestedMessageKind,
    workspaceId: obj.workspaceId,
    runId: obj.runId,
    stopReason,
  };
};

/** Publishes a workspace stop request to RabbitMQ (called by the API: stopWorkspace / restartWorkspace). */
export const publishWorkspaceStopRequested = async (
  connectionUrl: string,
  input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly stopReason: WorkspaceStopReason;
  },
): Promise<void> => {
  const message: WorkspaceStopRequestedMessage = {
    kind: workspaceStopRequestedMessageKind,
    workspaceId: input.workspaceId,
    runId: input.runId,
    stopReason: input.stopReason,
  };
  const rabbitMq = createRabbitMqService(connectionUrl);
  await rabbitMq.assertTopology(workspaceLifecycleQueueTopology);
  await rabbitMq.publishJsonMessage({
    queueName: workspaceLifecycleQueueName,
    message,
    // messageId keyed by run: a redelivered/duplicate stop for the same runtime is harmless (the
    // adapter stop and the status writes are both idempotent).
    properties: { messageId: message.runId, type: workspaceStopRequestedMessageKind },
  });
};

export type WorkspaceLifecycleConsumerMessage =
  RabbitMqConsumerMessage<WorkspaceStopRequestedMessage>;

export interface ConsumeWorkspaceLifecycleJobsOptions {
  readonly connectionUrl: string;
  readonly prefetch?: number;
  readonly onMessage: (message: WorkspaceLifecycleConsumerMessage) => Promise<void>;
}

export const consumeWorkspaceLifecycleJobs = async (
  options: ConsumeWorkspaceLifecycleJobsOptions,
) => {
  const rabbitMq = createRabbitMqService(options.connectionUrl);
  await rabbitMq.assertTopology(workspaceLifecycleQueueTopology);
  return rabbitMq.consumeJsonMessages({
    queueName: workspaceLifecycleQueueName,
    ...(options.prefetch === undefined ? {} : { prefetch: options.prefetch }),
    parseMessage: parseWorkspaceStopRequestedMessage,
    onMessage: options.onMessage,
  });
};
