/**
 * The Boat resource-link queue. A Boat run reaches its project's resources through a gateway that
 * only the worker configures, so a link the API writes changes nothing a session can reach until
 * the worker applies it. The API enqueues one message naming the run when it writes or removes a
 * link for a workspace with a live Boat run; the worker applies the link to that run's gateway at
 * once. The worker's resource sweep visits every live run every few ticks and applies the same
 * link, so a message that is lost, dropped or failed costs a short delay and nothing else.
 */
import { createJobQueueService, defineJobQueue, type JobQueueConsumerMessage } from "@sealant/jobs";

export const boatResourceLinkQueueName = "boat-resource-links";

export const boatResourceLinkChangedMessageKind = "boat.resource-link.changed";

export interface BoatResourceLinkChangedMessage {
  readonly kind: typeof boatResourceLinkChangedMessageKind;
  readonly workspaceId: string;
  /** The live Boat run whose gateway serves the workspace's link. */
  readonly runId: string;
}

/**
 * One waiting message per run: a burst of re-links collapses to one application, and a link
 * written while an application is in flight (which may have read the link before it) queues one
 * more. The active window covers a wait for the run's turn and one bounded application.
 */
export const boatResourceLinkQueue = defineJobQueue(boatResourceLinkQueueName, {
  activeTimeoutSeconds: 10 * 60,
  collapseWaiting: true,
});

export const parseBoatResourceLinkChangedMessage = (
  input: unknown,
): BoatResourceLinkChangedMessage => {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid boat-resource-links message: not an object.");
  }
  const kind: unknown = "kind" in input ? input.kind : undefined;
  const workspaceId: unknown = "workspaceId" in input ? input.workspaceId : undefined;
  const runId: unknown = "runId" in input ? input.runId : undefined;
  if (kind !== boatResourceLinkChangedMessageKind) {
    throw new Error(`Invalid boat-resource-links message: unexpected kind ${String(kind)}.`);
  }
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("Invalid boat-resource-links message: missing workspaceId.");
  }
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Invalid boat-resource-links message: missing runId.");
  }
  return { kind: boatResourceLinkChangedMessageKind, workspaceId, runId };
};

/** Publishes "this run's link changed" (called by the API's link and domain-archive routes). */
export const publishBoatResourceLinkChanged = async (
  databaseUrl: string,
  input: { readonly workspaceId: string; readonly runId: string },
): Promise<void> => {
  const message: BoatResourceLinkChangedMessage = {
    kind: boatResourceLinkChangedMessageKind,
    workspaceId: input.workspaceId,
    runId: input.runId,
  };
  const jobs = createJobQueueService(databaseUrl);
  await jobs.publishJson({ queue: boatResourceLinkQueue, message, collapseKey: input.runId });
};

export type BoatResourceLinkConsumerMessage =
  JobQueueConsumerMessage<BoatResourceLinkChangedMessage>;

export interface ConsumeBoatResourceLinkJobsOptions {
  readonly databaseUrl: string;
  readonly concurrency?: number;
  /** Throwing fails the delivery (dead-lettered, never retried); the sweep still applies the link. */
  readonly onMessage: (message: BoatResourceLinkConsumerMessage) => Promise<void>;
}

export const consumeBoatResourceLinkJobs = async (options: ConsumeBoatResourceLinkJobsOptions) => {
  const jobs = createJobQueueService(options.databaseUrl);
  return jobs.consumeJson({
    queue: boatResourceLinkQueue,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    parseMessage: parseBoatResourceLinkChangedMessage,
    onMessage: options.onMessage,
  });
};
