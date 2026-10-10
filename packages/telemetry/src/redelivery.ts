/**
 * Re-delivery checks for `appendBatch`. The same event reaches the log more than once by design: a
 * run-exec job records its own run's events on its connection while the full-stream ingester
 * records every event of the runtime on another, and a retried batch re-sends what its first
 * attempt may already have committed. The log keeps the first copy. A re-delivered copy that is the
 * same event, in the right run, is nothing. One that differs, from the log or from another event
 * with its id in the same batch, is a conflict: the sink logs it and fails the append with it, so
 * no writer takes it as recorded.
 */
import type { TelemetryEvent } from "@sealant/db";

import { eventRowToNormalized } from "./normalize.js";
import type { NormalizedEvent } from "./types.js";

/** A JSON text with sorted keys, so two payloads compare by content, not key order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint"
      ? item.toString()
      : item !== null && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )
        : item,
  );

/**
 * Whether the stored row of `event` is in a run that holds it. An untagged daemon event (a
 * heartbeat) belongs to no run in particular: the two consumers attribute it to different ones,
 * and either is the event. An event tagged with an execution belongs to the run it names, or, when
 * the execution is no run, to the run both writers fell back to.
 */
const placedRightly = (stored: TelemetryEvent, event: NormalizedEvent, runId: string) =>
  event.executionId === undefined || stored.runId === event.executionId || stored.runId === runId;

/** The fields in which two events with one id differ. */
export const eventDifferences = (kept: NormalizedEvent, event: NormalizedEvent): string[] => {
  const fields = [
    ["runtimeId", kept.runtimeId, event.runtimeId],
    ["sequence", kept.sequence, event.sequence],
    ["executionId", kept.executionId, event.executionId],
    ["sessionId", kept.sessionId, event.sessionId],
    ["processId", kept.processId, event.processId],
    ["requestId", kept.requestId, event.requestId],
    ["schemaVersion", kept.schemaVersion, event.schemaVersion],
    ["observedAt", kept.observedAt, event.observedAt],
    ["monotonicTimestamp", kept.monotonicTimestamp, event.monotonicTimestamp],
    ["captureMethod", kept.captureMethod, event.captureMethod],
    ["confidence", kept.confidence, event.confidence],
    ["payloadCase", kept.payloadCase, event.payloadCase],
    ["payload", kept.payload, event.payload],
  ] as const;
  return fields.filter(([, a, b]) => canonical(a) !== canonical(b)).map(([name]) => name);
};

/**
 * The fields in which `event`, appended for `runId`, differs from the stored row with its id. When
 * it was ingested is not compared.
 */
export const redeliveryDifferences = (
  stored: TelemetryEvent,
  event: NormalizedEvent,
  runId: string,
): readonly string[] => {
  const differences = eventDifferences(eventRowToNormalized(stored), event);
  return placedRightly(stored, event, runId) ? differences : ["runId", ...differences];
};

/**
 * An event an append did not take because a different one holds its id or position: in the log,
 * or earlier in the same batch.
 */
export interface ConflictingRedelivery {
  readonly eventId: string;
  readonly against: "log" | "batch";
  /** The run the event was appended for. */
  readonly runId: string;
  readonly runtimeId: string;
  readonly sequence: bigint;
  /** The stored event at the same runtime and sequence, when it has another id. */
  readonly storedEventIdAtSequence: string | undefined;
  /** What differs from the stored event with the same id, when there is one. */
  readonly differences: readonly string[];
}

const positionKey = (runtimeId: string, sequence: bigint) => `${runtimeId}:${sequence.toString()}`;

/**
 * The events of `skipped` (those the insert did not take) that are not the same event as a stored
 * one, in a run that holds it. `stored` holds the rows with their ids or their positions; `runIdFor`
 * names the run each event was appended for.
 */
export const conflictingRedeliveries = (
  skipped: readonly NormalizedEvent[],
  stored: readonly TelemetryEvent[],
  runIdFor: (event: NormalizedEvent) => string,
): readonly ConflictingRedelivery[] => {
  const byId = new Map(stored.map((row) => [row.eventId, row]));
  const byPosition = new Map(stored.map((row) => [positionKey(row.runtimeId, row.sequence), row]));
  const conflicts: ConflictingRedelivery[] = [];
  for (const event of skipped) {
    const runId = runIdFor(event);
    const sameId = byId.get(event.eventId);
    const differences =
      sameId === undefined ? ["eventId"] : redeliveryDifferences(sameId, event, runId);
    if (differences.length === 0) continue;
    const atPosition = byPosition.get(positionKey(event.runtimeId, event.sequence));
    conflicts.push({
      eventId: event.eventId,
      against: "log",
      runId,
      runtimeId: event.runtimeId,
      sequence: event.sequence,
      storedEventIdAtSequence:
        atPosition === undefined || atPosition.eventId === event.eventId
          ? undefined
          : atPosition.eventId,
      differences,
    });
  }
  return conflicts;
};

/**
 * `batch` with each id once, and the later events with an id already in it that are not the same
 * event (a copy that is the same event is dropped). `runIdFor` names the run each is appended for.
 */
export const splitDuplicateIds = (
  batch: readonly NormalizedEvent[],
  runIdFor: (event: NormalizedEvent) => string,
): {
  readonly unique: readonly NormalizedEvent[];
  readonly conflicts: readonly ConflictingRedelivery[];
} => {
  const first = new Map<string, NormalizedEvent>();
  const conflicts: ConflictingRedelivery[] = [];
  for (const event of batch) {
    const earlier = first.get(event.eventId);
    if (earlier === undefined) {
      first.set(event.eventId, event);
      continue;
    }
    const differences = eventDifferences(earlier, event);
    if (runIdFor(earlier) !== runIdFor(event)) differences.unshift("runId");
    if (differences.length === 0) continue;
    conflicts.push({
      eventId: event.eventId,
      against: "batch",
      runId: runIdFor(event),
      runtimeId: event.runtimeId,
      sequence: event.sequence,
      storedEventIdAtSequence: undefined,
      differences,
    });
  }
  return { unique: [...first.values()], conflicts };
};

/** One line naming the conflicts (at most five), for an error and a run's message. */
export const describeConflicts = (conflicts: readonly ConflictingRedelivery[]): string => {
  const named = conflicts
    .slice(0, 5)
    .map((conflict) =>
      conflict.storedEventIdAtSequence !== undefined
        ? `${conflict.eventId} at the position of ${conflict.storedEventIdAtSequence}`
        : `${conflict.eventId} with other ${conflict.differences.join(", ")}${conflict.against === "batch" ? " in the same batch" : ""}`,
    );
  const more = conflicts.length > 5 ? `, and ${String(conflicts.length - 5)} more` : "";
  return `${String(conflicts.length)} event(s) differ from the ones the record holds (${named.join("; ")}${more}); the record keeps its own`;
};
