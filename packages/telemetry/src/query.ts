/**
 * TelemetryQuery — the read side over the projections + log. Fast reads for the SDK-facing facade:
 * a run timeline, a single raw event, a loss report, and byte-exact terminal scrollback reconstructed
 * by `streamOffset` (resolving content from the {@link ArtifactStore}).
 */
import {
  SealantDB,
  telemetryEvents,
  telemetryLossSpans,
  telemetryRunEpochs,
  telemetryScrollback,
  telemetryTimeline,
  type TelemetryEvent,
  type TSealantDB,
} from "@sealant/db";
import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { Context, Effect, Layer, Stream } from "effect";

import { ArtifactStore, type ArtifactStoreService } from "./artifact-store.js";
import {
  mapTelemetryQueryError,
  TelemetryQueryInvariantError,
  type TelemetryQueryError,
  withTelemetryQueryError,
} from "./errors.js";
import type { LossReport, PayloadCase, RunSummary, TimelineEntry } from "./types.js";

export interface GetTimelineOptions {
  readonly fromSequence?: bigint;
  readonly toSequence?: bigint;
  readonly cases?: readonly PayloadCase[];
}

export interface ScrollbackRangeOptions {
  /** Restrict to one process (omit to select by session or run-wide). */
  readonly processId?: string;
  /** Restrict to one daemon session (interactive PTY output). */
  readonly sessionId?: string;
  /** Inclusive lower sequence bound. */
  readonly fromSequence?: bigint;
  /** Inclusive upper sequence bound. */
  readonly toSequence?: bigint;
  /** Maximum chunks returned (default 5000). */
  readonly limit?: number;
}

/** One recorded output chunk with its bytes resolved and its resume cursor (the sequence). */
export interface ScrollbackChunk {
  readonly sequence: bigint;
  readonly stream: number;
  readonly streamOffset: bigint;
  readonly bytes: Uint8Array;
  /** True when the chunk's content was not recorded (metadata-only) — a hole, not empty output. */
  readonly missing: boolean;
}

export interface TelemetryQueryService {
  readonly listRuns: (filter?: {
    readonly limit?: number;
  }) => Effect.Effect<readonly RunSummary[], TelemetryQueryError>;
  readonly getTimeline: (
    runId: string,
    options?: GetTimelineOptions,
  ) => Stream.Stream<TimelineEntry, TelemetryQueryError>;
  readonly getEvent: (
    runId: string,
    sequence: bigint,
  ) => Effect.Effect<TelemetryEvent, TelemetryQueryError>;
  readonly getLossReport: (runId: string) => Effect.Effect<LossReport, TelemetryQueryError>;
  /** Byte-exact scrollback for `(processId, stream)` up to `atSequence`, ordered by `streamOffset`. */
  readonly reconstructScrollback: (
    runId: string,
    processId: string,
    stream: number,
    atSequence: bigint,
  ) => Stream.Stream<Uint8Array, TelemetryQueryError>;
  /**
   * Byte-exact recorded output chunks for a run, by SEQUENCE RANGE — the resumable read behind
   * session reattach and the live SSE tail. Ordered by sequence (the durable cursor); each chunk
   * carries its sequence so a reader resumes with `lastSequence + 1n`. `stream` is the numeric
   * `StreamKind` (stdout 2, stderr 3, ptyOutput 5); an array reads several kinds in one
   * sequence-ordered pass (a session records pty output OR plain stdout, never both — callers
   * that serve "the session's output" pass both kinds and the store answers with whichever
   * exists).
   */
  readonly scrollbackChunks: (
    runId: string,
    stream: number | readonly number[],
    options?: ScrollbackRangeOptions,
  ) => Effect.Effect<readonly ScrollbackChunk[], TelemetryQueryError>;
  /** Highest ingested sequence for a run ("0" when nothing is ingested yet) — the resume cursor. */
  readonly maxSequence: (runId: string) => Effect.Effect<bigint, TelemetryQueryError>;
  /**
   * Whether an ingest epoch exists for the run — i.e. a telemetry ingester holds (or held) a live
   * connection for it. Session creation awaits this BEFORE opening the PTY so the recording starts
   * at byte zero (the live-tail protocol has no replay; attaching late is head-loss).
   */
  readonly hasEpoch: (runId: string) => Effect.Effect<boolean, TelemetryQueryError>;
}

export class TelemetryQuery extends Context.Service<TelemetryQuery, TelemetryQueryService>()(
  "@sealant/telemetry/TelemetryQuery",
) {}

