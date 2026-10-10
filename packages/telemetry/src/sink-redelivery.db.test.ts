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
 * Conflicts (a different event at the same id or position, in the log or in the same batch, or a
 * run-tagged event in another run) keep what the log holds, store the rest of the batch, and fail
 * the append with a `TelemetrySinkConflictError` naming them, so no writer takes them as recorded.
 */
import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  makeSealantDBLayer,
  runs,
  SealantDB,
  telemetryEvents,
  user,
  workspaces,
} from "@sealant/db";
import { StreamKind } from "@sealant/runtime-client";
import { EventEnvelopeSchema } from "@sealant/runtime-protocol";
import { asc, eq } from "drizzle-orm";
import { Cause, Deferred, Effect, Fiber, Layer, Logger, Result, Schedule } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InlineByteaArtifactStoreLive } from "./artifact-store.js";
import { TelemetrySinkConflictError } from "./errors.js";
import { eventRow, normalizeEnvelope } from "./normalize.js";
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

/**
 * The database's own words under the sink's and the driver's errors (the driver's cause is an
 * Effect `Cause`).
 */
const rootCauseMessage = (error: unknown): string => {
  let innermost = error;
  for (let depth = 0; depth < 12; depth += 1) {
    const next = Cause.isCause(innermost)
      ? Cause.squash(innermost)
      : innermost instanceof Error
        ? innermost.cause
        : undefined;
    if (next === undefined || next === null || next === innermost) break;
    innermost = next;
  }
  return innermost instanceof Error ? innermost.message : String(innermost);
};

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
    expect(first).toHaveLength(4);
    expect(second).toEqual([]);
    expect((await run(stored)).map((row) => row.sequence)).toEqual([1n, 2n, 3n, 4n]);
    expect(errors).toEqual([]);
  });

  it("takes only the new events of a retried batch whose first attempt committed", async () => {
    errors.length = 0;
    await run(append(events(10n, 3)));
    // The first attempt's commit was not acknowledged; the retry carries it again, and more.
    const retried = await run(append(events(10n, 5)));
    expect(retried.map((committed) => committed.sequence)).toEqual([13n, 14n]);
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
    expect(outcome.success).toEqual([]);
    expect(
      (await run(stored)).filter((row) => row.eventId === raced.eventId).map((row) => row.sequence),
    ).toEqual([5000n]);
    expect(errors).toEqual([]);
  });

  /** Runs `effect` and returns its failure; fails the test when it succeeds. */
  const failureOf = async <A, E>(effect: Effect.Effect<A, E, TelemetrySink | SealantDB>) => {
    const outcome = await run(Effect.result(effect));
    if (Result.isSuccess(outcome)) throw new Error("expected the append to fail");
    return outcome.failure;
  };

  it("keeps the stored events, stores the rest and fails naming the ones that reuse an id or position", async () => {
    errors.length = 0;
    await run(append([event(100n), event(101n)]));
    // Same id, another sequence: the old arbiter let it through to fail on the primary key.
    const sameId = { ...event(102n), eventId: event(100n).eventId };
    // Same position, another id and other bytes.
    const samePosition = event(101n, {
      eventId: "evt_redelivery_other",
      payload: { case: "runtimeHeartbeat", value: { state: 2 } },
    });
    const failure = await failureOf(append([sameId, samePosition, event(103n)]));

    expect(failure).toBeInstanceOf(TelemetrySinkConflictError);
    expect(failure instanceof TelemetrySinkConflictError && failure.eventIds).toEqual([
      "evt_redelivery_64",
      "evt_redelivery_other",
    ]);
    expect(failure.message).toBe(
      "2 event(s) differ from the ones the record holds (evt_redelivery_64 with other sequence, observedAt, monotonicTimestamp, payload; evt_redelivery_other at the position of evt_redelivery_65); the record keeps its own",
    );
    const kept = (await run(stored)).filter((row) => row.sequence >= 100n && row.sequence < 200n);
    expect(kept.map((row) => [row.eventId, row.sequence, row.payloadCase])).toEqual([
      ["evt_redelivery_64", 100n, "ioChunk"],
      ["evt_redelivery_65", 101n, "ioChunk"],
      ["evt_redelivery_67", 103n, "ioChunk"],
    ]);
    expect(errors).toHaveLength(1);
  });

  it("fails naming a different event that reuses an id inside one batch", async () => {
    errors.length = 0;
    // The reviewer's case: a heartbeat and an output event with its id, in ONE batch. The old
    // in-batch dedup dropped the output without a word.
    const heartbeat = event(650n, { payload: { case: "runtimeHeartbeat", value: { state: 2 } } });
    const output = { ...event(651n), eventId: heartbeat.eventId };
    const failure = await failureOf(append([heartbeat, output]));

    expect(failure instanceof TelemetrySinkConflictError && failure.eventIds).toEqual([
      heartbeat.eventId,
    ]);
    expect(
      (await run(stored))
        .filter((row) => row.sequence >= 650n && row.sequence < 660n)
        .map((row) => [row.sequence, row.payloadCase]),
    ).toEqual([[650n, "runtimeHeartbeat"]]);
    // A copy of the same event in one batch is no conflict.
    expect(await run(append([event(652n), event(652n)]))).toHaveLength(1);
  });

  it("fails on a run-tagged event stored under another run, but not the other way round", async () => {
    errors.length = 0;
    // The ingester's attribution fell back to another run; the job appends it for the exec run.
    const output = event(700n, { executionId: runId });
    await run(append([output], otherRunId));
    const failure = await failureOf(append([output]));
    expect(failure instanceof TelemetrySinkConflictError && failure.eventIds).toEqual([
      output.eventId,
    ]);
    // The job stored it rightly, and the ingester's fallback delivers it again: the same event.
    const rightly = event(701n, { executionId: runId });
    expect(await run(Effect.andThen(append([rightly]), append([rightly], otherRunId)))).toEqual([]);
  });
});
