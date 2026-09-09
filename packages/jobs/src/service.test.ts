/**
 * Round-trips a message through pg-boss against a real Postgres. Gated on
 * SEALANT_JOBS_TEST_DATABASE_URL so the unit suite stays hermetic:
 *
 *   docker run -d --rm --name jobs-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=jobs \
 *     -e POSTGRES_USER=jobs -e POSTGRES_DB=jobs postgres:17-alpine
 *   SEALANT_JOBS_TEST_DATABASE_URL=postgresql://jobs:jobs@127.0.0.1:55432/jobs pnpm vitest run
 */
import { afterAll, describe, expect, it } from "vitest";

import { createJobQueueService } from "./service.js";
import { closeJobQueueSingleton, getJobQueueSingleton } from "./singleton.js";
import { defineJobQueue } from "./topology.js";

const databaseUrl = process.env.SEALANT_JOBS_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("job queue (pg-boss)", () => {
  const url = databaseUrl as string;
  const suffix = Date.now().toString(36);

  afterAll(async () => {
    await closeJobQueueSingleton();
  });

  it("delivers a published message to a consumer and completes it", async () => {
    const queue = defineJobQueue(`test-roundtrip-${suffix}`, { activeTimeoutSeconds: 60 });
    const jobs = createJobQueueService(url);
    const received: Array<{ readonly id: string }> = [];
    const { promise: delivered, resolve: resolveDelivered } = Promise.withResolvers<void>();

    const consumer = await jobs.consumeJson<{ readonly id: string }>({
      queue,
      parseMessage: (input) => {
        const obj = input as { readonly id?: unknown };
        if (typeof obj.id !== "string") throw new Error("bad message");
        return { id: obj.id };
      },
      onMessage: async ({ message }) => {
        received.push(message);
        resolveDelivered();
      },
    });

    const startedAt = Date.now();
    await jobs.publishJson({ queue, message: { id: "one" } });
    await delivered;
    const latencyMs = Date.now() - startedAt;

    expect(received).toEqual([{ id: "one" }]);
    // LISTEN/NOTIFY wake-up: well under the 1 s polling backstop.
    expect(latencyMs).toBeLessThan(1000);

    await consumer.cancel();
    const { boss } = await getJobQueueSingleton(url);
    const [completed] = await boss.findJobs(queue.name);
    expect(completed?.state).toBe("completed");
  });

  it("dead-letters a delivery whose handler throws, without retrying it", async () => {
    const queue = defineJobQueue(`test-dlq-${suffix}`, { activeTimeoutSeconds: 60 });
    const jobs = createJobQueueService(url);
    let attempts = 0;
    const { promise: failed, resolve: resolveFailed } = Promise.withResolvers<void>();

    const consumer = await jobs.consumeJson<{ readonly id: string }>({
      queue,
      parseMessage: (input) => input as { readonly id: string },
      onMessage: async () => {
        attempts += 1;
        resolveFailed();
        throw new Error("boom");
      },
    });

    await jobs.publishJson({ queue, message: { id: "two" } });
    await failed;
    // Give pg-boss a moment to settle the failure and copy it to the DLQ.
    const { boss } = await getJobQueueSingleton(url);
    let dlq: Array<{ readonly data: { readonly id: string } }> = [];
    for (let i = 0; i < 50 && dlq.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      dlq = await boss.findJobs<{ readonly id: string }>(queue.deadLetterQueueName);
    }
    await consumer.cancel();

    expect(attempts).toBe(1);
    expect(dlq.map((job) => job.data)).toEqual([{ id: "two" }]);
  });
});
