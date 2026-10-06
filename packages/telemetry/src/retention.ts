/**
 * Run-record retention. By default a run's record (`telemetry_*`) is kept for as long as its run:
 * until the run's owner is deleted, which cascades. An operator who sets
 * `SEALANT_RUN_RECORD_RETENTION_DAYS` has the worker delete the record of every run that finished
 * longer ago than that. The run row itself stays (its status, exit code, changes) and records when
 * its record went (`recordDeletedAt` on the run resource); its timeline, scrollback, events and
 * loss spans go, so the record then reads as empty.
 */
import { runs, type TSealantDB } from "@sealant/db";
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { Effect } from "effect";

export interface DeleteExpiredRunRecordsOptions {
  /** Records of runs that finished before this instant are deleted. */
  readonly finishedBefore: Date;
  /** Rows one statement (and so one transaction) deletes at most. */
  readonly chunkRows?: number;
  /** Rows one call deletes at most, across every table; the next call carries on. */
  readonly maxRows?: number;
}

export interface DeletedRunRecords {
  /** Runs whose records were deleted whole. */
  readonly runs: number;
  /** Rows deleted, across every table. */
  readonly rows: number;
}

const DEFAULT_CHUNK_ROWS = 5_000;
const DEFAULT_MAX_ROWS = 500_000;

/**
 * The record's tables. A run is marked (`runs.record_deleted_at`) only once all of them are empty
 * for it, so a call cut short by `maxRows`, or a crash, is finished by the next one.
 */
const RECORD_TABLES = [
  "telemetry_timeline",
  "telemetry_scrollback",
  "telemetry_artifacts",
  "telemetry_loss_spans",
  "telemetry_events",
  "telemetry_run_epochs",
] as const;

/**
 * Deletes the records of runs that finished before `finishedBefore`, oldest first, at most
 * `chunkRows` rows per statement and `maxRows` per call, so one long interactive run's millions of
 * events never land in a single transaction. A record being deleted can read partly until its
 * deletion finishes. A run that has not finished is never touched. Two calls at once are harmless:
 * the second finds the rows already gone.
 */
export const deleteExpiredRunRecords = (db: TSealantDB, options: DeleteExpiredRunRecordsOptions) =>
  Effect.gen(function* () {
    const chunkRows = options.chunkRows ?? DEFAULT_CHUNK_ROWS;
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    let deletedRuns = 0;
    let deletedRows = 0;

    while (deletedRows < maxRows) {
      // `runs_record_retention_idx` holds exactly the finished runs whose record is still here.
      const [expired] = yield* db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            isNotNull(runs.finishedAt),
            lt(runs.finishedAt, options.finishedBefore),
            isNull(runs.recordDeletedAt),
          ),
        )
        .orderBy(asc(runs.finishedAt))
        .limit(1);
      if (expired === undefined) {
        break;
      }

      let finished = true;
      for (const table of RECORD_TABLES) {
        for (;;) {
          if (deletedRows >= maxRows) {
            finished = false;
            break;
          }
          const limit = Math.min(chunkRows, maxRows - deletedRows);
          const [result] = yield* db.execute<{ deleted: number }>(sql`
            WITH "doomed" AS (
              SELECT ctid FROM ${sql.identifier(table)}
              WHERE "run_id" = ${expired.id}
              LIMIT ${limit}
            ), "deleted" AS (
              DELETE FROM ${sql.identifier(table)}
              WHERE ctid IN (SELECT ctid FROM "doomed")
              RETURNING 1
            )
            SELECT count(*)::int AS "deleted" FROM "deleted"`);
          const deleted = result?.deleted ?? 0;
          deletedRows += deleted;
          if (deleted < limit) {
            break;
          }
        }
        if (!finished) {
          break;
        }
      }
      if (!finished) {
        break;
      }
      yield* db.update(runs).set({ recordDeletedAt: new Date() }).where(eq(runs.id, expired.id));
      deletedRuns += 1;
    }

    return { runs: deletedRuns, rows: deletedRows } satisfies DeletedRunRecords;
  });
