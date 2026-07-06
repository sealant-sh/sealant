/**
 * Run + execution-record wire contracts.
 *
 * A `run` is one harness execution; it owns the execution record (the telemetry log). These
 * endpoints are the network face of the run-detail read path (RunRepo -> THIS contract -> apps/api ->
 * SDK): register a run, read its metadata, list runs, update its terminal status, and read its
 * record — timeline, byte-exact scrollback, and the provenance-honest loss report.
 *
 * Wire note: per-runtime monotonic uint64 sequences are carried as DECIMAL STRINGS (not JSON numbers)
 * so values past 2^53 survive; the SDK and API layer convert to/from `bigint`.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const runStatusSchema = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatusWire = typeof runStatusSchema.Type;

export const runModeSchema = Schema.Literals(["one-shot", "interactive"]);
export type RunModeWire = typeof runModeSchema.Type;

export const ioStreamSchema = Schema.Literals(["stdout", "stderr"]);
export type IoStreamWire = typeof ioStreamSchema.Type;

// ---------------------------------------------------------------------------------------------
// Run resource
// ---------------------------------------------------------------------------------------------

export const runSchema = Schema.Struct({
  runId: NonEmptyString,
  workspaceId: NonEmptyString,
  attemptId: Schema.optional(NonEmptyString),
  ownerUserId: NonEmptyString,
  harnessId: NonEmptyString,
  mode: runModeSchema,
  status: runStatusSchema,
  prompt: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  errorMessage: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Run = typeof runSchema.Type;

/** The one-shot harness invocation the control plane execs in the workspace. */
export const runCommandSchema = Schema.Struct({
  executable: NonEmptyString,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(NonEmptyString),
});
export type RunCommandWire = typeof runCommandSchema.Type;

export const runFileChangeSchema = Schema.Struct({
  path: NonEmptyString,
  change: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  oldPath: Schema.optional(NonEmptyString),
});
export type RunFileChangeWire = typeof runFileChangeSchema.Type;

export const createRunRequestSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  harnessId: NonEmptyString,
  ownerUserId: NonEmptyString,
  mode: Schema.optional(runModeSchema),
  prompt: Schema.optional(Schema.String),
  attemptId: Schema.optional(NonEmptyString),
  // When present, the control plane EXECUTES the run SERVER-SIDE: the worker docker-execs this command
  // in the workspace, ingests telemetry, and captures the diff. When absent, the run row is created but
  // not executed (the legacy host-local path where the caller runs it itself). This field is the gate
  // that lets the thin SDK opt into server-side execution without a breaking contract change.
  command: Schema.optional(runCommandSchema),
});
export type CreateRunRequest = typeof createRunRequestSchema.Type;

export const updateRunRequestSchema = Schema.Struct({
  status: Schema.optional(runStatusSchema),
  exitCode: Schema.optional(Schema.Number),
  errorMessage: Schema.optional(Schema.String),
  // Terminal-transition capture: callers that observed the run's file changes (e.g. the SSH gateway
  // closing an interactive session) persist them alongside the status flip.
  diff: Schema.optional(Schema.String),
  changedFiles: Schema.optional(Schema.Array(runFileChangeSchema)),
});
export type UpdateRunRequest = typeof updateRunRequestSchema.Type;

export const listRunsQuerySchema = Schema.Struct({
  workspaceId: Schema.optional(NonEmptyString),
  ownerUserId: Schema.optional(NonEmptyString),
  status: Schema.optional(runStatusSchema),
  limit: Schema.optional(NonEmptyString),
});
export type ListRunsQuery = typeof listRunsQuerySchema.Type;

export const listRunsResponseSchema = Schema.Struct({ items: Schema.Array(runSchema) });
export type ListRunsResponse = typeof listRunsResponseSchema.Type;

// ---------------------------------------------------------------------------------------------
// Execution record — timeline
// ---------------------------------------------------------------------------------------------

export const timelineEntrySchema = Schema.Struct({
  eventId: NonEmptyString,
  sequence: NonEmptyString, // decimal-string uint64
  kind: NonEmptyString,
  occurredAt: NonEmptyString, // decimal-string monotonic timestamp
  summary: Schema.String,
  ref: Schema.optional(Schema.Unknown),
  /** Correlation id of the producing process (attribution key for record views). */
  processId: Schema.optional(NonEmptyString),
  /** Numeric CaptureMethod / Confidence enums — how the fact was captured, per envelope. */
  captureMethod: Schema.Number,
  confidence: Schema.Number,
});
export type TimelineEntry = typeof timelineEntrySchema.Type;

export const getRunTimelineQuerySchema = Schema.Struct({
  fromSequence: Schema.optional(NonEmptyString),
  toSequence: Schema.optional(NonEmptyString),
  limit: Schema.optional(NonEmptyString),
  /**
   * Comma-separated payload cases (e.g. `processStarted,processExited,fileChange`). Filters the
   * timeline to those event kinds server-side — the read path for record views that must not pay
   * for the ioChunk-dominated full log.
   */
  kinds: Schema.optional(NonEmptyString),
});
export type GetRunTimelineQuery = typeof getRunTimelineQuerySchema.Type;

export const runTimelineResponseSchema = Schema.Struct({
  items: Schema.Array(timelineEntrySchema),
});
export type RunTimelineResponse = typeof runTimelineResponseSchema.Type;

// ---------------------------------------------------------------------------------------------
// Execution record — single raw event (the full envelope, provenance included)
// ---------------------------------------------------------------------------------------------

