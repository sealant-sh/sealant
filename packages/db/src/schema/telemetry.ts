/**
 * Telemetry schema — the append-only, event-sourced system of record for sealantd `EventEnvelope`
 * telemetry, plus its content-addressed blob store and the disposable read-model projections.
 *
 * Design invariants (see @sealant/telemetry):
 *   - `telemetry_events` is APPEND-ONLY and is the source of truth. It retains the full envelope
 *     (all 12 metadata fields + the discriminated payload as jsonb) so any state at any
 *     `(runId, sequence)` coordinate is a pure re-fold of the log — never foreclosing byte-exact
 *     time-travel / replay.
 *   - Ordering + dedup key is `(runtime_id, sequence)` (sequence is a per-runtime monotonic uint64);
 *     `event_id` is the absolute global dedup guard (the PK).
 *   - Every uint64/int64 wire field is stored as `bigint({ mode: "bigint" })` — never a JS `number`
 *     (which would silently narrow values past 2^53).
 *   - The projection tables (`telemetry_scrollback`, `telemetry_timeline`) and `telemetry_loss_spans`
 *     are rebuildable from the log; only they are mutable.
 */
import {
  bigint,
  boolean,
  bytea,
  index,
  integer,
  jsonb,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { issueWorkflowExecutionArtifactStorageBackendValues, runs } from "./control-plane.js";

// Client-level `casing: "snake_case"` no longer exists, so re-apply snake_case at the table level
// to keep implicit column names mapping to snake_case db columns (matches control-plane.ts).
const pgTable = snakeCase.table;

export const telemetryRunEpochStatusValues = ["open", "closed", "lost"] as const;
export type TelemetryRunEpochStatus = (typeof telemetryRunEpochStatusValues)[number];

export const telemetryEpochCloseReasonValues = [
  "stream-end",
  "transport-close",
  "shutdown",
] as const;
export type TelemetryEpochCloseReason = (typeof telemetryEpochCloseReasonValues)[number];

export const telemetryLossSpanKindValues = [
  "dropped_event",
  "sequence_gap",
  "watch_overflow",
  "early_close",
] as const;
export type TelemetryLossSpanKind = (typeof telemetryLossSpanKindValues)[number];

export const telemetryLossSpanDetectedViaValues = ["marker", "gap"] as const;
export type TelemetryLossSpanDetectedVia = (typeof telemetryLossSpanDetectedViaValues)[number];

// Reuse the verified storage-backend enum so artifact bodies can later move to s3/filesystem
// without introducing a new enum type.
export const telemetryArtifactStorageBackendValues =
  issueWorkflowExecutionArtifactStorageBackendValues;

// ---------------------------------------------------------------------------------------------
// THE LOG — append-only system of record. One row per EventEnvelope.
// ---------------------------------------------------------------------------------------------
export const telemetryEvents = pgTable(
  "telemetry_events",
  {
    eventId: text("event_id").primaryKey(), // envelope.eventId (f2) — absolute global dedup
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    runtimeId: text("runtime_id").notNull(), // f3 — persisted for the first time
    executionId: text("execution_id"), // f4 — persisted for the first time
    sessionId: text("session_id"), // f5
    processId: text("process_id"), // f6
    requestId: text("request_id"), // f7
    schemaVersion: integer("schema_version").notNull(), // f1 (uint32 -> number)
    sequence: bigint("sequence", { mode: "bigint" }).notNull(), // f8 per-runtime monotonic
    observedAt: bigint("observed_at", { mode: "bigint" }).notNull(), // f9 int64 wall-clock (display)
    monotonicTimestamp: bigint("monotonic_timestamp", { mode: "bigint" }).notNull(), // f10 ordering
    captureMethod: integer("capture_method").notNull(), // f11 numeric enum (0=UNSPECIFIED preserved)
    confidence: integer("confidence").notNull(), // f12 numeric enum
    payloadCase: text("payload_case").notNull(), // 'ioChunk' | ... | 'unknown'
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(), // jsonb-safe value (bigints stringified)
    ingestedAt: timestamp("ingested_at", { mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("telemetry_events_runtime_sequence_idx").on(table.runtimeId, table.sequence),
    index("telemetry_events_run_sequence_idx").on(table.runId, table.sequence),
    index("telemetry_events_run_process_sequence_idx").on(
      table.runId,
      table.processId,
      table.sequence,
    ),
    index("telemetry_events_run_case_sequence_idx").on(
      table.runId,
      table.payloadCase,
      table.sequence,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// PER-RUN DAEMON EPOCH — closes the runtimeId<->runId correlation gap + loss/watermark bookkeeping.
// A daemon restart (new runtimeId, sequence reset) opens a NEW epoch row — a hard discontinuity.
// ---------------------------------------------------------------------------------------------
export const telemetryRunEpochs = pgTable(
  "telemetry_run_epochs",
  {
    id: text("id").primaryKey(), // 'tep_<runId>_<rtShort>'
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    runtimeId: text("runtime_id").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    status: text("status", { enum: telemetryRunEpochStatusValues }).notNull().default("open"),
    firstSequence: bigint("first_sequence", { mode: "bigint" }),
    lastSequence: bigint("last_sequence", { mode: "bigint" }),
    eventsPersisted: bigint("events_persisted", { mode: "bigint" }).notNull().default(0n),
    closeReason: text("close_reason", { enum: telemetryEpochCloseReasonValues }),
    openedAt: timestamp("opened_at", { mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    closedAt: timestamp("closed_at", { mode: "date", withTimezone: true }),
  },
  (table) => [uniqueIndex("telemetry_run_epochs_run_runtime_idx").on(table.runId, table.runtimeId)],
);

// ---------------------------------------------------------------------------------------------
// CONTENT-ADDRESSED ARTIFACTS — ioChunk content bytes + daemon ArtifactRef bodies, stored once.
// ---------------------------------------------------------------------------------------------
export const telemetryArtifacts = pgTable(
  "telemetry_artifacts",
  {
    id: text("id").primaryKey(), // 'tart_<...>'
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    algo: text("algo").notNull(), // 'sha256' (ours) or ArtifactRef.algo
    hash: text("hash").notNull(),
    byteSize: bigint("byte_size", { mode: "bigint" }).notNull(), // == IoChunk.byteCount / ArtifactRef.bytes
    storageBackend: text("storage_backend", { enum: telemetryArtifactStorageBackendValues })
      .notNull()
      .default("inline"),
    storageKey: text("storage_key"), // s3/filesystem key (later backends)
    inlineBytes: bytea("inline_bytes"), // MVP: inline body (under cap)
  },
  (table) => [
    uniqueIndex("telemetry_artifacts_run_algo_hash_idx").on(table.runId, table.algo, table.hash),
  ],
);

// ---------------------------------------------------------------------------------------------
// PROJECTION — byte-exact scrollback reassembly key (rebuildable from the log).
// ---------------------------------------------------------------------------------------------
export const telemetryScrollback = pgTable(
  "telemetry_scrollback",
  {
    eventId: text("event_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    processId: text("process_id"),
    sessionId: text("session_id"),
    stream: integer("stream").notNull(), // StreamKind numeric
    streamOffset: bigint("stream_offset", { mode: "bigint" }).notNull(),
    byteCount: bigint("byte_count", { mode: "bigint" }).notNull(),
    contentAlgo: text("content_algo"), // -> telemetry_artifacts natural key (nullable when absent)
    contentHash: text("content_hash"),
    redacted: boolean("redacted").notNull().default(false),
    truncated: boolean("truncated").notNull().default(false),
    coalesced: boolean("coalesced").notNull().default(false),
    originalByteCount: bigint("original_byte_count", { mode: "bigint" }),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
  },
  (table) => [
    uniqueIndex("telemetry_scrollback_run_proc_stream_offset_idx").on(
      table.runId,
      table.processId,
      table.stream,
      table.streamOffset,
    ),
    index("telemetry_scrollback_run_sequence_idx").on(table.runId, table.sequence),
  ],
);

// ---------------------------------------------------------------------------------------------
// PROJECTION — per-run timeline ("what happened"), rebuildable from the log.
// ---------------------------------------------------------------------------------------------
export const telemetryTimeline = pgTable(
  "telemetry_timeline",
  {
    eventId: text("event_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    kind: text("kind").notNull(), // == payloadCase
    occurredAt: bigint("occurred_at", { mode: "bigint" }).notNull(), // monotonicTimestamp
    summary: text("summary").notNull(),
    refJson: jsonb("ref_json").$type<Record<string, unknown>>(),
  },
  (table) => [uniqueIndex("telemetry_timeline_run_sequence_idx").on(table.runId, table.sequence)],
);

// ---------------------------------------------------------------------------------------------
// LOSS SPANS — first-class loss accounting (explicit drops + inferred sequence gaps + early close).
// ---------------------------------------------------------------------------------------------
export const telemetryLossSpans = pgTable(
  "telemetry_loss_spans",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    runtimeId: text("runtime_id").notNull(),
    kind: text("kind", { enum: telemetryLossSpanKindValues }).notNull(),
    fromSequence: bigint("from_sequence", { mode: "bigint" }),
    toSequence: bigint("to_sequence", { mode: "bigint" }),
    droppedCount: bigint("dropped_count", { mode: "bigint" }),
    priority: integer("priority"), // EventPriority numeric
    reason: text("reason"),
    detectedVia: text("detected_via", { enum: telemetryLossSpanDetectedViaValues }).notNull(),
    detectedAt: timestamp("detected_at", { mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("telemetry_loss_spans_run_idx").on(table.runId)],
);

export type TelemetryEvent = typeof telemetryEvents.$inferSelect;
export type NewTelemetryEvent = typeof telemetryEvents.$inferInsert;
export type TelemetryRunEpoch = typeof telemetryRunEpochs.$inferSelect;
export type NewTelemetryRunEpoch = typeof telemetryRunEpochs.$inferInsert;
export type TelemetryArtifact = typeof telemetryArtifacts.$inferSelect;
export type NewTelemetryArtifact = typeof telemetryArtifacts.$inferInsert;
export type TelemetryScrollbackRow = typeof telemetryScrollback.$inferSelect;
export type NewTelemetryScrollbackRow = typeof telemetryScrollback.$inferInsert;
export type TelemetryTimelineRow = typeof telemetryTimeline.$inferSelect;
export type NewTelemetryTimelineRow = typeof telemetryTimeline.$inferInsert;
export type TelemetryLossSpan = typeof telemetryLossSpans.$inferSelect;
export type NewTelemetryLossSpan = typeof telemetryLossSpans.$inferInsert;
