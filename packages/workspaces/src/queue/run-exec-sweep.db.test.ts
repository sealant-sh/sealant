/**
 * `sweepRunExecJobRows` against a real Postgres with pg-boss. Gated on
 * SEALANT_JOBS_TEST_DATABASE_URL. No worker consumes the run-exec queue in tests, so the jobs this
 * suite makes stay where it puts them.
 *
 *   SEALANT_JOBS_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/queue/run-exec-sweep.db.test.ts
 */
import { randomUUID } from "node:crypto";

import { closeJobQueueSingleton, getJobQueueSingleton, jobQueueSchemaName } from "@sealant/jobs";
import { afterAll, describe, expect, it } from "vitest";

import {
  runExecAsUserQueue,
  runExecQueue,
  runExecQueueName,
  sweepRunExecJobRows,
} from "./run-exec-queue.js";

const databaseUrl = process.env.SEALANT_JOBS_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("the run-exec job sweep (pg-boss)", () => {
  const url = databaseUrl!;

  afterAll(async () => {
    await closeJobQueueSingleton();
  });

  it("deletes finished, dead-lettered and stale active jobs, and keeps jobs not yet taken", async () => {
    const singleton = await getJobQueueSingleton(url);
    await singleton.ensureQueue(runExecQueue);
    await singleton.ensureQueue(runExecAsUserQueue);
    const { boss } = singleton;
    const tag = randomUUID();
    const send = async (queue: string, label: string) => {
      const id = await boss.send(queue, { runId: `run_${label}_${tag}`, secret: `argv-${tag}` });
      if (id === null) throw new Error(`pg-boss did not create the ${label} job`);
      return id;
    };
    const db = boss.getDb();
    const setState = (id: string, state: string, startedMinutesAgo: number) =>
      db.executeSql(
        `UPDATE ${jobQueueSchemaName}.job SET state = $2, started_on = now() - make_interval(mins => $3)
         WHERE id = $1`,
        [id, state, startedMinutesAgo],
      );

    const waiting = await send(runExecQueueName, "waiting");
    const completed = await send(runExecQueueName, "completed");
    const staleActive = await send(runExecQueueName, "stale");
    const freshActive = await send(runExecQueueName, "fresh");
    const deadLettered = await send(runExecQueue.deadLetterQueueName, "dlq");
    // The as-user queue's rows hold arguments too: swept by the same rule.
    const asUserWaiting = await send(runExecAsUserQueue.name, "as-user-waiting");
    const asUserCompleted = await send(runExecAsUserQueue.name, "as-user-completed");
    const asUserDeadLettered = await send(runExecAsUserQueue.deadLetterQueueName, "as-user-dlq");
    await setState(asUserCompleted, "completed", 5);
    await setState(completed, "completed", 5);
    await setState(staleActive, "active", 30);
    await setState(freshActive, "active", 1);

    expect(await sweepRunExecJobRows(url)).toBeGreaterThanOrEqual(5);

    const left = await db.executeSql(
      `SELECT id FROM ${jobQueueSchemaName}.job WHERE data->>'secret' = $1`,
      [`argv-${tag}`],
    );
    const ids = new Set(left.rows.map((row: { id: string }) => row.id));
    expect(ids).toEqual(new Set([waiting, freshActive, asUserWaiting]));
    expect(ids.has(deadLettered)).toBe(false);
    expect(ids.has(asUserDeadLettered)).toBe(false);

    await db.executeSql(`DELETE FROM ${jobQueueSchemaName}.job WHERE data->>'secret' = $1`, [
      `argv-${tag}`,
    ]);
  });
});
