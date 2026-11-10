/**
 * A job queue plus its dead-letter queue. Mirrors the RabbitMQ topology this package replaced: a
 * durable queue whose failed deliveries are copied to `<name>.dlq` for inspection instead of being
 * retried — every consumer in Sealant treats a handler failure as terminal and records the failure
 * on the domain row itself (build job, run, runtime instance).
 */
export interface JobQueueDefinition {
  readonly name: string;
  readonly deadLetterQueueName: string;
  /**
   * How long one delivery may stay `active` before pg-boss fails it (and dead-letters it). Set it
   * above the longest handler the queue carries: an expired delivery is the same outcome as a
   * worker that died mid-job.
   */
  readonly activeTimeoutSeconds: number;
  /**
   * `true`: at most one delivery per collapse key waits in the queue (pg-boss's `short` policy).
   * A message published with a key that already has one waiting is dropped; one published while
   * that key's delivery is being handled waits as the next. For a message that only says "look
   * again", where one pending look covers every request made before it starts.
   */
  readonly collapseWaiting: boolean;
}

export const defineJobQueue = (
  name: string,
  options: { readonly activeTimeoutSeconds: number; readonly collapseWaiting?: boolean },
): JobQueueDefinition => ({
  name,
  deadLetterQueueName: `${name}.dlq`,
  activeTimeoutSeconds: options.activeTimeoutSeconds,
  collapseWaiting: options.collapseWaiting === true,
});
