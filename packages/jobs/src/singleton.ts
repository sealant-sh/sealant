import { PgBoss } from "pg-boss";

import type { JobQueueDefinition } from "./topology.js";

/** The Postgres schema pg-boss installs its tables into (inside the control-plane database). */
export const jobQueueSchemaName = "pgboss";

export interface JobQueueSingleton {
  readonly databaseUrl: string;
  readonly boss: PgBoss;
  /** Idempotent: creates the queue and its dead-letter queue when they do not exist yet. */
  ensureQueue(definition: JobQueueDefinition): Promise<void>;
}

let singletonPromise: Promise<JobQueueSingleton> | undefined;
let singletonDatabaseUrl: string | undefined;

const createJobQueueSingleton = async (databaseUrl: string): Promise<JobQueueSingleton> => {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: jobQueueSchemaName,
    application_name: "sealant-jobs",
    // Publish-only processes never fetch; consumers fetch one delivery per worker slot. Two
    // connections (one for commands, one pinned to LISTEN) cover the idle case; the pool grows
    // under load and shrinks again.
    max: 4,
    // Workers wake on NOTIFY the moment a job is created; polling stays on as the correctness floor.
    useListenNotify: true,
  });
  boss.on("error", (error) => {
    console.error("[jobs] pg-boss error", { error: error.message });
  });
  boss.on("warning", (warning) => {
    console.warn("[jobs] pg-boss warning", warning);
  });
  await boss.start();

  const ensured = new Set<string>();
  const ensureQueue = async (definition: JobQueueDefinition) => {
    if (ensured.has(definition.name)) {
      return;
    }
    // The dead-letter queue must exist before a queue can reference it. No retries: a failed
    // delivery lands in the DLQ on the first failure, exactly like the AMQP `nack(requeue=false)`
    // every consumer used. Failed copies are kept for a week for inspection.
    await boss.createQueue(definition.deadLetterQueueName, {
      retryLimit: 0,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
    });
    await boss.createQueue(definition.name, {
      retryLimit: 0,
      expireInSeconds: definition.activeTimeoutSeconds,
      deadLetter: definition.deadLetterQueueName,
      notify: true,
      // Completed deliveries carry no data anyone reads back; drop them quickly.
      deleteAfterSeconds: 60 * 60,
    });
    ensured.add(definition.name);
  };

  return { databaseUrl, boss, ensureQueue };
};

export const getJobQueueSingleton = async (databaseUrl: string): Promise<JobQueueSingleton> => {
  if (singletonPromise !== undefined && singletonDatabaseUrl === databaseUrl) {
    return singletonPromise;
  }

  singletonDatabaseUrl = databaseUrl;
  const connectingPromise = createJobQueueSingleton(databaseUrl).catch((error: unknown) => {
    if (singletonPromise === connectingPromise) {
      singletonPromise = undefined;
      singletonDatabaseUrl = undefined;
    }

    throw error;
  });
  singletonPromise = connectingPromise;

  return singletonPromise;
};

export const closeJobQueueSingleton = async (): Promise<void> => {
  const current = singletonPromise;

  singletonPromise = undefined;
  singletonDatabaseUrl = undefined;

  if (current === undefined) {
    return;
  }

  const singleton = await current;
  // Graceful: in-flight handlers finish (bounded) before the pool closes.
  await singleton.boss.stop({ graceful: true, close: true, timeout: 30_000 });
};
