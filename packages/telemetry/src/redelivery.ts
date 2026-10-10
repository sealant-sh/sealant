/**
 * Re-delivery checks for `appendBatch`. The same event reaches the log more than once by design: a
 * run-exec job records its own run's events on its connection while the full-stream ingester
 * records every event of the runtime on another, and a retried batch re-sends what its first
 * attempt may already have committed. The log keeps the first copy. A re-delivered copy that is the
 * same event is nothing; one that differs is an integrity problem, reported, never a failed run.
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
        ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : item,
  );

/**
 * The fields in which `event` differs from the stored row with its id. The run it is stored under
 * is not compared: the two consumers attribute an untagged daemon event (a heartbeat) to different
 * runs, and either is the event. Nor is when it was ingested.
 */
export const redeliveryDifferences = (
  stored: TelemetryEvent,
  event: NormalizedEvent,
): readonly string[] => {
  const kept = eventRowToNormalized(stored);
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

/** A re-delivered event the log did not take because a different one holds its id or position. */
export interface ConflictingRedelivery {
  readonly eventId: string;
  readonly runtimeId: string;
  readonly sequence: string;
  /** The stored event at the same runtime and sequence, when it has another id. */
  readonly storedEventIdAtSequence: string | undefined;
  /** What differs from the stored event with the same id, when there is one. */
  readonly differences: readonly string[];
}

const positionKey = (runtimeId: string, sequence: bigint) => `${runtimeId}:${sequence.toString()}`;

/**
 * The events of `skipped` (those the insert did not take) that are not the same event as a stored
 * one. `stored` holds the rows with their ids or their positions.
 */
export const conflictingRedeliveries = (
  skipped: readonly NormalizedEvent[],
  stored: readonly TelemetryEvent[],
): readonly ConflictingRedelivery[] => {
  const byId = new Map(stored.map((row) => [row.eventId, row]));
  const byPosition = new Map(stored.map((row) => [positionKey(row.runtimeId, row.sequence), row]));
  const conflicts: ConflictingRedelivery[] = [];
  for (const event of skipped) {
    const sameId = byId.get(event.eventId);
    const differences = sameId === undefined ? ["eventId"] : redeliveryDifferences(sameId, event);
    if (differences.length === 0) continue;
    const atPosition = byPosition.get(positionKey(event.runtimeId, event.sequence));
    conflicts.push({
      eventId: event.eventId,
      runtimeId: event.runtimeId,
      sequence: event.sequence.toString(),
      storedEventIdAtSequence:
        atPosition === undefined || atPosition.eventId === event.eventId
          ? undefined
          : atPosition.eventId,
      differences,
    });
  }
  return conflicts;
};
