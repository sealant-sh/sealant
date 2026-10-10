/**
 * TelemetrySink — THE pluggable storage seam (modeled on `SealantTransport` in runtime.ts). The
 * ingester, projector, and query layers never name a concrete engine; a future
 * `ClickHouseTelemetrySinkLive` / `RedisTelemetrySinkLive` slots in behind this Tag with no change
 * to the rest of the package.
 *
 * `PostgresTelemetrySinkLive` is the MVP reference adapter. `appendBatch` is the dedup core:
 * ON CONFLICT DO NOTHING ... RETURNING, then the projections for ONLY the newly-committed rows are
 * written in the SAME transaction (idempotent at-least-once). The conflict has no target: an event
 * is unique by its id AND by its runtime and sequence, and only an arbiter index waits out a
 * concurrent insert of the same row. With `(runtime_id, sequence)` as the only arbiter, a run-exec
 * job and the full-stream ingester inserting the same event at once failed the second insert on
 * the primary key (2026-10-10, a person's exec run). The events the insert did not take are then
 * read back: the same event, in a run that holds it, is nothing. A different one is a conflict: the
 * stored event is kept, the conflict is recorded as a `dropped_event` loss span on the run it was
 * appended for and logged as an error, and the append returns it, so no writer takes it as stored
 * (see `redelivery.ts`).
 */
import {
  SealantDB,
  telemetryEvents,
  telemetryLossSpans,
  telemetryRunEpochs,
  telemetryScrollback,
  telemetryTimeline,
  type NewTelemetryScrollbackRow,
  type TelemetryEvent,
  type TSealantDB,
} from "@sealant/db";
import { and, asc, eq, inArray, max, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Stream } from "effect";

import { ArtifactStore, type ArtifactStoreService } from "./artifact-store.js";
import { type TelemetrySinkError, withTelemetrySinkError } from "./errors.js";
import { deriveScrollbackRow, deriveTimelineRow, eventRow } from "./normalize.js";
import { type ConflictingRedelivery, conflictingRedeliveries } from "./redelivery.js";
import type { LossSpanInput, NormalizedEvent } from "./types.js";

export interface OpenEpochInput {
  readonly runId: string;
  readonly runtimeId: string;
  readonly schemaVersion: number;
}

export interface OpenEpochResult {
  readonly epochId: string;
  readonly resumeFromSequence: bigint | null;
}

export interface AppendBatchInput {
  readonly runId: string;
  readonly runtimeId: string;
  readonly batch: readonly NormalizedEvent[];
}

export interface AppendBatchResult {
  /** The events this append stored. */
  readonly appended: readonly NormalizedEvent[];
  /**
   * The events it did not take because a different event holds their id or position (or the same
   * event is in another run). Each is recorded as a loss span; none is stored as given.
   */
  readonly conflicts: readonly ConflictingRedelivery[];
}

/** Consecutive sequences of one runtime that a writer saw and wants confirmed in the log. */
export interface SequenceRange {
  readonly from: bigint;
  readonly to: bigint;
  /** Tagged with the run as its execution: stored under the run, not just anywhere. */
  readonly tagged: boolean;
}

export interface CountStoredInput {
  readonly runId: string;
  readonly runtimeId: string;
  readonly ranges: readonly SequenceRange[];
}

export interface InsertLossSpanInput {
  readonly runId: string;
  readonly runtimeId: string;
  readonly span: LossSpanInput;
}

export interface CloseEpochInput {
  readonly runId: string;
  readonly runtimeId: string;
  readonly closeReason: "stream-end" | "transport-close" | "shutdown";
  /** When true (no clean terminal STOPPED), record an `early_close` loss span. */
  readonly suspicious: boolean;
}