export const makeTelemetryQuery = (
  db: TSealantDB,
  artifacts: ArtifactStoreService,
): TelemetryQueryService => ({
  listRuns: (filter) =>
    withTelemetryQueryError(
      "listRuns",
      Effect.gen(function* () {
        const limit = Math.min(Math.max(filter?.limit ?? 25, 1), 100);
        const epochs = yield* db
          .select()
          .from(telemetryRunEpochs)
          .orderBy(desc(telemetryRunEpochs.openedAt))
          .limit(limit);

        return yield* Effect.forEach(epochs, (epoch) =>
          Effect.gen(function* () {
            const [counted] = yield* db
              .select({ value: count() })
              .from(telemetryEvents)
              .where(
                and(
                  eq(telemetryEvents.runId, epoch.runId),
                  eq(telemetryEvents.runtimeId, epoch.runtimeId),
                ),
              );
            return {
              runId: epoch.runId,
              runtimeId: epoch.runtimeId,
              status: epoch.status,
              eventsPersisted: BigInt(counted?.value ?? 0),
              firstSequence: epoch.firstSequence,
              lastSequence: epoch.lastSequence,
            } satisfies RunSummary;
          }),
        );
      }),
    ),

  getTimeline: (runId, options) =>
    Stream.unwrap(
      withTelemetryQueryError(
        "getTimeline",
        db
          .select({
            eventId: telemetryTimeline.eventId,
            sequence: telemetryTimeline.sequence,
            kind: telemetryTimeline.kind,
            occurredAt: telemetryTimeline.occurredAt,
            summary: telemetryTimeline.summary,
            refJson: telemetryTimeline.refJson,
            // Correlation + provenance joined from the log (event_id is the PK on both sides).
            processId: telemetryEvents.processId,
            captureMethod: telemetryEvents.captureMethod,
            confidence: telemetryEvents.confidence,
          })
          .from(telemetryTimeline)
          .innerJoin(telemetryEvents, eq(telemetryEvents.eventId, telemetryTimeline.eventId))
          .where(
            and(
              eq(telemetryTimeline.runId, runId),
              ...(options?.fromSequence === undefined
                ? []
                : [gte(telemetryTimeline.sequence, options.fromSequence)]),
              ...(options?.toSequence === undefined
                ? []
                : [lte(telemetryTimeline.sequence, options.toSequence)]),
              ...(options?.cases === undefined || options.cases.length === 0
                ? []
                : [inArray(telemetryTimeline.kind, [...options.cases])]),
            ),
          )
          .orderBy(asc(telemetryTimeline.sequence))
          .pipe(
            Effect.map((rows) =>
              Stream.fromIterable(
                rows.map(
                  (row): TimelineEntry => ({
                    eventId: row.eventId,
                    sequence: row.sequence,
                    kind: row.kind,
                    occurredAt: row.occurredAt,
                    summary: row.summary,
                    ref: row.refJson,
                    processId: row.processId,
                    captureMethod: row.captureMethod,
                    confidence: row.confidence,
                  }),
                ),
              ),
            ),
          ),
      ),
    ),

  getEvent: (runId, sequence) =>
    withTelemetryQueryError(
      "getEvent",
      Effect.gen(function* () {
        const [row] = yield* db
          .select()
          .from(telemetryEvents)
          .where(and(eq(telemetryEvents.runId, runId), eq(telemetryEvents.sequence, sequence)))
          .orderBy(asc(telemetryEvents.runtimeId))
          .limit(1);
        if (row === undefined) {
          return yield* new TelemetryQueryInvariantError({
            operation: "getEvent",
            message: `No event at sequence ${sequence.toString()} for run ${runId}.`,
          });
        }
        return row;
      }),
    ),

  getLossReport: (runId) =>
    withTelemetryQueryError(
      "getLossReport",
      Effect.gen(function* () {
        const spans = yield* db
          .select()
          .from(telemetryLossSpans)
          .where(eq(telemetryLossSpans.runId, runId))
          .orderBy(asc(telemetryLossSpans.detectedAt));

        let droppedEventCount = 0n;
        let sequenceGapCount = 0;
        let watchOverflowCount = 0;
        let earlyClose = false;
        for (const span of spans) {
          if (span.kind === "dropped_event") {
            droppedEventCount += span.droppedCount ?? 0n;
          } else if (span.kind === "sequence_gap") {
            sequenceGapCount += 1;
          } else if (span.kind === "watch_overflow") {
            watchOverflowCount += 1;
          } else if (span.kind === "early_close") {
            earlyClose = true;
          }
        }

        return {
          runId,
          droppedEventCount,
          sequenceGapCount,
          watchOverflowCount,
          earlyClose,
          spans: spans.map((span) => ({
            kind: span.kind,
            fromSequence: span.fromSequence,
            toSequence: span.toSequence,
            droppedCount: span.droppedCount,
            detectedVia: span.detectedVia,
            reason: span.reason,
          })),
        } satisfies LossReport;
      }),
    ),

  reconstructScrollback: (runId, processId, stream, atSequence) =>
    Stream.unwrap(
      withTelemetryQueryError(
        "reconstructScrollback",
        db
          .select()
          .from(telemetryScrollback)
          .where(
            and(
              eq(telemetryScrollback.runId, runId),
              eq(telemetryScrollback.processId, processId),
              eq(telemetryScrollback.stream, stream),
              lte(telemetryScrollback.sequence, atSequence),
            ),
          )
          .orderBy(asc(telemetryScrollback.streamOffset))
          .pipe(
            Effect.map((rows) =>
              Stream.fromIterable(rows).pipe(
                Stream.mapEffect((row) =>
                  row.contentAlgo === null || row.contentHash === null
                    ? Effect.succeed(new Uint8Array())
                    : artifacts
                        .get({ runId, algo: row.contentAlgo, hash: row.contentHash })
                        .pipe(
                          Effect.mapError((cause) =>
                            mapTelemetryQueryError("reconstructScrollback", cause),
                          ),
                        ),
                ),
              ),
            ),
          ),
      ),
    ),
  scrollbackChunks: (runId, stream, options) =>
    withTelemetryQueryError(
      "scrollbackChunks",
      Effect.gen(function* () {
        const limit = Math.min(Math.max(options?.limit ?? 5000, 1), 10_000);
        const rows = yield* db
          .select()
          .from(telemetryScrollback)
          .where(
            and(
              eq(telemetryScrollback.runId, runId),
              typeof stream === "number"
                ? eq(telemetryScrollback.stream, stream)
                : inArray(telemetryScrollback.stream, [...stream]),
              ...(options?.processId === undefined
                ? []
                : [eq(telemetryScrollback.processId, options.processId)]),
              ...(options?.sessionId === undefined
                ? []
                : [eq(telemetryScrollback.sessionId, options.sessionId)]),
              ...(options?.fromSequence === undefined
                ? []
                : [gte(telemetryScrollback.sequence, options.fromSequence)]),
              ...(options?.toSequence === undefined
                ? []
                : [lte(telemetryScrollback.sequence, options.toSequence)]),
            ),
          )
          .orderBy(asc(telemetryScrollback.sequence))
          .limit(limit);

        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            if (row.contentAlgo === null || row.contentHash === null) {
              // A hole (metadata-only capture), surfaced honestly instead of as empty output.
              return {
                sequence: row.sequence,
                stream: row.stream,
                streamOffset: row.streamOffset,
                bytes: new Uint8Array(),
                missing: true,
              } satisfies ScrollbackChunk;
            }
            const bytes = yield* artifacts
              .get({ runId, algo: row.contentAlgo, hash: row.contentHash })
              .pipe(Effect.mapError((cause) => mapTelemetryQueryError("scrollbackChunks", cause)));
            return {
              sequence: row.sequence,
              stream: row.stream,
              streamOffset: row.streamOffset,
              bytes,
              missing: false,
            } satisfies ScrollbackChunk;
          }),
        );
      }),
    ),

  maxSequence: (runId) =>
    withTelemetryQueryError(
      "maxSequence",
      Effect.gen(function* () {
        const [row] = yield* db
          .select({ sequence: telemetryEvents.sequence })
          .from(telemetryEvents)
          .where(eq(telemetryEvents.runId, runId))
          .orderBy(desc(telemetryEvents.sequence))
          .limit(1);
        return row?.sequence ?? 0n;
      }),
    ),

  hasEpoch: (runId) =>
    withTelemetryQueryError(
      "hasEpoch",
      Effect.gen(function* () {
        const [row] = yield* db
          .select({ runId: telemetryRunEpochs.runId })
          .from(telemetryRunEpochs)
          .where(eq(telemetryRunEpochs.runId, runId))
          .limit(1);
        return row !== undefined;
      }),
    ),
});

export const TelemetryQueryLive = Layer.effect(
  TelemetryQuery,
  Effect.gen(function* () {
    const db = yield* SealantDB;
    const artifacts = yield* ArtifactStore;
    return makeTelemetryQuery(db, artifacts);
  }),
);
