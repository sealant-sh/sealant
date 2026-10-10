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

/**
 * How a session's leader is wired. `pty` (default) allocates a pseudoterminal — interactive
 * shells and TUIs. `pipe` gives the leader plain stdio pipes and no tty — the shape for processes
 * that speak a byte protocol over stdin/stdout (JSON-RPC / NDJSON servers): stdout is the recorded,
 * attachable output, stderr is recorded as diagnostics only, input feeds stdin, and resize is
 * rejected.
 */
export const sessionModeSchema = Schema.Literals(["pty", "pipe"]);
export type SessionMode = typeof sessionModeSchema.Type;

/**
 * The Linux user a process runs as (Mend ADR 0016): a user name of the image's passwd, or a numeric
 * uid. The workspace's sealantd starts the process as that passwd entry: its uid, gid,
 * supplementary groups and `HOME`, `USER`, `LOGNAME` and `SHELL`, umask 0002, a private `TMPDIR`
 * and `XDG_RUNTIME_DIR`, the image's `/etc/sealant/person-env`, and none of the daemon's logins.
 * Only a person Mend made: a uid in 40001–49999 whose primary group is `mend` (40000), never root,
 * on a workspace whose sealantd reports `exec.user`. Anything else is refused before anything
 * starts (`409`, `user-unsupported`). sealantd checks the passwd entry it resolves again and starts
 * a process only as one of its owner map's people or a person in Mend's reserved range (a uid in
 * 40001–49999 whose primary group is 40000); root, root's group and anyone outside the range are
 * refused, so editing `/etc/passwd` with `sudo` cannot reach root or a system user. Absent: the workspace's own user, as before.
 */
export const workspaceProcessUserSchema = Schema.String.check(
  Schema.isPattern(/^(?:[a-z_][a-z0-9_-]{0,31}|[0-9]{1,10})$/),
);
export type WorkspaceProcessUser = typeof workspaceProcessUserSchema.Type;

/**
 * The stable `code` a session or exec as a user is refused with (`409`), the message saying why:
 * the workspace's sealantd does not run processes as another user (no `exec.user`), its runtime
 * does not (Cloudflare), the user is not in range (root, a uid outside 40001–49999, or a primary
 * group other than `mend`), or no such user exists yet. Nothing is started.
 */
export const PROCESS_USER_UNSUPPORTED_CODE = "user-unsupported";

/** The most words a session's argv may hold, the program included. */
export const SESSION_ARGV_MAX_WORDS = 64;

/**
 * The most UTF-8 bytes one word of a session's argv may hold, its terminating NUL not counted:
 * Linux's `MAX_ARG_STRLEN` (32 pages, 128 KiB on 4 KiB pages) counts the NUL, so 131,071 bytes of
 * text is the longest word `execve` takes there; one byte more fails with `E2BIG` whatever the total.
 */
export const SESSION_ARGV_MAX_WORD_BYTES = 128 * 1024 - 1;

/**
 * The most UTF-8 bytes a session's argv may hold in all: half of Linux's usual 2 MiB `ARG_MAX`,
 * which argv shares with the environment, and far below sealantd's 8 MiB control frame.
 */
export const SESSION_ARGV_MAX_TOTAL_BYTES = 1024 * 1024;

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/**
 * A UTF-16 surrogate with no partner (with the `u` flag a pair is one code point and never matches):
 * it has no UTF-8 form, so it would reach the process as U+FFFD.
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * Why `argv` cannot start a session, or `undefined` when it can. `argv[0]`, the program, is
 * non-empty with no leading or trailing whitespace. Every later word is opaque to Sealant and may be
 * any string, empty, whitespace-led or multi-line (`bash -lc "\n echo hi"`, `git commit -m ""`),
 * except one with a NUL byte, which no process argument can carry, or a lone UTF-16 surrogate, which
 * has no UTF-8 form and would not reach the process as sent. The reason names a word by its position
 * and size, never its text, which can carry a secret: it reaches the caller in the `400` and the
 * server's request log.
 */