export interface TelemetrySinkService {
  readonly openEpoch: (input: OpenEpochInput) => Effect.Effect<OpenEpochResult, TelemetrySinkError>;
  /** Append a batch idempotently: what it stored, and what conflicts with the stored log. */
  readonly appendBatch: (
    input: AppendBatchInput,
  ) => Effect.Effect<AppendBatchResult, TelemetrySinkError>;
  /**
   * How many events of each range are in the log, a tagged range's only under `runId`. A range
   * whose count is its length is whole.
   */
  readonly countStored: (
    input: CountStoredInput,
  ) => Effect.Effect<readonly number[], TelemetrySinkError>;
  readonly insertLossSpan: (input: InsertLossSpanInput) => Effect.Effect<void, TelemetrySinkError>;
  readonly closeEpoch: (input: CloseEpochInput) => Effect.Effect<void, TelemetrySinkError>;
  readonly getMaxSequence: (runtimeId: string) => Effect.Effect<bigint | null, TelemetrySinkError>;
  readonly streamRawLog: (runId: string) => Stream.Stream<TelemetryEvent, TelemetrySinkError>;
}

export class TelemetrySink extends Context.Service<TelemetrySink, TelemetrySinkService>()(
  "@sealant/telemetry/TelemetrySink",
) {}

const selectMaxSequence = (db: TSealantDB, runtimeId: string) =>
  db
    .select({ value: max(telemetryEvents.sequence) })
    .from(telemetryEvents)
    .where(eq(telemetryEvents.runtimeId, runtimeId))
    .pipe(
      Effect.map((rows) => {
        const value = rows[0]?.value;
        if (value === undefined || value === null) {
          return null;
        }
        return typeof value === "bigint" ? value : BigInt(value);
      }),
    );

/**
 * Reads back the events an insert did not take and returns each that is not the event the log
 * holds, in a run that holds it, after recording it as a loss span on the run it was for. A read
 * that fails fails the append: the batch is committed, so a retry stores nothing again and reads
 * back once more, and a writer that does not retry has not seen these events confirmed.
 */
const recordConflictingRedeliveries = (
  db: TSealantDB,
  skipped: readonly NormalizedEvent[],
  runIdFor: (event: NormalizedEvent) => string,
) =>
  Effect.gen(function* () {
    const sequencesByRuntime = new Map<string, bigint[]>();
    for (const event of skipped) {
      const sequences = sequencesByRuntime.get(event.runtimeId) ?? [];
      sequences.push(event.sequence);
      sequencesByRuntime.set(event.runtimeId, sequences);
    }
    const stored = yield* db
      .select()
      .from(telemetryEvents)
      .where(
        or(
          inArray(
            telemetryEvents.eventId,
            skipped.map((event) => event.eventId),
          ),
          ...[...sequencesByRuntime].map(([runtimeId, sequences]) =>
            and(
              eq(telemetryEvents.runtimeId, runtimeId),
              inArray(telemetryEvents.sequence, sequences),
            ),
          ),
        ),
      );
    const conflicts = conflictingRedeliveries(skipped, stored, runIdFor);
    if (conflicts.length === 0) return conflicts;

    yield* db
      .insert(telemetryLossSpans)
      .values(
        conflicts.map((conflict) => {
          const span: LossSpanInput = {
            kind: "dropped_event",
            fromSequence: conflict.sequence,
            toSequence: conflict.sequence,
            droppedCount: 1n,
            reason:
              conflict.storedEventIdAtSequence === undefined
                ? `event ${conflict.eventId} was delivered again with other ${conflict.differences.join(", ")}; the stored one is kept`
                : `event ${conflict.eventId} was delivered at the position of ${conflict.storedEventIdAtSequence}; the stored one is kept`,
            detectedVia: "marker",
            atSequence: conflict.sequence,
            key: "conflict",
          };
          return lossSpanRow(conflict.runId, conflict.runtimeId, span);
        }),
      )
      .onConflictDoNothing();
    yield* Effect.logError(
      `telemetry: ${String(conflicts.length)} re-delivered event(s) differ from the stored ones; the stored events are kept and the conflicts recorded`,
      conflicts,
    );
    return conflicts;
  });

const COUNT_STORED_CHUNK = 500;

