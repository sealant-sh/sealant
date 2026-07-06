/**
 * Record-event taxonomy — the TYPED payload schemas behind `TimelineEntry.kind`/`ref` and
 * `RunEvent.payloadCase`/`payload`.
 *
 * The execution record's event kinds come from the sealantd protocol (`@sealant/runtime-protocol`
 * `EventEnvelope.payload` oneof); ingest stores each payload as jsonb with the oneof case name as
 * the `kind`. These schemas describe that STORED/SERVED shape exactly:
 *
 *   - uint64/int64 protobuf fields are DECIMAL STRINGS (bigints are stringified at ingest so values
 *     past 2^53 survive jsonb);
 *   - protobuf enum fields are NUMBERS (`RuntimeState`, `ExitReason`, `StreamKind`, `FileChangeKind`,
 *     `FileType`, `NetworkScheme`, `EventPriority` — same convention as the envelope's
 *     `captureMethod`/`confidence`);
 *   - proto3 `optional` fields are absent when unset; implicit scalars are always present;
 *   - decode strips ingest artifacts (e.g. the protobuf `$typeName` marker).
 *
 * `decodeRecordEventPayload` folds a `(kind, ref)` pair into the discriminated union, degrading to
 * the `unknown` case (with the raw kind + payload preserved) for kinds this contract version does
 * not model or payloads that fail their schema — forward compatibility is a case, not an error.
 *
 * The kind list deliberately mirrors `payloadCaseValues` in `@sealant/telemetry` (guarded by a test
 * there); this contract does not depend on the telemetry package.
 */
import { Schema } from "effect";

/** Every event kind the platform records today, plus `unknown` for an unmodeled/absent oneof. */
export const recordEventKindValues = [
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

export const recordEventKindSchema = Schema.Literals(recordEventKindValues);
export type RecordEventKind = typeof recordEventKindSchema.Type;

/** Decimal-string int64/uint64 (bigints are stringified at ingest). */
const DecimalString = Schema.String;

// ---------------------------------------------------------------------------------------------
// Per-kind payload schemas (the jsonb `ref` / `payload` shape on the wire)
// ---------------------------------------------------------------------------------------------

/** `sealant.v1.RuntimeStateChanged` — `state` is a numeric `RuntimeState`. */
export const runtimeStateChangedEventSchema = Schema.Struct({
  state: Schema.Number,
  reason: Schema.optional(Schema.String),
});
export type RuntimeStateChangedEvent = typeof runtimeStateChangedEventSchema.Type;

/** `sealant.v1.RuntimeHeartbeat` — `state` is a numeric `RuntimeState`. */
export const runtimeHeartbeatEventSchema = Schema.Struct({
  state: Schema.Number,
});
export type RuntimeHeartbeatEvent = typeof runtimeHeartbeatEventSchema.Type;

/** `sealant.v1.ProcessStarted` — a supervised process began executing. */
export const processStartedEventSchema = Schema.Struct({
  pid: Schema.Number,
  pgid: Schema.Number,
  pidfd: Schema.Boolean,
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  /** Wall clock at start, microseconds (decimal-string int64). */
  startedAt: DecimalString,
});
export type ProcessStartedEvent = typeof processStartedEventSchema.Type;

/** `sealant.v1.ProcessExited` — `reason` is a numeric `ExitReason`. */
export const processExitedEventSchema = Schema.Struct({
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.Number),
  reason: Schema.Number,
  /** Wall-clock duration, microseconds (decimal-string uint64). */
  durationMicros: DecimalString,
});
export type ProcessExitedEvent = typeof processExitedEventSchema.Type;

/**
 * `sealant.v1.IoChunk`, as ingest stores it: raw bytes are offloaded to the artifact store and
 * replaced by a content hash; byte-exact text is served by the scrollback endpoint, not the record.
 * `stream` is a numeric `StreamKind` (stdout = 2, stderr = 3).
 */
