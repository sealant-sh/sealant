import { createHash } from "node:crypto";

/**
 * Pure normalization + projection folds — NO Effect, fully unit-testable, separated from I/O
 * (mirrors the pure/IO split in packages/workspaces/src/sealantd/target.ts).
 *
 * `normalizeEnvelope` (ingest) and `eventRowToNormalized` (rebuild) both produce a `NormalizedEvent`,
 * and the projection derivations (`deriveTimelineRow` / `deriveScrollbackRow`) read ONLY from that
 * shape — so a projection built at ingest is byte-identical to one rebuilt from the log.
 */
import type {
  NewTelemetryEvent,
  NewTelemetryScrollbackRow,
  NewTelemetryTimelineRow,
  TelemetryEvent,
} from "@sealant/db";
import { StreamKind } from "@sealant/runtime-client";
import type { EventEnvelope } from "@sealant/runtime-protocol";

import {
  bigintReplacer,
  type GapDetectionState,
  type LossSpanInput,
  type NormalizedEvent,
  type NormalizedScrollback,
  type PayloadCase,
} from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && value.length > 0) return BigInt(value);
  if (typeof value === "number") return BigInt(value);
  return 0n;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);

/** Deep-clone a protobuf message value into a jsonb-safe object (bigints -> strings). */
const toJsonSafe = (value: unknown): Record<string, unknown> => {
  const cloned: unknown = JSON.parse(JSON.stringify(value ?? {}, bigintReplacer));
  return isRecord(cloned) ? cloned : {};
};

const streamLabel = (stream: number): string => {
  switch (stream) {
    case StreamKind.STDOUT:
      return "stdout";
    case StreamKind.STDERR:
      return "stderr";
    case StreamKind.STDIN:
      return "stdin";
    case StreamKind.PTY_OUTPUT:
      return "pty-out";
    case StreamKind.PTY_INPUT:
      return "pty-in";
    default:
      return `stream:${stream}`;
  }
};

/** Human-readable one-line summary, computed ONLY from the stored jsonb payload (ingest == rebuild). */
export const summarize = (payloadCase: PayloadCase, payload: Record<string, unknown>): string => {
  switch (payloadCase) {
    case "ioChunk":
      return `${streamLabel(asNumber(payload.stream))} ${String(payload.byteCount ?? "0")}B @${String(payload.streamOffset ?? "0")}`;
    case "processStarted": {
      const args = Array.isArray(payload.args) ? payload.args.join(" ") : "";
      return `exec ${String(payload.executable ?? "?")}${args.length > 0 ? ` ${args}` : ""}`;
    }
    case "processExited":
      return `exit code=${payload.exitCode === undefined ? "?" : String(payload.exitCode)}${payload.signal === undefined ? "" : ` signal=${String(payload.signal)}`} reason=${String(payload.reason ?? 0)}`;
    case "networkRequest":
      return `${String(payload.method ?? "?")} ${String(payload.host ?? "?")}:${String(payload.port ?? 0)}${String(payload.path ?? "")}${payload.status === undefined ? "" : ` -> ${String(payload.status)}`}`;
    case "networkSourceObserved":
      return `observed ${String(payload.host ?? "?")}:${String(payload.port ?? 0)}`;
    case "fileChange":
      return `file kind=${String(payload.kind ?? 0)} ${String(payload.path ?? "")}`;
    case "fileDiffAvailable":
      return `diff +${String(payload.added ?? 0)} ~${String(payload.modified ?? 0)} -${String(payload.deleted ?? 0)}`;
    case "fileSnapshotCompleted":
      return `snapshot ${String(payload.root ?? "")} (${String(payload.fileCount ?? 0)} files)`;
    case "fileWatchOverflow":
      return `watch overflow ${String(payload.root ?? "")}`;
    case "runtimeStateChanged":
      return `runtime state=${String(payload.state ?? 0)}${payload.reason === undefined ? "" : ` (${String(payload.reason)})`}`;
    case "runtimeHeartbeat":
      return `heartbeat state=${String(payload.state ?? 0)}`;
    case "telemetryDropped":
      return `dropped ${String(payload.count ?? 0)} (${String(payload.reason ?? "")})`;
    default:
      return "unknown event";
  }
};

