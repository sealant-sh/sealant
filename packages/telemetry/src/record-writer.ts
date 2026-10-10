/**
 * How a run-exec job writes its run's record. The record holds the run's output (its io chunks are
 * the only copy), so every event the job saw must end up in the log, in the run. The job appends
 * each batch once and moves on: it never waits on the store, so the connection's events never pile
 * up behind a slow or refused append. A batch the store refused is remembered as sequence ranges,
 * never as its events, so memory does not grow with the output. When the process has exited,
 * `verify` asks the log whether those sequences are there: the full-stream ingester, when the
 * workspace has one, writes the same events and usually has them. Only sequences still missing
 * after a grace period, and events the log holds a different version of, make the record
 * incomplete.
 */
import { Effect, Schedule } from "effect";

import { rootCauseMessage as reasonOf } from "./errors.js";
import type { SequenceRange, TelemetrySinkService } from "./sink.js";
import type { NormalizedEvent } from "./types.js";

/**
 * How long `verify` gives the other writer to store what the job could not: about eight seconds,
 * past the ingester's 250 ms batch window and its three seconds of retries.
 */
export const RECORD_VERIFY_SCHEDULE = Schedule.exponential("250 millis").pipe(
  Schedule.both(Schedule.recurs(5)),
);

/** The events of a run's record that are not in the log as the job saw them. */
export interface RunRecordLoss {
  readonly events: number;
  readonly fromSequence: bigint;
  readonly toSequence: bigint;
  readonly reason: string;
}

export interface RunRecordWriter {
  /** Append one batch, once. Never fails: what the store does not take is checked by `verify`. */
  readonly append: (batch: readonly NormalizedEvent[]) => Effect.Effect<void>;
  /**
   * Whether every event appended is in the log: `undefined` when it is. Otherwise what is not, with
   * a `dropped_event` loss span for the sequences missing (a conflict's span is the sink's).
   */
  readonly verify: Effect.Effect<RunRecordLoss | undefined>;
}

export interface RunRecordWriterOptions {
  readonly runId: string;
  readonly runtimeId: string;
  /** For tests; defaults to {@link RECORD_VERIFY_SCHEDULE}. */
  readonly verifySchedule?: Schedule.Schedule<unknown, unknown>;
}

const lengthOf = (range: SequenceRange) => Number(range.to - range.from + 1n);

/** What a check of the log found, when it is not "all there". */
type Unverified =
  | { readonly kind: "missing"; readonly ranges: readonly SequenceRange[] }
  | { readonly kind: "unread"; readonly reason: string };

export const makeRunRecordWriter = (
  sink: TelemetrySinkService,
  options: RunRecordWriterOptions,
): RunRecordWriter => {
  const { runId, runtimeId } = options;
  const schedule = options.verifySchedule ?? RECORD_VERIFY_SCHEDULE;
  /** Sequences the store refused, merged while they run on. */
  const unconfirmed: { from: bigint; to: bigint; tagged: boolean }[] = [];
  let refusal = "";
  const conflicts = { events: 0, from: 0n, to: 0n };

  const noteUnconfirmed = (batch: readonly NormalizedEvent[]) => {
    for (const event of batch) {
      const tagged = event.executionId !== undefined;
      const last = unconfirmed.at(-1);
      if (last !== undefined && last.tagged === tagged && event.sequence === last.to + 1n) {
        last.to = event.sequence;
      } else {
        unconfirmed.push({ from: event.sequence, to: event.sequence, tagged });
      }
    }
  };

  const noteConflicts = (sequences: readonly bigint[]) => {
    for (const sequence of sequences) {
      if (conflicts.events === 0 || sequence < conflicts.from) conflicts.from = sequence;
      if (conflicts.events === 0 || sequence > conflicts.to) conflicts.to = sequence;
      conflicts.events += 1;
    }
  };

  /** Succeeds when the log holds every range whole; fails with what it does not. */
  const check = (ranges: readonly SequenceRange[]): Effect.Effect<void, Unverified> =>
    sink.countStored({ runId, runtimeId, ranges }).pipe(
      Effect.mapError((error): Unverified => ({ kind: "unread", reason: reasonOf(error) })),
      Effect.flatMap((counts) => {
        const missing = ranges.filter((range, index) => (counts[index] ?? 0) < lengthOf(range));
        return missing.length === 0
          ? Effect.void
          : Effect.fail<Unverified>({ kind: "missing", ranges: missing });
      }),
    );

  return {
    append: (batch) =>
      batch.length === 0
        ? Effect.void
        : sink.appendBatch({ runId, runtimeId, batch }).pipe(
            Effect.flatMap((result) =>
              Effect.sync(() =>
                noteConflicts(result.conflicts.map((conflict) => conflict.sequence)),
              ),
            ),
            Effect.catch((error) =>
              Effect.gen(function* () {
                noteUnconfirmed(batch);
                refusal = reasonOf(error);
                yield* Effect.logWarning(
                  `telemetry: the store did not take ${String(batch.length)} event(s) of run ${runId}; they are checked when the process exits`,
                  refusal,
                );
              }),
            ),
          ),

    verify: Effect.gen(function* () {
      if (unconfirmed.length === 0 && conflicts.events === 0) return undefined;
      let missing: readonly SequenceRange[] = [];
      let reason = refusal;
      if (unconfirmed.length > 0) {
        const unverified = yield* check(unconfirmed).pipe(
          Effect.retry({ schedule }),
          Effect.flip,
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (unverified?.kind === "missing") {
          missing = unverified.ranges;
        } else if (unverified?.kind === "unread") {
          // The log could not be read: nothing the store refused is known to be there.
          missing = unconfirmed;
          reason = `${refusal}; the record could not be checked: ${unverified.reason}`;
        }
      }
      const missingEvents = missing.reduce((total, range) => total + lengthOf(range), 0);
      if (missingEvents === 0 && conflicts.events === 0) return undefined;

      const bounds: bigint[] = [];
      if (missingEvents > 0) {
        const from = missing[0]!.from;
        const to = missing.at(-1)!.to;
        bounds.push(from, to);
        yield* sink
          .insertLossSpan({
            runId,
            runtimeId,
            span: {
              kind: "dropped_event",
              fromSequence: from,
              toSequence: to,
              droppedCount: BigInt(missingEvents),
              reason: `the record store did not take these events: ${reason}`,
              detectedVia: "marker",
              atSequence: from,
              key: "unstored",
            },
          })
          .pipe(Effect.ignore);
      }
      if (conflicts.events > 0) bounds.push(conflicts.from, conflicts.to);
      const loss: RunRecordLoss = {
        events: missingEvents + conflicts.events,
        fromSequence: bounds.reduce((a, b) => (b < a ? b : a)),
        toSequence: bounds.reduce((a, b) => (b > a ? b : a)),
        reason: [
          ...(missingEvents > 0 ? [reason] : []),
          ...(conflicts.events > 0
            ? [
                `${String(conflicts.events)} conflict(s) with a different event already stored at the same id or position`,
              ]
            : []),
        ].join("; "),
      };
      yield* Effect.logError(
        `telemetry: ${String(loss.events)} event(s) of run ${runId} (sequences ${loss.fromSequence.toString()}–${loss.toSequence.toString()}) are not in its record`,
        loss.reason,
      );
      return loss;
    }),
  };
};