export const sessionArgvIssue = (argv: readonly string[]): string | undefined => {
  const program = argv[0];
  if (program === undefined) {
    return "argv is empty: argv[0] must name the program";
  }
  if (argv.length > SESSION_ARGV_MAX_WORDS) {
    return `argv has ${argv.length} words; the maximum is ${SESSION_ARGV_MAX_WORDS}`;
  }
  if (program.length === 0 || program.trim() !== program) {
    return "argv[0], the program, must be non-empty with no leading or trailing whitespace";
  }
  let totalBytes = 0;
  for (const [index, word] of argv.entries()) {
    if (word.includes("\u0000")) {
      return `argv[${index}] contains a NUL byte, which no process argument can carry`;
    }
    if (LONE_SURROGATE.test(word)) {
      return `argv[${index}] is not well-formed Unicode (a lone surrogate)`;
    }
    const bytes = utf8Bytes(word);
    if (bytes > SESSION_ARGV_MAX_WORD_BYTES) {
      return `argv[${index}] is ${bytes} bytes; the maximum per word is ${SESSION_ARGV_MAX_WORD_BYTES}`;
    }
    totalBytes += bytes;
  }
  if (totalBytes > SESSION_ARGV_MAX_TOTAL_BYTES) {
    return `argv totals ${totalBytes} bytes; the maximum is ${SESSION_ARGV_MAX_TOTAL_BYTES}`;
  }
  return undefined;
};

/**
 * A session's argv: the program, then its arguments, as `sessionArgvIssue` allows. One check over
 * the whole array, because Effect's own length and whitespace checks quote the offending value.
 */
export const sessionArgvSchema = Schema.Array(Schema.String).check(
  Schema.makeFilter(sessionArgvIssue),
);

export const createSessionRequestSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  ownerUserId: NonEmptyString,
  /**
   * argv[0] is the program the session runs; the rest its arguments, passed to it as an argv array,
   * never through a shell. See `sessionArgvIssue` for what is refused.
   */
  argv: sessionArgvSchema,
  /** Working directory inside the workspace (defaults to the workspace working directory). */
  cwd: Schema.optional(NonEmptyString),
  /** Extra environment for the PTY process (values are NOT secrets — use credentials for those). */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cols: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  rows: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  term: Schema.optional(NonEmptyString),
  /** Leader wiring; defaults to `pty`. `cols`/`rows`/`term` are ignored for `pipe`. */
  mode: Schema.optional(sessionModeSchema),
  /** Opaque caller correlation bag: stored verbatim, echoed on reads, no platform semantics. */
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /**
   * Refused here (`409`, `user-unsupported`), never ignored: a session as a Linux user is opened
   * with `POST /v1/sessions/as-user` (`createSessionAsUserRequestSchema`), a route a control plane
   * that cannot run one answers `404`, so a mixed-version fleet never runs it as root.
   */
  user: Schema.optional(workspaceProcessUserSchema),
});
export type CreateSessionRequest = typeof createSessionRequestSchema.Type;

/**
 * `POST /v1/sessions/as-user`: a session whose leader runs as `user` (see
 * `workspaceProcessUserSchema`), otherwise as `POST /v1/sessions`. Its own route, so a control
 * plane from before it answers `404` instead of opening the session as the workspace's own user.
 */
export const createSessionAsUserRequestSchema = Schema.Struct({
  ...createSessionRequestSchema.fields,
  user: workspaceProcessUserSchema,
});
export type CreateSessionAsUserRequest = typeof createSessionAsUserRequestSchema.Type;

export const sessionSchema = Schema.Struct({
  sessionId: NonEmptyString,
  workspaceId: NonEmptyString,
  /** The interactive run recording this session; its record is the durable evidence. */
  runId: NonEmptyString,
  ownerUserId: NonEmptyString,
  status: sessionStatusSchema,
  /**
   * Only `argv[0]`, the program: Sealant never stores a session's arguments, because they can carry
   * secrets. `argCount` and `argLengths` (UTF-8 bytes each) describe them.
   */
  argv: Schema.Array(Schema.String),
  /** How many arguments followed the program. Absent when there were none. */
  argCount: Schema.optional(Schema.Number),
  /** Each argument's length in UTF-8 bytes, in order. Absent when there were none. */
  argLengths: Schema.optional(Schema.Array(Schema.Number)),
  cwd: Schema.optional(NonEmptyString),
  cols: Schema.Number,
  rows: Schema.Number,
  /** Leader wiring. Absent on servers from before pipe mode shipped, which means `pty`. */
  mode: Schema.optional(sessionModeSchema),
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
  {
    message: Schema.String,
    /** A stable reason, where one applies (`user-unsupported`). */
    code: Schema.optional(NonEmptyString),
  },
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
    // Scope: workspace:exec. `createSession` with the leader run as a Linux user (`409`
    // `user-unsupported` where the executor cannot; `502` when it does not answer the check).
    HttpApiEndpoint.post("createSessionAsUser", "/as-user", {
      headers: sessionAuthorizationHeadersSchema,
      payload: createSessionAsUserRequestSchema,
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
