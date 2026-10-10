/**
 * `appendBatch` against a REAL Postgres when the same events arrive more than once. Gated on
 * SEALANT_TEST_DATABASE_URL (or DATABASE_URL), like `telemetry.db.test.ts`.
 *
 * The case this was written for (2026-10-10): a person's exec run failed because its run-exec job
 * and the full-stream ingester, each on its own connection to the runtime, inserted the same event
 * at the same moment. The insert's only arbiter was `(runtime_id, sequence)`, so the second
 * transaction did not wait the first one out on it and failed on the primary key (`event_id`)
 * instead: `duplicate key value violates unique constraint "telemetry_events_pkey"`.
 *
 * Conflicts (a different event at the same id or position, or a run-tagged event in another run)
 * keep the stored event, are recorded as a `dropped_event` span on the run they were for, and are
 * returned, so a writer never takes them as stored.
 */
import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  makeSealantDBLayer,
  runs,
  SealantDB,
  telemetryEvents,
  telemetryLossSpans,
  user,
  workspaces,
} from "@sealant/db";
import { StreamKind } from "@sealant/runtime-client";
import { EventEnvelopeSchema } from "@sealant/runtime-protocol";
import { asc, eq } from "drizzle-orm";
import { Deferred, Effect, Fiber, Layer, Logger, Result, Schedule } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InlineByteaArtifactStoreLive } from "./artifact-store.js";
import { rootCauseMessage } from "./errors.js";
import { eventRow, normalizeEnvelope } from "./normalize.js";
import { makeRunRecordWriter } from "./record-writer.js";
import { PostgresTelemetrySinkLive, TelemetrySink } from "./sink.js";
import type { NormalizedEvent } from "./types.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const RUNTIME_ID = "rt_it_redelivery";
const runId = `run_it_${RUNTIME_ID}`;
/** Another run in the workspace: where a fallen-back attribution puts the exec run's events. */
const otherRunId = `run_it_other_${RUNTIME_ID}`;
const workspaceId = `ws_it_${RUNTIME_ID}`;
const userId = `user_it_${RUNTIME_ID}`;

const event = (
  sequence: bigint,
  init: MessageInitShape<typeof EventEnvelopeSchema> = {},
): NormalizedEvent =>
  normalizeEnvelope(
    create(EventEnvelopeSchema, {
      schemaVersion: 1,
      eventId: `evt_redelivery_${sequence.toString(16)}`,
      runtimeId: RUNTIME_ID,
      processId: "proc_redelivery",
      sequence,
      observedAt: sequence * 1000n,
      monotonicTimestamp: sequence * 10n,
      captureMethod: 1,
      confidence: 1,
      payload: {
        case: "ioChunk",
        value: {
          stream: StreamKind.STDOUT,
          byteCount: 2n,
          streamOffset: (sequence - 1n) * 2n,
          content: new TextEncoder().encode(`${String(sequence % 10n)}\n`),
        },
      },
      ...init,
    }),
  );

const events = (from: bigint, count: number) =>
  Array.from({ length: count }, (_, index) => event(from + BigInt(index)));

const dbLayer = DATABASE_URL === undefined ? undefined : makeSealantDBLayer(DATABASE_URL);

