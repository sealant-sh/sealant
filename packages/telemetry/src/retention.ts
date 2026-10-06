/**
 * Run-record retention. By default a run's record (`telemetry_*`) is kept for as long as its run:
 * until the run's owner is deleted, which cascades. An operator who sets
 * `SEALANT_RUN_RECORD_RETENTION_DAYS` has the worker delete the record of every run that finished
 * longer ago than that. The run row itself stays (its status, exit code, changes); its timeline,
 * scrollback, events and loss spans go, so the record then reads as empty.
 */
import {
  runs,
  telemetryArtifacts,
  telemetryEvents,
  telemetryLossSpans,
  telemetryRunEpochs,
  telemetryScrollback,
  telemetryTimeline,
  type TSealantDB,
} from "@sealant/db";
import { and, eq, exists, inArray, isNotNull, lt, or } from "drizzle-orm";
import { Effect } from "effect";

export interface DeleteExpiredRunRecordsOptions {
  /** Records of runs that finished before this instant are deleted. */
  readonly finishedBefore: Date;
  /** Runs whose records one transaction deletes. */
  readonly batchSize?: number;
  /** Batches one call runs at most; the next call carries on. */
  readonly maxBatches?: number;
}

export interface DeletedRunRecords {
  /** Runs whose records were deleted. */
  readonly runs: number;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 50;

/**
 * Deletes the records of runs that finished before `finishedBefore`, a batch of runs per
 * transaction, so a run's record goes whole or not at all. A run that has not finished is never
 * touched. Safe to run from several workers at once: a record already deleted is not found again.
 */
export const deleteExpiredRunRecords = (db: TSealantDB, options: DeleteExpiredRunRecordsOptions) =>
  Effect.gen(function* () {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
    let deletedRuns = 0;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const expired = yield* db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            isNotNull(runs.finishedAt),
            lt(runs.finishedAt, options.finishedBefore),
            or(
              exists(
                db
                  .select({ one: telemetryEvents.eventId })
                  .from(telemetryEvents)
                  .where(eq(telemetryEvents.runId, runs.id)),
              ),
              exists(
                db
                  .select({ one: telemetryRunEpochs.id })
                  .from(telemetryRunEpochs)
                  .where(eq(telemetryRunEpochs.runId, runs.id)),
              ),
            ),
          ),
        )
        .limit(batchSize);
      if (expired.length === 0) {
        break;
      }
      const ids = expired.map((run) => run.id);
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.delete(telemetryTimeline).where(inArray(telemetryTimeline.runId, ids));
          yield* tx.delete(telemetryScrollback).where(inArray(telemetryScrollback.runId, ids));
          yield* tx.delete(telemetryArtifacts).where(inArray(telemetryArtifacts.runId, ids));
          yield* tx.delete(telemetryLossSpans).where(inArray(telemetryLossSpans.runId, ids));
          yield* tx.delete(telemetryRunEpochs).where(inArray(telemetryRunEpochs.runId, ids));
          yield* tx.delete(telemetryEvents).where(inArray(telemetryEvents.runId, ids));
        }),
      );
      deletedRuns += ids.length;
      if (expired.length < batchSize) {
        break;
      }
    }

    return { runs: deletedRuns } satisfies DeletedRunRecords;
  });
