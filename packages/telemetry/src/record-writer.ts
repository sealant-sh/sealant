/**
 * How a run-exec job writes its run's record. The record holds the run's output (its io chunks are
 * the only copy), so a batch the store did not take is not dropped and is not a reason to stop
 * watching the process: it is retried (appends are idempotent), then held back while the process
 * runs, then appended once more when the process has exited. Only what is still not stored by then
 * is lost, and the caller fails the run with that, after recording the process's exit and the
 * run's changes. A batch another consumer already stored (the full-stream ingester) is stored.
 */
import { Effect, Schedule } from "effect";

import type { TelemetrySinkService } from "./sink.js";
import type { NormalizedEvent } from "./types.js";

/** The appends a batch gets before it is held back: about three seconds. */
export const RECORD_APPEND_RETRY = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.recurs(5)),
);
/** Held-back events beyond this are lost at once, so a long store outage cannot exhaust memory. */
const MAX_HELD_EVENTS = 16_384;
const MAX_HELD_CONTENT_BYTES = 64 * 1024 * 1024;
const FLUSH_BATCH_SIZE = 256;

/** The events of a run's record the store did not take. */
export interface RunRecordLoss {
  readonly events: number;
  readonly fromSequence: bigint;
  readonly toSequence: bigint;
  /** The store's last refusal. */
  readonly reason: string;
}

export interface RunRecordWriter {
  /** Append one batch. Never fails: a batch the store does not take is held back. */
  readonly append: (batch: readonly NormalizedEvent[]) => Effect.Effect<void>;
  /**
   * Append what was held back; what is still not stored is lost, recorded as a `dropped_event`
   * loss span when the store takes that. `undefined` when the record is whole.
   */
  readonly flush: Effect.Effect<RunRecordLoss | undefined>;
}

export interface RunRecordWriterOptions {
  readonly runId: string;
  readonly runtimeId: string;
  /** For tests; defaults to {@link RECORD_APPEND_RETRY}. */
  readonly retry?: Schedule.Schedule<unknown, unknown>;
}

/**
 * The innermost cause's words (the database's, not the failed query with its parameters), short
 * enough for a run's error message.
 */
const reasonOf = (error: unknown): string => {
  let innermost = error;
  for (
    let depth = 0;
    depth < 8 && innermost instanceof Error && innermost.cause instanceof Error;
    depth += 1
  ) {
    innermost = innermost.cause;
  }
  const words = innermost instanceof Error ? innermost.message : String(innermost);
  return words.length > 300 ? `${words.slice(0, 299)}…` : words;
};

export const makeRunRecordWriter = (
  sink: TelemetrySinkService,
  options: RunRecordWriterOptions,
): RunRecordWriter => {
  const { runId, runtimeId } = options;
  const retry = options.retry ?? RECORD_APPEND_RETRY;
  const held: NormalizedEvent[] = [];
  let heldBytes = 0;
  const lost = { events: 0, from: 0n, to: 0n, reason: "" };

  const lose = (events: readonly NormalizedEvent[], reason: string) => {
    for (const event of events) {
      if (lost.events === 0 || event.sequence < lost.from) lost.from = event.sequence;
      if (lost.events === 0 || event.sequence > lost.to) lost.to = event.sequence;
      lost.events += 1;
    }
    lost.reason = reason;
  };

  const store = (batch: readonly NormalizedEvent[]) =>
    sink.appendBatch({ runId, runtimeId, batch }).pipe(Effect.retry(retry), Effect.asVoid);

  const holdBack = (batch: readonly NormalizedEvent[], reason: string) =>
    Effect.gen(function* () {
      for (const event of batch) {
        const size = event.content?.bytes.byteLength ?? 0;
        if (held.length >= MAX_HELD_EVENTS || heldBytes + size > MAX_HELD_CONTENT_BYTES) {
          lose([event], reason);
        } else {
          held.push(event);
          heldBytes += size;
        }
      }
      yield* Effect.logWarning(
        `telemetry: the store did not take ${String(batch.length)} event(s) of run ${runId}; held back to try again when the process exits`,
        reason,
      );
    });

  return {
    append: (batch) =>
      batch.length === 0
        ? Effect.void
        : store(batch).pipe(Effect.catch((error) => holdBack(batch, reasonOf(error)))),

    flush: Effect.gen(function* () {
      const pending = held.splice(0, held.length);
      heldBytes = 0;
      for (let start = 0; start < pending.length; start += FLUSH_BATCH_SIZE) {
        const batch = pending.slice(start, start + FLUSH_BATCH_SIZE);
        yield* store(batch).pipe(
          Effect.catch((error) => Effect.sync(() => lose(batch, reasonOf(error)))),
        );
      }
      if (lost.events === 0) return undefined;
      const loss: RunRecordLoss = {
        events: lost.events,
        fromSequence: lost.from,
        toSequence: lost.to,
        reason: lost.reason,
      };
      yield* sink
        .insertLossSpan({
          runId,
          runtimeId,
          span: {
            kind: "dropped_event",
            fromSequence: loss.fromSequence,
            toSequence: loss.toSequence,
            droppedCount: BigInt(loss.events),
            reason: `the record store did not take these events: ${loss.reason}`,
            detectedVia: "marker",
            atSequence: loss.fromSequence,
          },
        })
        .pipe(Effect.ignore);
      yield* Effect.logError(
        `telemetry: ${String(loss.events)} event(s) of run ${runId} (sequences ${loss.fromSequence.toString()}–${loss.toSequence.toString()}) were not stored`,
        loss.reason,
      );
      return loss;
    }),
  };
};