const chunksOf = <A>(items: readonly A[], size: number): A[][] => {
  const chunks: A[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
};

/**
 * Deterministic, content-derived loss-span id so re-ingest (replay) is idempotent — a re-detected
 * span hits `ON CONFLICT (id) DO NOTHING` instead of inserting a duplicate.
 */
const lossSpanId = (runId: string, runtimeId: string, span: LossSpanInput): string => {
  switch (span.kind) {
    case "sequence_gap":
      return `tls_${runId}_${runtimeId}_gap_${span.fromSequence ?? "x"}_${span.toSequence ?? "x"}`;
    case "dropped_event":
      return `tls_${runId}_${runtimeId}_drop_${span.atSequence ?? "x"}${span.key === undefined ? "" : `_${span.key}`}`;
    case "watch_overflow":
      return `tls_${runId}_${runtimeId}_watch_${span.atSequence ?? "x"}`;
    case "early_close":
      return `tls_${runId}_${runtimeId}_early_close`;
  }
};

const lossSpanRow = (runId: string, runtimeId: string, span: LossSpanInput) => ({
  id: lossSpanId(runId, runtimeId, span),
  runId,
  runtimeId,
  kind: span.kind,
  fromSequence: span.fromSequence ?? null,
  toSequence: span.toSequence ?? null,
  droppedCount: span.droppedCount ?? null,
  priority: span.priority ?? null,
  reason: span.reason ?? null,
  detectedVia: span.detectedVia,
});

export const makePostgresTelemetrySink = (
  db: TSealantDB,
  artifacts: ArtifactStoreService,
): TelemetrySinkService => ({
  openEpoch: (input) =>
    withTelemetrySinkError(
      "openEpoch",
      Effect.gen(function* () {
        const epochId = `tep_${input.runId}_${input.runtimeId.slice(0, 8)}`;
        yield* db
          .insert(telemetryRunEpochs)
          .values({
            id: epochId,
            runId: input.runId,
            runtimeId: input.runtimeId,
            schemaVersion: input.schemaVersion,
            status: "open",
          })
          .onConflictDoNothing();
        const resumeFromSequence = yield* selectMaxSequence(db, input.runtimeId);
        return { epochId, resumeFromSequence };
      }),
    ),

  appendBatch: (input) =>
    withTelemetrySinkError(
      "appendBatch",
      Effect.gen(function* () {
        // Defensive intra-batch dedup on the absolute key.
        const seen = new Set<string>();
        const batch = input.batch.filter((event) => {
          if (seen.has(event.eventId)) {
            return false;
          }
          seen.add(event.eventId);
          return true;
        });
        if (batch.length === 0) {
          return { appended: [], conflicts: [] };
        }

        // Per-event attribution: an event tagged (via `attributeBatch`) with a sibling run's id is
        // stored under THAT run; everything else lands on the connection's default run.
        const runIdFor = (event: NormalizedEvent): string => event.attributedRunId ?? input.runId;

        // Offload content BEFORE the transaction so the tx stays short.
        yield* Effect.forEach(
          batch,
          (event) =>
            event.content === undefined
              ? Effect.void
              : artifacts.put({
                  runId: runIdFor(event),
                  algo: event.content.algo,
                  hash: event.content.hash,
                  bytes: event.content.bytes,
                  byteSize: event.content.byteSize,
                }),
          { discard: true },
        );

        const appended = yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const inserted = yield* tx
              .insert(telemetryEvents)
              .values(batch.map((event) => eventRow(event, runIdFor(event))))
              .onConflictDoNothing()
              .returning({ eventId: telemetryEvents.eventId });

            const committedIds = new Set(inserted.map((row) => row.eventId));
            const committed = batch.filter((event) => committedIds.has(event.eventId));
            if (committed.length === 0) {
              return [];
            }

            yield* tx
              .insert(telemetryTimeline)
              .values(committed.map((event) => deriveTimelineRow(event, runIdFor(event))))
              .onConflictDoNothing();

            const scrollbackRows = committed
              .map((event) => deriveScrollbackRow(event, runIdFor(event)))
              .filter((row): row is NewTelemetryScrollbackRow => row !== undefined);
            if (scrollbackRows.length > 0) {
              yield* tx.insert(telemetryScrollback).values(scrollbackRows).onConflictDoNothing();
            }

            let maxSeq = committed[0]!.sequence;
            for (const event of committed) {
              if (event.sequence > maxSeq) {
                maxSeq = event.sequence;
              }
            }
            // Never lowered (GREATEST skips a NULL): a held-back batch can be appended after later ones.
            yield* tx
              .update(telemetryRunEpochs)
              .set({
                lastSequence: sql`greatest(${telemetryRunEpochs.lastSequence}, ${maxSeq})`,
              })
              .where(
                and(
                  eq(telemetryRunEpochs.runId, input.runId),
                  eq(telemetryRunEpochs.runtimeId, input.runtimeId),
                ),
              );

            return committed;
          }),
        );

        if (appended.length === batch.length) {
          return { appended, conflicts: [] };
        }
        const appendedIds = new Set(appended.map((event) => event.eventId));
        const conflicts = yield* recordConflictingRedeliveries(
          db,
          batch.filter((event) => !appendedIds.has(event.eventId)),
          runIdFor,
        );
        return { appended, conflicts };
      }),
    ),

  insertLossSpan: (input) =>
    withTelemetrySinkError(
      "insertLossSpan",
      db
        .insert(telemetryLossSpans)
        .values(lossSpanRow(input.runId, input.runtimeId, input.span))
        .onConflictDoNothing()
        .pipe(Effect.asVoid),
    ),

  closeEpoch: (input) =>
    withTelemetrySinkError(
      "closeEpoch",
      Effect.gen(function* () {
        const maxSeq = yield* selectMaxSequence(db, input.runtimeId);
        yield* db
          .update(telemetryRunEpochs)
          .set({
            status: "closed",
            closeReason: input.closeReason,
            closedAt: new Date(),
            ...(maxSeq === null
              ? {}
              : { lastSequence: sql`greatest(${telemetryRunEpochs.lastSequence}, ${maxSeq})` }),
          })
          .where(
            and(
              eq(telemetryRunEpochs.runId, input.runId),
              eq(telemetryRunEpochs.runtimeId, input.runtimeId),
            ),
          );

        if (input.suspicious) {
          yield* db
            .insert(telemetryLossSpans)
            .values({
              id: lossSpanId(input.runId, input.runtimeId, {
                kind: "early_close",
                detectedVia: "marker",
              }),
              runId: input.runId,
              runtimeId: input.runtimeId,
              kind: "early_close",
              reason: input.closeReason,
              detectedVia: "marker",
              ...(maxSeq === null ? {} : { toSequence: maxSeq }),
            })
            .onConflictDoNothing();
        }
      }),
    ),

  countStored: (input) =>
    withTelemetrySinkError(
      "countStored",
      Effect.forEach(chunksOf(input.ranges, COUNT_STORED_CHUNK), (ranges) =>
        db
          .execute<{ idx: number; n: number }>(
            sql`SELECT r.idx, count(e.event_id)::int AS n
              FROM jsonb_to_recordset(${JSON.stringify(
                ranges.map((range, idx) => ({
                  idx,
                  from: range.from.toString(),
                  to: range.to.toString(),
                  tagged: range.tagged,
                })),
              )}::jsonb) AS r(idx int, "from" bigint, "to" bigint, tagged boolean)
              LEFT JOIN ${telemetryEvents} e
                ON e.runtime_id = ${input.runtimeId}
               AND e.sequence BETWEEN r."from" AND r."to"
               AND (NOT r.tagged OR e.run_id = ${input.runId})
              GROUP BY r.idx`,
          )
          .pipe(
            Effect.map((rows) => {
              const counts = ranges.map(() => 0);
              for (const row of rows) counts[row.idx] = row.n;
              return counts;
            }),
          ),
      ).pipe(Effect.map((chunks) => chunks.flat())),
    ),

  getMaxSequence: (runtimeId) =>
    withTelemetrySinkError("getMaxSequence", selectMaxSequence(db, runtimeId)),

  streamRawLog: (runId) =>
    Stream.unwrap(
      withTelemetrySinkError(
        "streamRawLog",
        db
          .select()
          .from(telemetryEvents)
          .where(eq(telemetryEvents.runId, runId))
          .orderBy(asc(telemetryEvents.runtimeId), asc(telemetryEvents.sequence))
          .pipe(Effect.map((rows) => Stream.fromIterable(rows))),
      ),
    ),
});

export const PostgresTelemetrySinkLive = Layer.effect(
  TelemetrySink,
  Effect.gen(function* () {
    const db = yield* SealantDB;
    const artifacts = yield* ArtifactStore;
    return makePostgresTelemetrySink(db, artifacts);
  }),
);