export const ioChunkEventSchema = Schema.Struct({
  stream: Schema.Number,
  byteCount: DecimalString,
  streamOffset: DecimalString,
  contentAlgo: Schema.optional(Schema.String),
  contentHash: Schema.optional(Schema.String),
  transform: Schema.optional(
    Schema.Struct({
      redacted: Schema.Boolean,
      truncated: Schema.Boolean,
      coalesced: Schema.Boolean,
      originalByteCount: Schema.optional(DecimalString),
    }),
  ),
});
export type IoChunkEvent = typeof ioChunkEventSchema.Type;

/** `sealant.v1.TelemetryDropped` — `priority` is a numeric `EventPriority`. */
export const telemetryDroppedEventSchema = Schema.Struct({
  reason: Schema.String,
  count: DecimalString,
  priority: Schema.Number,
});
export type TelemetryDroppedEvent = typeof telemetryDroppedEventSchema.Type;

/** `sealant.v1.FileEntry` — `fileType` is a numeric `FileType`. */
export const fileEntrySchema = Schema.Struct({
  path: Schema.String,
  fileType: Schema.Number,
  size: DecimalString,
  mtimeMicros: DecimalString,
  mode: Schema.Number,
  hash: Schema.optional(Schema.String),
  symlinkTarget: Schema.optional(Schema.String),
});
export type FileEntryRef = typeof fileEntrySchema.Type;

/** `sealant.v1.FileChange` — `kind` is a numeric `FileChangeKind`. */
export const fileChangeEventSchema = Schema.Struct({
  kind: Schema.Number,
  path: Schema.String,
  renameFrom: Schema.optional(Schema.String),
  entry: Schema.optional(fileEntrySchema),
  certain: Schema.Boolean,
});
export type FileChangeEvent = typeof fileChangeEventSchema.Type;

/** `sealant.v1.FileWatchOverflow` — changes under `root` may have been missed. */
export const fileWatchOverflowEventSchema = Schema.Struct({
  root: Schema.String,
});
export type FileWatchOverflowEvent = typeof fileWatchOverflowEventSchema.Type;

/** `sealant.v1.FileSnapshotCompleted` */
export const fileSnapshotCompletedEventSchema = Schema.Struct({
  root: Schema.String,
  fileCount: DecimalString,
});
export type FileSnapshotCompletedEvent = typeof fileSnapshotCompletedEventSchema.Type;

/** `sealant.v1.FileDiffAvailable` — per-kind counts as decimal-string uint64. */
export const fileDiffAvailableEventSchema = Schema.Struct({
  added: DecimalString,
  modified: DecimalString,
  deleted: DecimalString,
  renamed: DecimalString,
});
export type FileDiffAvailableEvent = typeof fileDiffAvailableEventSchema.Type;

/** `sealant.v1.NetworkRequest` — `scheme` is a numeric `NetworkScheme`. */
export const networkRequestEventSchema = Schema.Struct({
  scheme: Schema.Number,
  method: Schema.optional(Schema.String),
  host: Schema.String,
  port: Schema.Number,
  path: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  bytesSent: DecimalString,
  bytesReceived: DecimalString,
  durationMicros: DecimalString,
});
export type NetworkRequestEvent = typeof networkRequestEventSchema.Type;

/** `sealant.v1.NetworkSourceObserved` — a network source the run touched (the "sources" trail). */
export const networkSourceObservedEventSchema = Schema.Struct({
  host: Schema.String,
  resolvedIps: Schema.Array(Schema.String),
  port: Schema.Number,
  scheme: Schema.optional(Schema.Number),
  method: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
});
export type NetworkSourceObservedEvent = typeof networkSourceObservedEventSchema.Type;

// ---------------------------------------------------------------------------------------------
// The discriminated payload union + decoder
// ---------------------------------------------------------------------------------------------

