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
