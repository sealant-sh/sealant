import { getJobQueueSingleton } from "./singleton.js";
import type { JobQueueDefinition } from "./topology.js";

export interface JobQueueConsumerMessage<TMessage> {
  readonly message: TMessage;
  readonly jobId: string;
}

export interface ConsumeJobQueueJsonOptions<TMessage> {
  readonly databaseUrl: string;
  readonly queue: JobQueueDefinition;
  /** Deliveries handled at once by this process. Defaults to 1. */
  readonly concurrency?: number;
  readonly parseMessage: (input: unknown) => TMessage;
  /**
   * Delete each delivery's row as soon as it is taken, before it is parsed or handled, so its
   * data is not kept after pickup: for a payload that can carry secrets (a command's arguments).
   * Without the row there is no completed copy, no dead-letter copy and no expiry, so a delivery
   * whose worker dies mid-handling leaves no trace in the queue. A row a failed delete left behind
   * is the queue owner's to sweep.
   */
  readonly deleteOnPickup?: boolean;
  /**
   * Resolving completes the delivery. Throwing (or a payload that fails to parse) fails it, which
   * copies it to the dead-letter queue — there are no automatic retries.
   */
  readonly onMessage: (message: JobQueueConsumerMessage<TMessage>) => Promise<void>;
}

export interface JobQueueConsumer {
  cancel(): Promise<void>;
}

export const consumeJobQueueJson = async <TMessage>(
  options: ConsumeJobQueueJsonOptions<TMessage>,
): Promise<JobQueueConsumer> => {
  const singleton = await getJobQueueSingleton(options.databaseUrl);
  await singleton.ensureQueue(options.queue);

  const workerId = await singleton.boss.work<unknown>(
    options.queue.name,
    {
      batchSize: 1,
      localConcurrency: options.concurrency ?? 1,
      // NOTIFY wakes the worker immediately; this is the backstop when the listener is down.
      pollingIntervalSeconds: 1,
    },
    async (jobs) => {
      for (const job of jobs) {
        if (options.deleteOnPickup === true) {
          // pg-boss treats a job its handler deleted as done: completing or failing it afterwards
          // changes nothing, and nothing is copied to the dead-letter queue. A delete that fails
          // (a transient database error) must not fail the delivery, which would copy its data to
          // the dead-letter queue and leave the work undone: the work goes on, and the row is left
          // for the queue owner's sweep.
          await singleton.boss.deleteJob(options.queue.name, job.id).catch((error: unknown) => {
            console.error("[jobs] could not delete a delivery at pickup; left for the sweep", {
              queue: options.queue.name,
              jobId: job.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        let message: TMessage;
        try {
          message = options.parseMessage(job.data);
        } catch (error) {
          console.error("[jobs] rejecting malformed delivery; dead-lettering", {
            queue: options.queue.name,
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        await options.onMessage({ message, jobId: job.id });
      }
    },
  );

  return {
    cancel: async () => {
      await singleton.boss.offWork(options.queue.name, { id: workerId, wait: true });
    },
  };
};
