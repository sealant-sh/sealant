import { captureProcessError, parentOf, withProcessObservers } from "@sealant/observability";
import { Cause, Effect, Exit, type Tracer } from "effect";
import type { JobWithMetadata } from "pg-boss";

import { toJobFailure } from "./failure.js";
import { getJobQueueSingleton } from "./singleton.js";
import type { JobQueueDefinition } from "./topology.js";
import { takeJobTrace } from "./trace.js";

export interface JobQueueConsumerMessage<TMessage> {
  readonly message: TMessage;
  readonly jobId: string;
  /**
   * This delivery's `sealant.job.process` span: the parent of the handling's own spans
   * (`Effect.withParentSpan`), and itself a child of the sender's trace when the job carried one.
   */
  readonly span: Tracer.AnySpan;
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

  const workerId = await singleton.boss.work(
    options.queue.name,
    {
      batchSize: 1,
      localConcurrency: options.concurrency ?? 1,
      // NOTIFY wakes the worker immediately; polling is the backstop. pg-boss uses
      // `notifyPollingIntervalSeconds` (default 30 s) instead of `pollingIntervalSeconds` while the
      // listener is up, and it folds NOTIFYs that land before its next fetch into one wake-up. A
      // fetch takes one delivery, so the second of two deliveries sent together would wait out
      // that backstop. Both are 1 s, so a folded wake-up costs at most a second.
      pollingIntervalSeconds: 1,
      notifyPollingIntervalSeconds: 1,
      // Enqueue and start times, for the span's queue wait.
      includeMetadata: true,
    },
    async (jobs: JobWithMetadata<unknown>[]) => {
      for (const job of jobs) {
        await deliver(options, singleton, job);
      }
    },
  );

  return {
    cancel: async () => {
      await singleton.boss.offWork(options.queue.name, { id: workerId, wait: true });
    },
  };
};

/** The span name every delivery's handling runs under; the queue is an attribute. */
export const JOB_PROCESS_SPAN = "sealant.job.process";

/**
 * One delivery: taken off its row when the queue asks, its trace taken out of its data, parsed,
 * and handled inside one CONSUMER span. A failure is reported once, here, with that span, and fails
 * the delivery.
 */
const deliver = async <TMessage>(
  options: ConsumeJobQueueJsonOptions<TMessage>,
  singleton: Awaited<ReturnType<typeof getJobQueueSingleton>>,
  job: JobWithMetadata<unknown>,
): Promise<void> => {
  const queue = options.queue.name;
  if (options.deleteOnPickup === true) {
    // pg-boss treats a job its handler deleted as done: completing or failing it afterwards
    // changes nothing, and nothing is copied to the dead-letter queue. A delete that fails
    // (a transient database error) must not fail the delivery, which would copy its data to
    // the dead-letter queue and leave the work undone: the work goes on, and the row is left
    // for the queue owner's sweep.
    await singleton.boss.deleteJob(queue, job.id).catch((error: unknown) => {
      console.error("[jobs] could not delete a delivery at pickup; left for the sweep", {
        queue,
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  const { message: data, trace } = takeJobTrace(job.data);
  const parent = trace === undefined ? undefined : parentOf(trace);
  const handled = Effect.useSpan(
    JOB_PROCESS_SPAN,
    {
      kind: "consumer",
      ...(parent === undefined ? { root: true } : { parent }),
      attributes: {
        "messaging.system": "pg-boss",
        "messaging.destination.name": queue,
        "messaging.message.id": job.id,
        "sealant.job_id": job.id,
        "sealant.job.attempt": job.retryCount + 1,
        "sealant.job.queue_wait_ms": Math.max(
          0,
          job.startedOn.getTime() - Math.max(job.createdOn.getTime(), job.startAfter.getTime()),
        ),
      },
    },
    (span) =>
      Effect.tryPromise({
        try: async () => {
          let message: TMessage;
          try {
            message = options.parseMessage(data);
          } catch (error) {
            console.error("[jobs] rejecting malformed delivery; dead-lettering", {
              queue,
              jobId: job.id,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
          await options.onMessage({ message, jobId: job.id, span });
        },
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() =>
            captureProcessError(error, {
              span,
              tags: { "messaging.destination.name": queue, "sealant.job_id": job.id },
            }),
          ),
        ),
      ),
  );
  const exit = await Effect.runPromiseExit(withProcessObservers(handled));
  if (Exit.isFailure(exit)) throw toJobFailure(Cause.squash(exit.cause));
};
