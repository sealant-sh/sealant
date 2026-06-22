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
          .select()
          .from(telemetryTimeline)
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
});

export const TelemetryQueryLive = Layer.effect(
  TelemetryQuery,
  Effect.gen(function* () {
    const db = yield* SealantDB;
    const artifacts = yield* ArtifactStore;
    return makeTelemetryQuery(db, artifacts);
  }),
);