/**
 * One stored EventEnvelope, verbatim: correlation ids, both clocks, capture provenance, and the
 * jsonb payload (bigints stringified at ingest). This is the drill-down read behind a timeline
 * entry — the timeline carries the summary + ref, this carries the whole record.
 */
export const runEventSchema = Schema.Struct({
  eventId: NonEmptyString,
  runId: NonEmptyString,
  runtimeId: NonEmptyString,
  executionId: Schema.optional(NonEmptyString),
  sessionId: Schema.optional(NonEmptyString),
  processId: Schema.optional(NonEmptyString),
  requestId: Schema.optional(NonEmptyString),
  schemaVersion: Schema.Number,
  sequence: NonEmptyString, // decimal-string uint64
  observedAt: NonEmptyString, // decimal-string int64 wall clock
  monotonicTimestamp: NonEmptyString, // decimal-string uint64 ordering clock
  captureMethod: Schema.Number,
  confidence: Schema.Number,
  payloadCase: NonEmptyString,
  payload: Schema.Unknown,
  ingestedAt: Schema.String,
});
export type RunEvent = typeof runEventSchema.Type;

// ---------------------------------------------------------------------------------------------
// Execution record — scrollback (byte-exact terminal output)
// ---------------------------------------------------------------------------------------------

export const getRunScrollbackQuerySchema = Schema.Struct({
  processId: NonEmptyString,
  stream: ioStreamSchema,
  atSequence: Schema.optional(NonEmptyString),
});
export type GetRunScrollbackQuery = typeof getRunScrollbackQuerySchema.Type;

export const runScrollbackResponseSchema = Schema.Struct({
  processId: NonEmptyString,
  stream: ioStreamSchema,
  byteCount: Schema.Number,
  /** Base64-encoded reconstructed bytes (byte-exact). */
  contentBase64: Schema.String,
});
export type RunScrollbackResponse = typeof runScrollbackResponseSchema.Type;

// ---------------------------------------------------------------------------------------------
// Execution record — loss report (provenance honesty)
// ---------------------------------------------------------------------------------------------

export const lossSpanSchema = Schema.Struct({
  kind: Schema.Literals(["dropped_event", "sequence_gap", "watch_overflow", "early_close"]),
  fromSequence: Schema.optional(NonEmptyString),
  toSequence: Schema.optional(NonEmptyString),
  droppedCount: Schema.optional(NonEmptyString),
  detectedVia: Schema.Literals(["marker", "gap"]),
  reason: Schema.optional(Schema.String),
});
export type LossSpan = typeof lossSpanSchema.Type;

export const runLossReportSchema = Schema.Struct({
  runId: NonEmptyString,
  droppedEventCount: NonEmptyString, // decimal-string uint64
  sequenceGapCount: Schema.Number,
  watchOverflowCount: Schema.Number,
  earlyClose: Schema.Boolean,
  spans: Schema.Array(lossSpanSchema),
});
export type RunLossReport = typeof runLossReportSchema.Type;

// ---------------------------------------------------------------------------------------------
// Run changes — the file diff the run produced (captured server-side)
// ---------------------------------------------------------------------------------------------

export const runChangesResponseSchema = Schema.Struct({
  files: Schema.Array(runFileChangeSchema),
  /** Unified diff of everything that changed (empty until the run has produced changes). */
  diff: Schema.String,
});
export type RunChangesResponse = typeof runChangesResponseSchema.Type;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export class RunBadRequestError extends Schema.TaggedErrorClass<RunBadRequestError>()(
  "RunBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class RunNotFoundError extends Schema.TaggedErrorClass<RunNotFoundError>()(
  "RunNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class RunInternalServerError extends Schema.TaggedErrorClass<RunInternalServerError>()(
  "RunInternalServerError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

const runIdParams = Schema.Struct({ runId: NonEmptyString });
const runEventParams = Schema.Struct({ runId: NonEmptyString, sequence: NonEmptyString });

// ---------------------------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------------------------

export const RunsGroup = HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.post("createRun", "/", {
      payload: createRunRequestSchema,
      success: runSchema.pipe(HttpApiSchema.status(201)),
      error: [RunBadRequestError, RunNotFoundError, RunInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listRuns", "/", {
      query: listRunsQuerySchema,
      success: listRunsResponseSchema,
      error: [RunBadRequestError, RunInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRun", "/:runId", {
      params: runIdParams,
      success: runSchema,
      error: [RunNotFoundError, RunInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateRun", "/:runId", {
      params: runIdParams,
      payload: updateRunRequestSchema,
      success: runSchema,
      error: [RunBadRequestError, RunNotFoundError, RunInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunTimeline", "/:runId/timeline", {
      params: runIdParams,
      query: getRunTimelineQuerySchema,
      success: runTimelineResponseSchema,
      error: [RunBadRequestError, RunNotFoundError, RunInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunEvent", "/:runId/events/:sequence", {
      params: runEventParams,
      success: runEventSchema,
      error: [RunBadRequestError, RunNotFoundError, RunInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunScrollback", "/:runId/scrollback", {
      params: runIdParams,
      query: getRunScrollbackQuerySchema,
      success: runScrollbackResponseSchema,
      error: [RunBadRequestError, RunNotFoundError, RunInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunLoss", "/:runId/loss", {
      params: runIdParams,
      success: runLossReportSchema,
      error: [RunNotFoundError, RunInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunChanges", "/:runId/changes", {
      params: runIdParams,
      success: runChangesResponseSchema,
      error: [RunNotFoundError, RunInternalServerError],
    }),
  )
  .annotate(OpenApi.Description, "Runs (harness executions) and their execution record.");
