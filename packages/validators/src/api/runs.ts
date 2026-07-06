import { z } from "zod";

/**
 * Run + execution-record schemas — the web app's view of the core API run wire contract
 * (packages/api-contracts/src/core-api/runs.ts). uint64 sequences and timestamps stay decimal
 * strings end-to-end; the UI converts to bigint only where it must compare or sort.
 */

export const runStatusValues = ["queued", "running", "completed", "failed", "cancelled"] as const;
export const runStatusSchema = z.enum(runStatusValues);

export const runModeSchema = z.enum(["one-shot", "interactive"]);

export const runIdParamsSchema = z.object({
  runId: z.string().trim().min(1),
});

export const runSchema = z.object({
  runId: z.string(),
  workspaceId: z.string(),
  attemptId: z.string().optional(),
  ownerUserId: z.string(),
  harnessId: z.string(),
  mode: runModeSchema,
  status: runStatusSchema,
  prompt: z.string().optional(),
  exitCode: z.number().optional(),
  errorMessage: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Run = z.infer<typeof runSchema>;

export const listRunsQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  status: runStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const listRunsResponseSchema = z.object({
  items: z.array(runSchema),
});

// ---------------------------------------------------------------------------------------------
// Execution record — timeline
// ---------------------------------------------------------------------------------------------

/** The 12 EventEnvelope payload cases plus `unknown` (mirrors @sealant/telemetry payloadCaseValues). */
export const runTimelineKindValues = [
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
export const runTimelineKindSchema = z.enum(runTimelineKindValues);
export type RunTimelineKind = z.infer<typeof runTimelineKindSchema>;

export const runTimelineEntrySchema = z.object({
  eventId: z.string(),
  sequence: z.string(), // decimal-string uint64
  kind: z.string(),
  occurredAt: z.string(), // decimal-string monotonic timestamp
  summary: z.string(),
  ref: z.unknown().optional(),
  processId: z.string().optional(),
  captureMethod: z.number(),
  confidence: z.number(),
});
export type RunTimelineEntry = z.infer<typeof runTimelineEntrySchema>;

export const runTimelineQuerySchema = z.object({
  fromSequence: z.string().trim().min(1).optional(),
  toSequence: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  kinds: z.array(runTimelineKindSchema).min(1).optional(),
});

export const runTimelineResponseSchema = z.object({
  items: z.array(runTimelineEntrySchema),
});

// ---------------------------------------------------------------------------------------------
// Execution record — single raw event (full envelope + provenance)
// ---------------------------------------------------------------------------------------------

export const runEventParamsSchema = z.object({
  runId: z.string().trim().min(1),
  sequence: z.string().trim().min(1),
});

export const runEventSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  runtimeId: z.string(),
  executionId: z.string().optional(),
  sessionId: z.string().optional(),
  processId: z.string().optional(),
  requestId: z.string().optional(),
  schemaVersion: z.number(),
  sequence: z.string(),
  observedAt: z.string(),
  monotonicTimestamp: z.string(),
  captureMethod: z.number(),
  confidence: z.number(),
  payloadCase: z.string(),
  payload: z.unknown(),
  ingestedAt: z.string(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

// ---------------------------------------------------------------------------------------------
// Execution record — scrollback (byte-exact terminal output)
// ---------------------------------------------------------------------------------------------

export const runIoStreamSchema = z.enum(["stdout", "stderr"]);

export const runScrollbackQuerySchema = z.object({
  processId: z.string().trim().min(1),
  stream: runIoStreamSchema,
  atSequence: z.string().trim().min(1).optional(),
});

export const runScrollbackResponseSchema = z.object({
  processId: z.string(),
  stream: runIoStreamSchema,
  byteCount: z.number(),
  contentBase64: z.string(),
});
export type RunScrollback = z.infer<typeof runScrollbackResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Execution record — loss report
// ---------------------------------------------------------------------------------------------

export const runLossSpanSchema = z.object({
  kind: z.enum(["dropped_event", "sequence_gap", "watch_overflow", "early_close"]),
  fromSequence: z.string().optional(),
  toSequence: z.string().optional(),
  droppedCount: z.string().optional(),
  detectedVia: z.enum(["marker", "gap"]),
  reason: z.string().optional(),
});
export type RunLossSpan = z.infer<typeof runLossSpanSchema>;

export const runLossReportSchema = z.object({
  runId: z.string(),
  droppedEventCount: z.string(), // decimal-string uint64
  sequenceGapCount: z.number(),
  watchOverflowCount: z.number(),
  earlyClose: z.boolean(),
  spans: z.array(runLossSpanSchema),
});
export type RunLossReport = z.infer<typeof runLossReportSchema>;

// ---------------------------------------------------------------------------------------------
// Run changes — the diff the run produced
// ---------------------------------------------------------------------------------------------

export const runFileChangeSchema = z.object({
  path: z.string(),
  change: z.enum(["added", "modified", "deleted", "renamed"]),
  oldPath: z.string().optional(),
});
export type RunFileChange = z.infer<typeof runFileChangeSchema>;

export const runChangesResponseSchema = z.object({
  files: z.array(runFileChangeSchema),
  diff: z.string(),
});
export type RunChanges = z.infer<typeof runChangesResponseSchema>;
