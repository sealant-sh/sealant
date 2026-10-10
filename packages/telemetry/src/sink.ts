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
 * read back. The same event, in a run that holds it, is nothing. A different one (or two different
 * events with one id in the batch) is a conflict: the log keeps what it has, and the append, after
 * storing the rest, fails with a `TelemetrySinkConflictError` naming them (see `redelivery.ts`).
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
import {
  TelemetrySinkConflictError,
  type TelemetrySinkError,
  withTelemetrySinkError,
} from "./errors.js";
import { deriveScrollbackRow, deriveTimelineRow, eventRow } from "./normalize.js";
import { conflictingRedeliveries, describeConflicts, splitDuplicateIds } from "./redelivery.js";
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
  /**
   * Append a batch idempotently; returns ONLY the newly-committed events. Fails with a
   * `TelemetrySinkConflictError` when an event is not the one the log holds at its id or position.
   */
  readonly appendBatch: (
    input: AppendBatchInput,
  ) => Effect.Effect<readonly NormalizedEvent[], TelemetrySinkError>;
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
 * Reads back the events an insert did not take: those that are not the event the log holds, in a
 * run that holds it. A read that fails fails the append: the batch is committed, so a retry stores
 * nothing again and reads back once more.
 */
const readBackConflicts = (
  db: TSealantDB,
  skipped: readonly NormalizedEvent[],
  runIdFor: (event: NormalizedEvent) => string,
) => {
  const sequencesByRuntime = new Map<string, bigint[]>();
  for (const event of skipped) {
    const sequences = sequencesByRuntime.get(event.runtimeId) ?? [];
    sequences.push(event.sequence);
    sequencesByRuntime.set(event.runtimeId, sequences);
  }
  return db
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
    )
    .pipe(Effect.map((stored) => conflictingRedeliveries(skipped, stored, runIdFor)));
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
      return `tls_${runId}_${runtimeId}_drop_${span.atSequence ?? "x"}`;
    case "watch_overflow":
      return `tls_${runId}_${runtimeId}_watch_${span.atSequence ?? "x"}`;
    case "early_close":
      return `tls_${runId}_${runtimeId}_early_close`;
  }
};

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
        // Per-event attribution: an event tagged (via `attributeBatch`) with a sibling run's id is
        // stored under THAT run; everything else lands on the connection's default run.
        const runIdFor = (event: NormalizedEvent): string => event.attributedRunId ?? input.runId;

        // Intra-batch dedup on the absolute key: a copy of the same event is dropped, a different
        // event reusing an id is a conflict, never silently dropped.
        const { unique: batch, conflicts: inBatch } = splitDuplicateIds(input.batch, runIdFor);
        if (batch.length === 0) {
          return [];
        }

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
            // Never lowered (GREATEST skips a NULL), whichever writer commits last.
            yield* tx
              .update(telemetryRunEpochs)
              .set({ lastSequence: sql`greatest(${telemetryRunEpochs.lastSequence}, ${maxSeq})` })
              .where(
                and(
                  eq(telemetryRunEpochs.runId, input.runId),
                  eq(telemetryRunEpochs.runtimeId, input.runtimeId),
                ),
              );

            return committed;
          }),
        );

        const appendedIds = new Set(appended.map((event) => event.eventId));
        const skipped = batch.filter((event) => !appendedIds.has(event.eventId));
        const conflicts = [
          ...inBatch,
          ...(skipped.length === 0 ? [] : yield* readBackConflicts(db, skipped, runIdFor)),
        ];
        if (conflicts.length > 0) {
          const message = describeConflicts(conflicts);
          yield* Effect.logError(`telemetry: ${message}`, conflicts);
          return yield* new TelemetrySinkConflictError({
            operation: "appendBatch",
            message,
            eventIds: conflicts.map((conflict) => conflict.eventId),
          });
        }
        return appended;
      }),
    ),

  insertLossSpan: (input) =>
    withTelemetrySinkError(
      "insertLossSpan",
      db
        .insert(telemetryLossSpans)
        .values({
          id: lossSpanId(input.runId, input.runtimeId, input.span),
          runId: input.runId,
          runtimeId: input.runtimeId,
          kind: input.span.kind,
          fromSequence: input.span.fromSequence ?? null,
          toSequence: input.span.toSequence ?? null,
          droppedCount: input.span.droppedCount ?? null,
          priority: input.span.priority ?? null,
          reason: input.span.reason ?? null,
          detectedVia: input.span.detectedVia,
        })
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