/**
 * A record-event payload discriminated by `kind`. The `unknown` case carries the raw kind and
 * payload verbatim — it is the forward-compatibility path for kinds newer than this contract AND
 * the honest path for payloads that fail their schema.
 */
export type RecordEventPayload =
  | { readonly kind: "runtimeStateChanged"; readonly data: RuntimeStateChangedEvent }
  | { readonly kind: "runtimeHeartbeat"; readonly data: RuntimeHeartbeatEvent }
  | { readonly kind: "processStarted"; readonly data: ProcessStartedEvent }
  | { readonly kind: "processExited"; readonly data: ProcessExitedEvent }
  | { readonly kind: "ioChunk"; readonly data: IoChunkEvent }
  | { readonly kind: "telemetryDropped"; readonly data: TelemetryDroppedEvent }
  | { readonly kind: "fileChange"; readonly data: FileChangeEvent }
  | { readonly kind: "fileWatchOverflow"; readonly data: FileWatchOverflowEvent }
  | { readonly kind: "fileSnapshotCompleted"; readonly data: FileSnapshotCompletedEvent }
  | { readonly kind: "fileDiffAvailable"; readonly data: FileDiffAvailableEvent }
  | { readonly kind: "networkRequest"; readonly data: NetworkRequestEvent }
  | { readonly kind: "networkSourceObserved"; readonly data: NetworkSourceObservedEvent }
  | { readonly kind: "unknown"; readonly rawKind: string; readonly data: unknown };

type UnknownEventPayload = Extract<RecordEventPayload, { kind: "unknown" }>;

/**
 * Wraps one kind's schema into a total decoder: a payload that fails its schema degrades to the
 * `unknown` case rather than throwing. The generic RETURN type (not a constrained construction)
 * keeps kind/data correlated without casts.
 */
const eventCase = <const K extends RecordEventKind, T>(
  kind: K,
  schema: Schema.Codec<T, unknown>,
) => {
  const decode = Schema.decodeUnknownSync(schema);
  return (ref: unknown): { readonly kind: K; readonly data: T } | UnknownEventPayload => {
    try {
      return { kind, data: decode(ref) };
    } catch {
      return { kind: "unknown", rawKind: kind, data: ref };
    }
  };
};

const decoders: Record<string, (ref: unknown) => RecordEventPayload> = {
  runtimeStateChanged: eventCase("runtimeStateChanged", runtimeStateChangedEventSchema),
  runtimeHeartbeat: eventCase("runtimeHeartbeat", runtimeHeartbeatEventSchema),
  processStarted: eventCase("processStarted", processStartedEventSchema),
  processExited: eventCase("processExited", processExitedEventSchema),
  ioChunk: eventCase("ioChunk", ioChunkEventSchema),
  telemetryDropped: eventCase("telemetryDropped", telemetryDroppedEventSchema),
  fileChange: eventCase("fileChange", fileChangeEventSchema),
  fileWatchOverflow: eventCase("fileWatchOverflow", fileWatchOverflowEventSchema),
  fileSnapshotCompleted: eventCase("fileSnapshotCompleted", fileSnapshotCompletedEventSchema),
  fileDiffAvailable: eventCase("fileDiffAvailable", fileDiffAvailableEventSchema),
  networkRequest: eventCase("networkRequest", networkRequestEventSchema),
  networkSourceObserved: eventCase("networkSourceObserved", networkSourceObservedEventSchema),
};

/**
 * Folds a wire `(kind, ref)` pair — `TimelineEntry.kind`/`ref` or `RunEvent.payloadCase`/`payload` —
 * into the discriminated {@link RecordEventPayload}. NEVER throws: unmodeled kinds and non-conforming
 * payloads come back as the `unknown` case with the raw data preserved.
 */
export const decodeRecordEventPayload = (kind: string, ref: unknown): RecordEventPayload => {
  const decoder = decoders[kind];
  return decoder === undefined ? { kind: "unknown", rawKind: kind, data: ref } : decoder(ref);
};