/** Derive the scrollback projection seed from the (processId/sessionId + jsonb payload). */
export const deriveScrollback = (
  processId: string | undefined,
  sessionId: string | undefined,
  payloadCase: PayloadCase,
  payload: Record<string, unknown>,
): NormalizedScrollback | undefined => {
  if (payloadCase !== "ioChunk") {
    return undefined;
  }
  const transform = isRecord(payload.transform) ? payload.transform : undefined;
  return {
    processId,
    sessionId,
    stream: asNumber(payload.stream),
    streamOffset: asBigInt(payload.streamOffset),
    byteCount: asBigInt(payload.byteCount),
    contentAlgo: asString(payload.contentAlgo),
    contentHash: asString(payload.contentHash),
    redacted: transform?.redacted === true,
    truncated: transform?.truncated === true,
    coalesced: transform?.coalesced === true,
    originalByteCount:
      transform?.originalByteCount === undefined
        ? undefined
        : asBigInt(transform.originalByteCount),
  };
};

/** Build the jsonb-safe `telemetry_events.payload` value for one envelope. */
const buildPayload = (env: EventEnvelope): Record<string, unknown> => {
  const p = env.payload;
  if (p.case === "ioChunk") {
    const io = p.value;
    const transform = io.transform;
    let contentAlgo: string | undefined;
    let contentHash: string | undefined;
    if (io.content !== undefined) {
      contentAlgo = "sha256";
      contentHash = createHash("sha256").update(io.content).digest("hex");
    } else if (io.artifact !== undefined) {
      contentAlgo = io.artifact.algo;
      contentHash = io.artifact.hash;
    }
    return {
      stream: io.stream,
      byteCount: io.byteCount.toString(),
      streamOffset: io.streamOffset.toString(),
      ...(contentAlgo === undefined ? {} : { contentAlgo }),
      ...(contentHash === undefined ? {} : { contentHash }),
      ...(transform === undefined
        ? {}
        : {
            transform: {
              redacted: transform.redacted,
              truncated: transform.truncated,
              coalesced: transform.coalesced,
              ...(transform.originalByteCount === undefined
                ? {}
                : { originalByteCount: transform.originalByteCount.toString() }),
            },
          }),
    };
  }
  return p.case === undefined ? {} : toJsonSafe(p.value);
};

/** Normalize a live EventEnvelope (ingest path). Splits ioChunk content out for offload. */
export const normalizeEnvelope = (env: EventEnvelope): NormalizedEvent => {
  const payloadCase: PayloadCase = env.payload.case === undefined ? "unknown" : env.payload.case;
  const payload = buildPayload(env);
  const summary = summarize(payloadCase, payload);
  const scrollback = deriveScrollback(env.processId, env.sessionId, payloadCase, payload);

  let content = undefined as NormalizedEvent["content"];
  if (env.payload.case === "ioChunk" && env.payload.value.content !== undefined) {
    const bytes = env.payload.value.content;
    content = {
      algo: "sha256",
      hash: createHash("sha256").update(bytes).digest("hex"),
      byteSize: env.payload.value.byteCount,
      bytes,
    };
  }

  return {
    eventId: env.eventId,
    runtimeId: env.runtimeId,
    executionId: env.executionId,
    sessionId: env.sessionId,
    processId: env.processId,
    requestId: env.requestId,
    schemaVersion: env.schemaVersion,
    sequence: env.sequence,
    observedAt: env.observedAt,
    monotonicTimestamp: env.monotonicTimestamp,
    captureMethod: env.captureMethod,
    confidence: env.confidence,
    payloadCase,
    payload,
    summary,
    content,
    scrollback,
  };
};

/** Reconstruct a NormalizedEvent from a stored log row (rebuild path; no content bytes needed). */
export const eventRowToNormalized = (row: TelemetryEvent): NormalizedEvent => {
  const payloadCase: PayloadCase = payloadCaseGuard(row.payloadCase) ? row.payloadCase : "unknown";
  const payload = row.payload;
  return {
    eventId: row.eventId,
    runtimeId: row.runtimeId,
    executionId: row.executionId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    processId: row.processId ?? undefined,
    requestId: row.requestId ?? undefined,
    schemaVersion: row.schemaVersion,
    sequence: row.sequence,
    observedAt: row.observedAt,
    monotonicTimestamp: row.monotonicTimestamp,
    captureMethod: row.captureMethod,
    confidence: row.confidence,
    payloadCase,
    payload,
    summary: summarize(payloadCase, payload),
    content: undefined,
    scrollback: deriveScrollback(
      row.processId ?? undefined,
      row.sessionId ?? undefined,
      payloadCase,
      payload,
    ),
  };
};

const payloadCaseGuard = (value: string): value is PayloadCase =>
  value === "runtimeStateChanged" ||
  value === "runtimeHeartbeat" ||
  value === "processStarted" ||
  value === "processExited" ||
  value === "ioChunk" ||
  value === "telemetryDropped" ||
  value === "fileChange" ||
  value === "fileWatchOverflow" ||
  value === "fileSnapshotCompleted" ||
  value === "fileDiffAvailable" ||
  value === "networkRequest" ||
  value === "networkSourceObserved" ||
  value === "unknown";

