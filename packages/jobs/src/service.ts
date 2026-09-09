import { Context, Effect, Layer } from "effect";

import {
  consumeJobQueueJson,
  type ConsumeJobQueueJsonOptions,
  type JobQueueConsumer,
} from "./consumer.js";
import { publishJobQueueJson, type PublishJobQueueJsonInput } from "./publisher.js";
import {
  closeJobQueueSingleton,
  getJobQueueSingleton,
  type JobQueueSingleton,
} from "./singleton.js";
import type { JobQueueDefinition } from "./topology.js";

/**
 * Connection configuration injected into the job queue service layer. The queue lives in the
 * control-plane database, so this is the same URL the repositories use.
 */
export class JobQueueConnectionConfig extends Context.Service<
  JobQueueConnectionConfig,
  {
    readonly databaseUrl: string;
  }
>()("@sealant/jobs/JobQueueConnectionConfig") {}

/**
 * Service contract for job queue operations used across publishers/consumers.
 */
export class JobQueueServiceTag extends Context.Service<
  JobQueueServiceTag,
  {
    readonly getSingleton: () => Promise<JobQueueSingleton>;
    readonly publishJson: (input: Omit<PublishJobQueueJsonInput, "databaseUrl">) => Promise<void>;
    readonly consumeJson: <TMessage>(
      options: Omit<ConsumeJobQueueJsonOptions<TMessage>, "databaseUrl">,
    ) => Promise<JobQueueConsumer>;
    readonly ensureQueue: (queue: JobQueueDefinition) => Promise<void>;
    readonly close: () => Promise<void>;
  }
>()("@sealant/jobs/JobQueueService") {}

export type JobQueueService = Context.Service.Shape<typeof JobQueueServiceTag>;

export const jobQueueServiceLiveLayer: Layer.Layer<
  JobQueueServiceTag,
  never,
  JobQueueConnectionConfig
> = Layer.effect(
  JobQueueServiceTag,
  Effect.gen(function* () {
    const config = yield* JobQueueConnectionConfig;

    return {
      getSingleton: () => getJobQueueSingleton(config.databaseUrl),
      publishJson: (input) => publishJobQueueJson({ databaseUrl: config.databaseUrl, ...input }),
      consumeJson: (options) =>
        consumeJobQueueJson({ databaseUrl: config.databaseUrl, ...options }),
      ensureQueue: async (queue) => {
        const singleton = await getJobQueueSingleton(config.databaseUrl);
        await singleton.ensureQueue(queue);
      },
      close: () => closeJobQueueSingleton(),
    };
  }),
);

export const jobQueueServiceLayer = (databaseUrl: string): Layer.Layer<JobQueueServiceTag> => {
  const configLayer = Layer.succeed(JobQueueConnectionConfig, { databaseUrl });

  return jobQueueServiceLiveLayer.pipe(Layer.provide(configLayer));
};

/**
 * Materializes a synchronous service handle for imperative call sites.
 */
export const createJobQueueService = (databaseUrl: string): JobQueueService => {
  return Effect.runSync(JobQueueServiceTag.pipe(Effect.provide(jobQueueServiceLayer(databaseUrl))));
};
