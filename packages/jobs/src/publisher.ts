import { getJobQueueSingleton } from "./singleton.js";
import type { JobQueueDefinition } from "./topology.js";

export interface PublishJobQueueJsonInput {
  readonly databaseUrl: string;
  readonly queue: JobQueueDefinition;
  readonly message: object;
}

export const publishJobQueueJson = async (input: PublishJobQueueJsonInput): Promise<void> => {
  const singleton = await getJobQueueSingleton(input.databaseUrl);
  await singleton.ensureQueue(input.queue);
  await singleton.boss.send(input.queue.name, input.message);
};
