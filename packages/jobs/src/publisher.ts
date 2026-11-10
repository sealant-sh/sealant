import { getJobQueueSingleton } from "./singleton.js";
import type { JobQueueDefinition } from "./topology.js";

export interface PublishJobQueueJsonInput {
  readonly databaseUrl: string;
  readonly queue: JobQueueDefinition;
  readonly message: object;
  /**
   * On a queue defined with `collapseWaiting`: the messages that stand for one another. While a
   * delivery with this key waits, another message with it is dropped.
   */
  readonly collapseKey?: string;
}

export const publishJobQueueJson = async (input: PublishJobQueueJsonInput): Promise<void> => {
  const singleton = await getJobQueueSingleton(input.databaseUrl);
  await singleton.ensureQueue(input.queue);
  // pg-boss answers `null` for a message it dropped as a duplicate: that is the collapse.
  await singleton.boss.send(
    input.queue.name,
    input.message,
    input.collapseKey === undefined ? {} : { singletonKey: input.collapseKey },
  );
};
