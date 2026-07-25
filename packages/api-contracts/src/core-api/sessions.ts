/**
 * Interactive session wire contracts — first-class PTY sessions over a live workspace.
 *
 * A session is a daemon-owned PTY (it survives control-connection drops); the control plane holds
 * the durable row and drives every verb over short-lived per-daemon-request connections, so any
 * API instance can serve any session. Output is DURABLE and SEQUENCE-KEYED: the session's run
 * record ingests the PTY byte stream (redacted, byte-exact), and the output endpoints serve it by
 * sequence range — which is what makes detach/reattach and byte-exact history replay work. The
 * live tail is served as SSE by `GET /v1/sessions/:sessionId/output/stream` (implemented as a raw
 * streaming route on the same server, outside this schema-derived contract).
 *
 * AUTHORIZATION: the session surface enforces scoped bearer tokens when one is presented —
 * `session:read` (status/output), `session:input` (input/resize/signal), `workspace:exec`
 * (create/close). Without a bearer token the pre-auth owner model applies unchanged.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const sessionStatusSchema = Schema.Literals(["starting", "running", "exited", "failed"]);
export type SessionStatusWire = typeof sessionStatusSchema.Type;

export const sessionAuthorizationHeadersSchema = Schema.Struct({
  authorization: Schema.optional(Schema.String),
});
export type SessionAuthorizationHeaders = typeof sessionAuthorizationHeadersSchema.Type;

export const createSessionRequestSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  ownerUserId: NonEmptyString,
  /** argv[0] is the program the PTY runs; the rest its arguments. */
  argv: Schema.Array(NonEmptyString).check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  /** Working directory inside the workspace (defaults to the workspace working directory). */
  cwd: Schema.optional(NonEmptyString),
  /** Extra environment for the PTY process (values are NOT secrets — use credentials for those). */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cols: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  rows: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  term: Schema.optional(NonEmptyString),
  /** Opaque caller correlation bag: stored verbatim, echoed on reads, no platform semantics. */
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type CreateSessionRequest = typeof createSessionRequestSchema.Type;

export const sessionSchema = Schema.Struct({
  sessionId: NonEmptyString,
  workspaceId: NonEmptyString,
  /** The interactive run recording this session; its record is the durable evidence. */
  runId: NonEmptyString,
  ownerUserId: NonEmptyString,
  status: sessionStatusSchema,
  argv: Schema.Array(Schema.String),
  cwd: Schema.optional(NonEmptyString),
  cols: Schema.Number,
  rows: Schema.Number,
  exitCode: Schema.optional(Schema.Number),
  exitSignal: Schema.optional(Schema.Number),
  errorMessage: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /**
   * Highest ingested output sequence for this session's run (decimal string), or "0" when nothing
   * has been ingested yet — the resume cursor: `output?from=<highWater + 1>` continues exactly
   * where a previous reader stopped.
   */
  outputHighWater: NonEmptyString,
  createdAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
});
export type SessionWire = typeof sessionSchema.Type;

export const listSessionsQuerySchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  workspaceId: Schema.optional(NonEmptyString),
  status: Schema.optional(sessionStatusSchema),
  limit: Schema.optional(NonEmptyString),
});
export type ListSessionsQuery = typeof listSessionsQuerySchema.Type;

export const listSessionsResponseSchema = Schema.Struct({
  items: Schema.Array(sessionSchema),
});
export type ListSessionsResponse = typeof listSessionsResponseSchema.Type;

export const sessionInputRequestSchema = Schema.Struct({
  ownerUserId: Schema.optional(NonEmptyString),
  /** Base64-encoded keystrokes (bytes, not text — binary-safe). */
  dataBase64: NonEmptyString,
});
export type SessionInputRequest = typeof sessionInputRequestSchema.Type;