describe.skipIf(DATABASE_URL === undefined)("appendBatch re-delivery (real Postgres)", () => {
  const db = dbLayer!;
  const artifactLayer = InlineByteaArtifactStoreLive.pipe(Layer.provide(db));
  const layer = Layer.mergeAll(
    db,
    PostgresTelemetrySinkLive.pipe(Layer.provide(Layer.mergeAll(db, artifactLayer))),
  );

  const errors: string[] = [];
  const recorder = Logger.make(({ message, logLevel }) => {
    if (logLevel === "Error" || logLevel === "Warn") {
      errors.push(Array.isArray(message) ? message.map((part) => String(part)).join(" ") : "");
    }
  });
  const run = <A, E>(effect: Effect.Effect<A, E, TelemetrySink | SealantDB>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(Logger.layer([recorder]))));

  const append = (batch: readonly NormalizedEvent[], forRun = runId) =>
    Effect.gen(function* () {
      const sink = yield* TelemetrySink;
      return yield* sink.appendBatch({ runId: forRun, runtimeId: RUNTIME_ID, batch });
    });

  const spans = Effect.gen(function* () {
    const handle = yield* SealantDB;
    return yield* handle
      .select()
      .from(telemetryLossSpans)
      .where(eq(telemetryLossSpans.runtimeId, RUNTIME_ID))
      .orderBy(asc(telemetryLossSpans.fromSequence));
  });

  const stored = Effect.gen(function* () {
    const handle = yield* SealantDB;
    return yield* handle
      .select()
      .from(telemetryEvents)
      .where(eq(telemetryEvents.runtimeId, RUNTIME_ID))
      .orderBy(asc(telemetryEvents.sequence));
  });

  const cleanup = Effect.gen(function* () {
    const handle = yield* SealantDB;
    yield* handle.delete(workspaces).where(eq(workspaces.id, workspaceId)); // cascades
    yield* handle.delete(user).where(eq(user.id, userId));
  });

  beforeAll(async () => {
    await run(
      Effect.gen(function* () {
        yield* cleanup;
        const handle = yield* SealantDB;
        const now = new Date();
        yield* handle.insert(user).values({
          id: userId,
          name: "redelivery-it",
          email: `${userId}@example.test`,
          createdAt: now,
          updatedAt: now,
        });
        yield* handle
          .insert(workspaces)
          .values({ id: workspaceId, ownerUserId: userId, createdAt: now, updatedAt: now });
        yield* handle.insert(runs).values(
          [runId, otherRunId].map((id) => ({
            id,
            workspaceId,
            ownerUserId: userId,
            harnessId: "exec",
            createdAt: now,
            updatedAt: now,
          })),
        );
        const sink = yield* TelemetrySink;
        yield* sink.openEpoch({ runId, runtimeId: RUNTIME_ID, schemaVersion: 0 });
      }),
    );
  });

  afterAll(async () => {
    await run(cleanup);
  });

  it("takes an identical re-delivered batch as nothing", async () => {
    errors.length = 0;
    const started = event(1n, {
      payload: {
        case: "processStarted",
        value: { pid: 7, pgid: 7, executable: "sh", args: ["-c", "echo secret"], cwd: "/" },
      },
    });
    const batch = [started, ...events(2n, 3)];
    const [first, second] = await run(Effect.all([append(batch), append(batch)]));
    expect(first.appended).toHaveLength(4);
    expect(second).toEqual({ appended: [], conflicts: [] });
    expect((await run(stored)).map((row) => row.sequence)).toEqual([1n, 2n, 3n, 4n]);
    expect(errors).toEqual([]);
  });

  it("takes only the new events of a retried batch whose first attempt committed", async () => {
    errors.length = 0;
    await run(append(events(10n, 3)));
    // The first attempt's commit was not acknowledged; the retry carries it again, and more.
    const retried = await run(append(events(10n, 5)));
    expect(retried.appended.map((committed) => committed.sequence)).toEqual([13n, 14n]);
    expect(retried.conflicts).toEqual([]);
    expect(
      (await run(stored)).filter((row) => row.sequence >= 10n).map((row) => row.sequence),
    ).toEqual([10n, 11n, 12n, 13n, 14n]);
    expect(errors).toEqual([]);
  });

  it("skips the same event inserted by another transaction at the same moment", async () => {
    errors.length = 0;
    // The box's race, made deterministic. The other writer's transaction holds an uncommitted row
    // with the event's id, at a sequence the old arbiter does not look at, until this append is
    // blocked on it; it then moves the row to the event's own sequence and commits. Against the
    // old `(runtime_id, sequence)` arbiter the append waited on the primary key and failed on it;
    // with every unique key an arbiter it waits, then skips the row.
    const raced = event(5000n);
    const outcome = await run(
      Effect.gen(function* () {
        const handle = yield* SealantDB;
        const inserted = yield* Deferred.make<void>();
        const blocked = yield* Deferred.make<void>();
        const other = yield* Effect.forkChild(
          handle.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(telemetryEvents)
                .values({ ...eventRow(raced, runId), sequence: 5_000_000n });
              yield* Deferred.succeed(inserted, undefined);
              yield* Deferred.await(blocked);
              yield* tx
                .update(telemetryEvents)
                .set({ sequence: raced.sequence })
                .where(eq(telemetryEvents.eventId, raced.eventId));
            }),
          ),
        );
        yield* Deferred.await(inserted);
        const appending = yield* Effect.forkChild(Effect.result(append([raced])));
        yield* handle
          .execute<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE 'insert into "telemetry_events"%'`,
          )
          .pipe(
            Effect.flatMap(([row]) =>
              (row?.n ?? 0) > 0 ? Effect.void : Effect.fail("not blocked yet"),
            ),
            Effect.retry(Schedule.spaced("10 millis").pipe(Schedule.both(Schedule.recurs(500)))),
          );
        yield* Deferred.succeed(blocked, undefined);
        yield* Fiber.join(other);
        return yield* Fiber.join(appending);
      }),
    );
    if (Result.isFailure(outcome)) throw new Error(rootCauseMessage(outcome.failure));
    expect(outcome.success).toEqual({ appended: [], conflicts: [] });
    expect(
      (await run(stored)).filter((row) => row.eventId === raced.eventId).map((row) => row.sequence),
    ).toEqual([5000n]);
    expect(errors).toEqual([]);
  });

  it("keeps the stored event, records the conflict and returns it when a different event reuses its id or position", async () => {
    errors.length = 0;
    await run(append([event(100n), event(101n)]));
    // Same id, another sequence: the old arbiter let it through to fail on the primary key.
    const sameId = { ...event(102n), eventId: event(100n).eventId };
    // Same position, another id and other bytes.
    const samePosition = event(101n, {
      eventId: "evt_redelivery_other",
      payload: { case: "runtimeHeartbeat", value: { state: 2 } },
    });
    const result = await run(append([sameId, samePosition, event(103n)]));

    expect(result.appended.map((row) => row.sequence)).toEqual([103n]);
    expect(
      result.conflicts.map((conflict) => [conflict.eventId, conflict.sequence, conflict.runId]),
    ).toEqual([
      ["evt_redelivery_64", 102n, runId],
      ["evt_redelivery_other", 101n, runId],
    ]);
    const kept = (await run(stored)).filter((row) => row.sequence >= 100n && row.sequence < 200n);
    expect(kept.map((row) => [row.eventId, row.sequence, row.payloadCase])).toEqual([
      ["evt_redelivery_64", 100n, "ioChunk"],
      ["evt_redelivery_65", 101n, "ioChunk"],
      ["evt_redelivery_67", 103n, "ioChunk"],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("2 re-delivered event(s)");
    const recorded = (await run(spans)).filter(
      (span) => span.fromSequence !== null && span.fromSequence >= 100n && span.fromSequence < 200n,
    );
    expect(recorded.map((span) => [span.runId, span.kind, span.fromSequence, span.reason])).toEqual(
      [
        [
          runId,
          "dropped_event",
          101n,
          "event evt_redelivery_other was delivered at the position of evt_redelivery_65; the stored one is kept",
        ],
        [
          runId,
          "dropped_event",
          102n,
          "event evt_redelivery_64 was delivered again with other sequence, observedAt, monotonicTimestamp, payload; the stored one is kept",
        ],
      ],
    );
  });

  it("reports a conflicting output event to the record writer, which does not call the record whole", async () => {
    errors.length = 0;
    // The reviewer's case: a heartbeat at 600, then an output event at 601 reusing its id.
    const heartbeat = event(600n, { payload: { case: "runtimeHeartbeat", value: { state: 2 } } });
    const output = { ...event(601n), eventId: heartbeat.eventId };
    const loss = await run(
      Effect.gen(function* () {
        yield* append([heartbeat]);
        const sink = yield* TelemetrySink;
        const writer = makeRunRecordWriter(sink, { runId, runtimeId: RUNTIME_ID });
        yield* writer.append([output]);
        return yield* writer.verify;
      }),
    );
    expect(loss).toMatchObject({ events: 1, fromSequence: 601n, toSequence: 601n });
    expect((await run(spans)).some((span) => span.fromSequence === 601n)).toBe(true);
  });

  it("takes a run-tagged event stored under another run as a conflict for its own run", async () => {
    errors.length = 0;
    // The ingester's attribution fell back to another run; the job appends it for the exec run.
    const output = event(700n, { executionId: runId });
    const result = await run(
      Effect.gen(function* () {
        yield* append([output], otherRunId);
        return yield* append([output]);
      }),
    );
    expect(result.conflicts).toMatchObject([
      { eventId: output.eventId, runId, differences: ["runId"] },
    ]);
    // The other way round (the job stored it rightly, the ingester's fallback re-delivers) is the
    // same event.
    const rightly = event(701n, { executionId: runId });
    const again = await run(Effect.andThen(append([rightly]), append([rightly], otherRunId)));
    expect(again).toEqual({ appended: [], conflicts: [] });
  });

  it("counts the stored events of each range, a tagged one only under the run", async () => {
    await run(append([event(800n), event(801n)]));
    await run(append([event(802n, { executionId: runId })], otherRunId));
    const counts = await run(
      Effect.gen(function* () {
        const sink = yield* TelemetrySink;
        return yield* sink.countStored({
          runId,
          runtimeId: RUNTIME_ID,
          ranges: [
            { from: 800n, to: 801n, tagged: false },
            { from: 802n, to: 802n, tagged: true },
            { from: 802n, to: 802n, tagged: false },
            { from: 803n, to: 805n, tagged: false },
          ],
        });
      }),
    );
    expect(counts).toEqual([2, 0, 1, 0]);
  });
});
