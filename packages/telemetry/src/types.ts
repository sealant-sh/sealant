/**
 * Pure type/shape definitions shared across the package. No Effect/IO imports beyond types.
 *
 * The `NormalizedEvent` is the in-memory, bigint-preserving shape produced by `normalizeEnvelope`
 * (and reconstructed from a stored row by `eventRowToNormalized`); both the ingest path and the
 * rebuild path derive projections from it, which is what guarantees `projection == rebuild`.
 */
import type { TelemetryEvent } from "@sealant/db";

/** The 12 EventEnvelope payload cases, plus `unknown` for an unmodeled/absent oneof. */
export const payloadCaseValues = [
  "runtimeStateChanged",
  "runtimeHeartbeat",
  "processStarted",
  "processExited",
  "ioChunk",
  "telemetryDropped",
  "fileChange",
  "fileWatchOverflow",
  "fileSnapshotCompleted",
  "fileDiffAvailable",
  "networkRequest",
  "networkSourceObserved",
  "unknown",
] as const;

export type PayloadCase = (typeof payloadCaseValues)[number];

/** The stored event row type (re-export of the drizzle row type for downstream ergonomics). */
export type TelemetryEventRow = TelemetryEvent;

/** Content bytes to offload to the {@link ArtifactStore} (only for an ioChunk carrying inline content). */
export interface NormalizedContent {
  readonly algo: string;
  readonly hash: string;
  readonly byteSize: bigint;
  readonly bytes: Uint8Array;
}

/** The scrollback-projection seed derived from an ioChunk (byte-exact reassembly metadata). */
export interface NormalizedScrollback {
  readonly processId: string | undefined;
  readonly sessionId: string | undefined;
  readonly stream: number;
  readonly streamOffset: bigint;
  readonly byteCount: bigint;
  /** Natural key into the content-addressed artifact store (undefined when content is absent). */
  readonly contentAlgo: string | undefined;
  readonly contentHash: string | undefined;
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly coalesced: boolean;
  readonly originalByteCount: bigint | undefined;
}

/**
 * The normalized, bigint-preserving event. `payload` is a jsonb-safe object (bigints stringified,
 * raw ioChunk content stripped) suitable for direct storage in `telemetry_events.payload`.
 */
export interface NormalizedEvent {
  readonly eventId: string;
  readonly runtimeId: string;
  readonly executionId: string | undefined;
  readonly sessionId: string | undefined;
  readonly processId: string | undefined;
  readonly requestId: string | undefined;
  readonly schemaVersion: number;
  readonly sequence: bigint;
  readonly observedAt: bigint;
  readonly monotonicTimestamp: bigint;
  readonly captureMethod: number;
  readonly confidence: number;
  readonly payloadCase: PayloadCase;
  readonly payload: Record<string, unknown>;
  readonly summary: string;
  readonly content: NormalizedContent | undefined;
  readonly scrollback: NormalizedScrollback | undefined;
}

/** A detected loss span (explicit daemon drop, inferred sequence gap, watch overflow, or early close). */
export interface LossSpanInput {
  readonly kind: "dropped_event" | "sequence_gap" | "watch_overflow" | "early_close";
  readonly fromSequence?: bigint;
  readonly toSequence?: bigint;
  readonly droppedCount?: bigint;
  readonly priority?: number;
  readonly reason?: string;
  readonly detectedVia: "marker" | "gap";
  /** The sequence of the triggering event (marker spans) — used to derive a stable, idempotent id. */
  readonly atSequence?: bigint;
}

/** Accumulator threaded through `Stream.mapAccum` for per-runtime sequence-gap detection. */
export interface GapDetectionState {
  readonly lastSequenceByRuntime: Map<string, bigint>;
}

// ---------------------------------------------------------------------------------------------
// Read-model shapes (the SDK-facing surface)
// ---------------------------------------------------------------------------------------------

/**
 * One ordered entry in a run's timeline (a real event, or an inline loss marker). Correlation +
 * provenance (`processId`, `captureMethod`, `confidence`) are joined from the log so consumers can
 * attribute activity to the process that produced it and state how each fact was captured.
 */
export interface TimelineEntry {
  readonly eventId: string;
  readonly sequence: bigint;
  readonly kind: string;
  readonly occurredAt: bigint;
  readonly summary: string;
  readonly ref: Record<string, unknown> | null;
  readonly processId: string | null;
  readonly captureMethod: number;
  readonly confidence: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly runtimeId: string;
  readonly status: string;
  readonly eventsPersisted: bigint;
  readonly firstSequence: bigint | null;
  readonly lastSequence: bigint | null;
}

export interface LossReport {
  readonly runId: string;
  readonly droppedEventCount: bigint;
  readonly sequenceGapCount: number;
  readonly watchOverflowCount: number;
  readonly earlyClose: boolean;
  readonly spans: ReadonlyArray<{
    readonly kind: string;
    readonly fromSequence: bigint | null;
    readonly toSequence: bigint | null;
    readonly droppedCount: bigint | null;
    readonly detectedVia: string;
    readonly reason: string | null;
  }>;
}

// ---------------------------------------------------------------------------------------------
// FUTURE read-model shapes — declared now so the SDK signatures are stable (see run-telemetry.ts).
// They are derived later as additional pure folds of the same log (no re-capture required).
// ---------------------------------------------------------------------------------------------
export interface RunRollup {
  readonly runId: string;
  readonly eventCount: bigint;
  readonly egressBytes: bigint;
  readonly fileChangeCount: bigint;
}
export interface FileTreeSnapshot {
  readonly atSequence: bigint;
  readonly entries: ReadonlyArray<{ readonly path: string; readonly size: bigint }>;
}
export interface ProcessTreeNode {
  readonly processId: string;
  readonly pid: number;
  readonly executable: string;
  readonly exitCode: number | null;
}
export interface ProcessTree {
  readonly atSequence: bigint;
  readonly nodes: ReadonlyArray<ProcessTreeNode>;
}
export interface NetConn {
  readonly host: string;
  readonly port: number;
}

/**
 * `JSON.stringify` replacer used before every jsonb write. `JSON.stringify` throws on a `bigint`, so
 * we stringify it; any stray `Uint8Array` is base64-encoded (event payloads carry no raw bytes after
 * ioChunk content is stripped, but this keeps the write total).
 */
export const bigintReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  return value;
};