/** The append-only log row for one normalized event. */
export const eventRow = (event: NormalizedEvent, runId: string): NewTelemetryEvent => ({
  eventId: event.eventId,
  runId,
  runtimeId: event.runtimeId,
  executionId: event.executionId ?? null,
  sessionId: event.sessionId ?? null,
  processId: event.processId ?? null,
  requestId: event.requestId ?? null,
  schemaVersion: event.schemaVersion,
  sequence: event.sequence,
  observedAt: event.observedAt,
  monotonicTimestamp: event.monotonicTimestamp,
  captureMethod: event.captureMethod,
  confidence: event.confidence,
  payloadCase: event.payloadCase,
  payload: event.payload,
});

export const deriveTimelineRow = (
  event: NormalizedEvent,
  runId: string,
): NewTelemetryTimelineRow => ({
  eventId: event.eventId,
  runId,
  sequence: event.sequence,
  kind: event.payloadCase,
  occurredAt: event.monotonicTimestamp,
  summary: event.summary,
  refJson: event.payload,
});

export const deriveScrollbackRow = (
  event: NormalizedEvent,
  runId: string,
): NewTelemetryScrollbackRow | undefined => {
  const s = event.scrollback;
  if (s === undefined) {
    return undefined;
  }
  return {
    eventId: event.eventId,
    runId,
    processId: s.processId ?? null,
    sessionId: s.sessionId ?? null,
    stream: s.stream,
    streamOffset: s.streamOffset,
    byteCount: s.byteCount,
    contentAlgo: s.contentAlgo ?? null,
    contentHash: s.contentHash ?? null,
    redacted: s.redacted,
    truncated: s.truncated,
    coalesced: s.coalesced,
    originalByteCount: s.originalByteCount ?? null,
    sequence: event.sequence,
  };
};

/** Per-runtime sequence-gap + explicit-drop detection. Mutates+returns the threaded accumulator. */
export const detectGap = (
  state: GapDetectionState,
  env: EventEnvelope,
): { readonly nextState: GapDetectionState; readonly lossSpan: LossSpanInput | undefined } => {
  const prev = state.lastSequenceByRuntime.get(env.runtimeId);
  let lossSpan: LossSpanInput | undefined;

  if (env.payload.case === "telemetryDropped") {
    const dropped = env.payload.value;
    lossSpan = {
      kind: "dropped_event",
      droppedCount: dropped.count,
      priority: dropped.priority,
      reason: dropped.reason,
      detectedVia: "marker",
      atSequence: env.sequence,
    };
  } else if (env.payload.case === "fileWatchOverflow") {
    lossSpan = {
      kind: "watch_overflow",
      reason: env.payload.value.root,
      detectedVia: "marker",
      atSequence: env.sequence,
    };
  } else if (prev !== undefined && env.sequence > prev + 1n) {
    lossSpan = {
      kind: "sequence_gap",
      fromSequence: prev + 1n,
      toSequence: env.sequence - 1n,
      droppedCount: env.sequence - prev - 1n,
      detectedVia: "gap",
    };
  }

  if (prev === undefined || env.sequence > prev) {
    state.lastSequenceByRuntime.set(env.runtimeId, env.sequence);
  }

  return { nextState: state, lossSpan };
};

/** Reassemble ordered byte runs by `streamOffset` (NOT arrival order); reports explicit gaps. */
export const reassembleByStreamOffset = (
  chunks: ReadonlyArray<{ readonly streamOffset: bigint; readonly bytes: Uint8Array }>,
): {
  readonly bytes: Uint8Array;
  readonly gaps: ReadonlyArray<{ readonly from: bigint; readonly to: bigint }>;
} => {
  const sorted = chunks.toSorted((a, b) =>
    a.streamOffset < b.streamOffset ? -1 : a.streamOffset > b.streamOffset ? 1 : 0,
  );
  const parts: Buffer[] = [];
  const gaps: Array<{ from: bigint; to: bigint }> = [];
  let expected = sorted.length > 0 ? sorted[0]!.streamOffset : 0n;
  for (const chunk of sorted) {
    if (chunk.streamOffset > expected) {
      gaps.push({ from: expected, to: chunk.streamOffset });
    }
    parts.push(Buffer.from(chunk.bytes));
    expected = chunk.streamOffset + BigInt(chunk.bytes.length);
  }
  return { bytes: new Uint8Array(Buffer.concat(parts)), gaps };
};
