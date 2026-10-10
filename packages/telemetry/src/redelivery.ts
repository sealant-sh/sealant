/**
 * Re-delivery checks for `appendBatch`. The same event reaches the log more than once by design: a
 * run-exec job records its own run's events on its connection while the full-stream ingester
 * records every event of the runtime on another, and a retried batch re-sends what its first
 * attempt may already have committed. The log keeps the first copy. A re-delivered copy that is the
 * same event, in the right run, is nothing. One that differs is a conflict: the sink records it as
 * a loss span on the run it was for, and returns it, so a writer never takes it as stored.
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

/**
 * The fields in which `event`, appended for `runId`, differs from the stored row with its id. When
 * it was ingested is not compared.
 */
export const redeliveryDifferences = (
  stored: TelemetryEvent,
  event: NormalizedEvent,
  runId: string,
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
  const differences = fields
    .filter(([, a, b]) => canonical(a) !== canonical(b))
    .map(([name]) => name);
  return placedRightly(stored, event, runId) ? differences : ["runId", ...differences];
};

/** A re-delivered event the log did not take because a different one holds its id or position. */
export interface ConflictingRedelivery {
  readonly eventId: string;
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
