/**
 * Run-record retention against a real, migrated Postgres. Gated on SEALANT_TEST_DATABASE_URL (a
 * disposable database; it writes rows under fresh ids and removes them).
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/retention.db.test.ts
 */
import { randomUUID } from "node:crypto";

import {
  makeSealantDBLayer,
  runs,
  SealantDB,
  telemetryArtifacts,
  telemetryEvents,
  telemetryLossSpans,
  telemetryRunEpochs,
  telemetryScrollback,
  telemetryTimeline,
  user,
  workspaces,
} from "@sealant/db";
import { count, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteExpiredRunRecords } from "./retention.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One row in each of the record's tables. */
const storeRecord = (runId: string) =>
  Effect.gen(function* () {
    const handle = yield* SealantDB;
    const runtimeId = `rt_${runId}`;
    const eventId = `evt_${runId}`;
    yield* handle.insert(telemetryEvents).values({
      eventId,
      runId,
      runtimeId,
      schemaVersion: 1,
      sequence: 1n,
      observedAt: 1n,
      monotonicTimestamp: 1n,
      captureMethod: 1,
      confidence: 1,
      payloadCase: "ioChunk",
      payload: { stream: 2, byteCount: "2", streamOffset: "0" },
    });
    yield* handle.insert(telemetryTimeline).values({
      eventId,
      runId,
      sequence: 1n,
      kind: "ioChunk",
      occurredAt: 1n,
      summary: "stdout 2B @0",
      refJson: {},
    });
    yield* handle.insert(telemetryScrollback).values({
      eventId,
      runId,
      stream: 2,
      streamOffset: 0n,
      byteCount: 2n,
      contentAlgo: "sha256",
      contentHash: runId,
      sequence: 1n,
    });
    yield* handle.insert(telemetryArtifacts).values({
      id: `tart_${runId}`,
      runId,
      algo: "sha256",
      hash: runId,
      byteSize: 2n,
      inlineBytes: Buffer.from("hi"),
    });
    yield* handle.insert(telemetryLossSpans).values({
      id: `tls_${runId}`,
      runId,
      runtimeId,
      kind: "early_close",
      detectedVia: "marker",
    });
    yield* handle
      .insert(telemetryRunEpochs)
      .values({ id: `tep_${runId}`, runId, runtimeId, schemaVersion: 1 });
  });

describe.skipIf(DATABASE_URL === undefined)("run-record retention (Postgres)", () => {
  const db = makeSealantDBLayer(DATABASE_URL!);
  const suffix = randomUUID();
  const userId = `user_retention_${suffix}`;
  const workspaceId = `ws_retention_${suffix}`;
  const now = Date.now();
  // Two runs past retention (so batching is exercised), one inside it, one that never finished.
  const expired = [`run_retention_old_a_${suffix}`, `run_retention_old_b_${suffix}`];
  const recent = `run_retention_recent_${suffix}`;
  const unfinished = `run_retention_unfinished_${suffix}`;
  const run = <A, E>(effect: Effect.Effect<A, E, SealantDB>) =>
    Effect.runPromise(effect.pipe(Effect.provide(db)));

  const tables = [
    telemetryEvents,
    telemetryTimeline,
    telemetryScrollback,
    telemetryArtifacts,
    telemetryLossSpans,
    telemetryRunEpochs,
  ] as const;

  const rowsPerTable = (runId: string) =>
    Effect.gen(function* () {
      const handle = yield* SealantDB;
      const counts: number[] = [];
      for (const table of tables) {
        const [row] = yield* handle
          .select({ value: count() })
          .from(table)
          .where(eq(table.runId, runId));
        counts.push(Number(row?.value ?? 0));
      }
      return counts;
    });

  beforeAll(async () => {
    await run(
      Effect.gen(function* () {
        const handle = yield* SealantDB;
        const at = new Date(now);
        yield* handle.insert(user).values({
          id: userId,
          name: "retention-it",
          email: `${userId}@example.test`,
          createdAt: at,
          updatedAt: at,
        });
        yield* handle
          .insert(workspaces)
          .values({ id: workspaceId, ownerUserId: userId, createdAt: at, updatedAt: at });
        const finished = (runId: string, finishedAt: Date | null) => ({
          id: runId,
          workspaceId,
          ownerUserId: userId,
          harnessId: "exec",
          status: finishedAt === null ? ("running" as const) : ("completed" as const),
          finishedAt,
          createdAt: new Date(now - 30 * DAY_MS),
          updatedAt: at,
        });
        yield* handle
          .insert(runs)
          .values([
            ...expired.map((runId) => finished(runId, new Date(now - 10 * DAY_MS))),
            finished(recent, new Date(now - DAY_MS)),
            finished(unfinished, null),
          ]);
        for (const runId of [...expired, recent, unfinished]) {
          yield* storeRecord(runId);
        }
      }),
    );
  });

  afterAll(async () => {
    await run(
      Effect.gen(function* () {
        const handle = yield* SealantDB;
        yield* handle.delete(workspaces).where(eq(workspaces.id, workspaceId)); // cascades runs -> telemetry_*
        yield* handle.delete(user).where(eq(user.id, userId));
      }),
    );
  });

  it("deletes the whole record of every run that finished before the cutoff, and nothing else", async () => {
    const finishedBefore = new Date(now - 7 * DAY_MS);
    const deleteExpired = (maxRows: number) =>
      Effect.gen(function* () {
        const handle = yield* SealantDB;
        return yield* deleteExpiredRunRecords(handle, { finishedBefore, chunkRows: 1, maxRows });
      });

    // A call cut short mid-record leaves the run unmarked; the next calls finish it.
    const first = await run(deleteExpired(3));
    expect(first.rows).toBe(3);
    expect(first.runs).toBe(0);
    let calls = 0;
    for (;;) {
      calls += 1;
      const next = await run(deleteExpired(4));
      if (next.rows === 0 || calls > 50) break;
    }

    for (const runId of expired) {
      expect(await run(rowsPerTable(runId))).toEqual([0, 0, 0, 0, 0, 0]);
    }
    expect(await run(rowsPerTable(recent))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(await run(rowsPerTable(unfinished))).toEqual([1, 1, 1, 1, 1, 1]);

    // The run rows stay and say when their record went.
    const kept = await run(
      Effect.gen(function* () {
        const handle = yield* SealantDB;
        return yield* handle
          .select({ id: runs.id, recordDeletedAt: runs.recordDeletedAt })
          .from(runs)
          .where(inArray(runs.id, [...expired, recent, unfinished]));
      }),
    );
    const deletedAt = new Map(kept.map((row) => [row.id, row.recordDeletedAt]));
    expect(kept).toHaveLength(4);
    for (const runId of expired) expect(deletedAt.get(runId)).toBeInstanceOf(Date);
    expect(deletedAt.get(recent)).toBeNull();
    expect(deletedAt.get(unfinished)).toBeNull();

    // Nothing of this suite's is left to delete.
    expect((await run(deleteExpired(1_000))).rows).toBe(0);
  });
});
