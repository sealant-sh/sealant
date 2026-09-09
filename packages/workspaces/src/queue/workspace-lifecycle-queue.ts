/**
 * The workspace LIFECYCLE queue — mirrors the run-exec queue, but for runtime teardown. The API
 * enqueues a stop request (user stop, or the stop half of a restart); the worker consumes it, removes
 * the container via the runtime adapter, and records the terminal "stopped" state. Runtime mutations
 * stay in the worker: the API never needs a Docker socket (or, later, kube credentials).
 */
import { createJobQueueService, defineJobQueue, type JobQueueConsumerMessage } from "@sealant/jobs";

export const workspaceLifecycleQueueName = "workspace-lifecycle";
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

/**
 * Stopping a runtime is bounded (credential sync-back + container removal); the expiry reaper
 * picks up any stop that is lost anyway, so a short active window is enough.
 */
export const workspaceLifecycleQueue = defineJobQueue(workspaceLifecycleQueueName, {
  activeTimeoutSeconds: 15 * 60,
});

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

/** Publishes a workspace stop request (called by the API: stopWorkspace / restartWorkspace). */
export const publishWorkspaceStopRequested = async (
  databaseUrl: string,
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
  const jobs = createJobQueueService(databaseUrl);
  // A duplicate stop for the same runtime is harmless: the adapter stop and the status writes are
  // both idempotent.
  await jobs.publishJson({ queue: workspaceLifecycleQueue, message });
};

export type WorkspaceLifecycleConsumerMessage =
  JobQueueConsumerMessage<WorkspaceStopRequestedMessage>;

export interface ConsumeWorkspaceLifecycleJobsOptions {
  readonly databaseUrl: string;
  readonly concurrency?: number;
  /** Throwing fails the delivery (dead-lettered, never retried). */
  readonly onMessage: (message: WorkspaceLifecycleConsumerMessage) => Promise<void>;
}

export const consumeWorkspaceLifecycleJobs = async (
  options: ConsumeWorkspaceLifecycleJobsOptions,
) => {
  const jobs = createJobQueueService(options.databaseUrl);
  return jobs.consumeJson({
    queue: workspaceLifecycleQueue,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    parseMessage: parseWorkspaceStopRequestedMessage,
    onMessage: options.onMessage,
  });
};