export const sessionResizeRequestSchema = Schema.Struct({
  ownerUserId: Schema.optional(NonEmptyString),
  cols: Schema.Int.check(Schema.isGreaterThan(0)),
  rows: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type SessionResizeRequest = typeof sessionResizeRequestSchema.Type;

export const sessionSignalRequestSchema = Schema.Struct({
  ownerUserId: Schema.optional(NonEmptyString),
  /** POSIX signal number (e.g. 2 = SIGINT, 15 = SIGTERM). */
  signal: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type SessionSignalRequest = typeof sessionSignalRequestSchema.Type;

export const closeSessionRequestSchema = Schema.Struct({
  ownerUserId: Schema.optional(NonEmptyString),
});
export type CloseSessionRequest = typeof closeSessionRequestSchema.Type;

/**
 * Byte-exact session output by sequence range. `from` is INCLUSIVE (omit = from the beginning);
 * chunks carry their sequence so a disconnected reader resumes with `lastSequence + 1`. Output is
 * as-recorded: redacted upstream by the daemon, PTY output stream only.
 */
export const getSessionOutputQuerySchema = Schema.Struct({
  ownerUserId: Schema.optional(NonEmptyString),
  from: Schema.optional(NonEmptyString),
  limit: Schema.optional(NonEmptyString),
});
export type GetSessionOutputQuery = typeof getSessionOutputQuerySchema.Type;

export const sessionOutputChunkSchema = Schema.Struct({
  sequence: NonEmptyString, // decimal-string uint64
  /** Base64-encoded PTY output bytes, exactly as recorded. */
  dataBase64: Schema.String,
});
export type SessionOutputChunk = typeof sessionOutputChunkSchema.Type;

export const sessionOutputResponseSchema = Schema.Struct({
  sessionId: NonEmptyString,
  chunks: Schema.Array(sessionOutputChunkSchema),
  /** The cursor to pass as `from` to continue after this page. */
  nextFrom: NonEmptyString,
  /** Session status at read time, so pollers can stop when the session settles. */
  status: sessionStatusSchema,
});
export type SessionOutputResponse = typeof sessionOutputResponseSchema.Type;

export class SessionBadRequestError extends Schema.TaggedErrorClass<SessionBadRequestError>()(
  "SessionBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class SessionUnauthorizedError extends Schema.TaggedErrorClass<SessionUnauthorizedError>()(
  "SessionUnauthorizedError",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class SessionForbiddenError extends Schema.TaggedErrorClass<SessionForbiddenError>()(
  "SessionForbiddenError",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "SessionNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class SessionConflictError extends Schema.TaggedErrorClass<SessionConflictError>()(
  "SessionConflictError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class SessionBadGatewayError extends Schema.TaggedErrorClass<SessionBadGatewayError>()(
  "SessionBadGatewayError",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

export class SessionInternalServerError extends Schema.TaggedErrorClass<SessionInternalServerError>()(
  "SessionInternalServerError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

const sessionIdParams = Schema.Struct({ sessionId: NonEmptyString });

export const SessionsGroup = HttpApiGroup.make("sessions")
  .add(
    // Scope: workspace:exec. Opens the daemon PTY, creates the interactive run + session rows.
    HttpApiEndpoint.post("createSession", "/", {
      headers: sessionAuthorizationHeadersSchema,
      payload: createSessionRequestSchema,
      success: sessionSchema.pipe(HttpApiSchema.status(201)),
      error: [
        SessionBadRequestError,
        SessionUnauthorizedError,
        SessionForbiddenError,
        SessionNotFoundError,
        SessionConflictError,
        SessionBadGatewayError,
        SessionInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listSessions", "/", {
      headers: sessionAuthorizationHeadersSchema,
      query: listSessionsQuerySchema,
      success: listSessionsResponseSchema,
      error: [
        SessionBadRequestError,
        SessionUnauthorizedError,
        SessionForbiddenError,
        SessionInternalServerError,
      ],
    }),
  )
  .add(
    // Scope: session:read. Status includes the resume cursor (outputHighWater).
    HttpApiEndpoint.get("getSession", "/:sessionId", {
      params: sessionIdParams,
      headers: sessionAuthorizationHeadersSchema,
      query: Schema.Struct({ ownerUserId: Schema.optional(NonEmptyString) }),
      success: sessionSchema,
      error: [
        SessionBadRequestError,
        SessionUnauthorizedError,
        SessionForbiddenError,
        SessionNotFoundError,
        SessionInternalServerError,
      ],
    }),
  )
  .add(
    // Scope: session:read. Byte-exact recorded output by sequence range (history + poll tail).
    HttpApiEndpoint.get("getSessionOutput", "/:sessionId/output", {
      params: sessionIdParams,
      headers: sessionAuthorizationHeadersSchema,
      query: getSessionOutputQuerySchema,
      success: sessionOutputResponseSchema,
      error: [
        SessionBadRequestError,
        SessionUnauthorizedError,
        SessionForbiddenError,
        SessionNotFoundError,
        SessionInternalServerError,
      ],
    }),
  )
  .add(
    // Scope: session:input.
    HttpApiEndpoint.post("sendSessionInput", "/:sessionId/input", {
      params: sessionIdParams,
      headers: sessionAuthorizationHeadersSchema,
      payload: sessionInputRequestSchema,
      success: Schema.Struct({ ok: Schema.Boolean }),
      error: [
        SessionBadRequestError,
        SessionUnauthorizedError,
        SessionForbiddenError,
        SessionNotFoundError,
        SessionConflictError,
        SessionBadGatewayError,
        SessionInternalServerError,
      ],
    }),
  )
  .add(
    // Scope: session:input.
    HttpApiEndpoint.post("resizeSession", "/:sessionId/resize", {
      params: sessionIdParams,
      headers: sessionAuthorizationHeadersSchema,
      payload: sessionResizeRequestSchema,
      success: Schema.Struct({ ok: Schema.Boolean }),
      error: [
        SessionBadRequestError,
        SessionUnauthorizedError,
        SessionForbiddenError,
        SessionNotFoundError,
        SessionConflictError,
        SessionBadGatewayError,
        SessionInternalServerError,
      ],
    }),
  )
  .add(
    // Scope: session:input.
    HttpApiEndpoint.post("signalSession", "/:sessionId/signal", {
      params: sessionIdParams,
      headers: sessionAuthorizationHeadersSchema,
      payload: sessionSignalRequestSchema,
      success: Schema.Struct({ ok: Schema.Boolean }),
      error: [
        SessionBadRequestError,
        SessionUnauthorizedError,
        SessionForbiddenError,
        SessionNotFoundError,
        SessionConflictError,
        SessionBadGatewayError,
        SessionInternalServerError,
      ],
    }),
  )
  .add(
    // Scope: workspace:exec (closing a terminal is a control action, like opening one).
    HttpApiEndpoint.post("closeSession", "/:sessionId/close", {
      params: sessionIdParams,
      headers: sessionAuthorizationHeadersSchema,
      payload: closeSessionRequestSchema,
      success: sessionSchema.pipe(HttpApiSchema.status(202)),
      error: [
        SessionBadRequestError,
        SessionUnauthorizedError,
        SessionForbiddenError,
        SessionNotFoundError,
        SessionBadGatewayError,
        SessionInternalServerError,
      ],
    }),
  )
  .annotate(
    OpenApi.Description,
    "Interactive PTY sessions: durable, reattachable, sequence-keyed output.",
  );
