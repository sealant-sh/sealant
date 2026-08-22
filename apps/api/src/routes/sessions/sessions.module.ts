/**
 * Sessions route handlers — first-class interactive PTY sessions.
 *
 * ARCHITECTURE: daemon PTY sessions are DAEMON-OWNED (they survive control-connection drops; only
 * stream attachments are connection-scoped), so every verb here rides a SHORT-LIVED per-request
 * daemon connection — the API stays stateless and any instance can serve any session. Output is
 * never read from the daemon: the telemetry ingester (worker) records the PTY byte stream into the
 * run record (redacted upstream, sequence-keyed, byte-exact), and the output endpoints serve THAT,
 * which is what makes detach/reattach with byte-exact history work.
 *
 * HEAD-LOSS: the daemon telemetry protocol is live-tail (no replay), so `createSession` creates
 * the interactive run FIRST, waits for the worker's ingester to open its epoch (the "recorder is
 * rolling" signal), and only then opens the PTY — recording starts at byte zero.
 *
 * AUTHORIZATION: three scopes, enforced when a bearer token is presented — `session:read`
 * (status/output), `session:input` (input/resize/signal), `workspace:exec` (create/close).
 * Without a token — or with a SERVICE KEY (services/service-principals.ts) — the owner model
 * applies (ownerUserId in payload/query), matching the rest of the control plane.
 */
import { createHash, randomUUID } from "node:crypto";

import {
  SessionBadGatewayError,
  SessionBadRequestError,
  SessionConflictError,
  SessionForbiddenError,
  SessionInternalServerError,
  SessionNotFoundError,
  SessionUnauthorizedError,
  type CloseSessionRequest,
  type CreateSessionRequest,
  type GetSessionOutputQuery,
  type ListSessionsQuery,
  type ListSessionsResponse,
  type SessionAuthorizationHeaders,
  type SessionInputRequest,
  type SessionOutputResponse,
  type SessionResizeRequest,
  type SessionSignalRequest,
  type SessionWire,
} from "@sealant/api-contracts";
import {
  AccessTokenRepo,
  RunRepo,
  WorkspaceAttemptRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceSessionRepo,
  type AccessTokenScope,
  type WorkspaceSession,
} from "@sealant/db";
import { TelemetryQuery } from "@sealant/telemetry";
import {
  SealantControlError,
  SealantRuntime,
  sealantTargetForRuntimeInstance,
  type SealantSession as DaemonConnection,
  type SealantTarget,
} from "@sealant/workspaces";
import { Effect, Stream } from "effect";

import { servicePrincipals } from "../../services/service-principals.js";

// StreamKind numerics from the runtime protocol (avoid a runtime dep for constants).
const STREAM_KIND_PTY_OUTPUT = 5;
// Daemon ControlErrorCode.SESSION_NOT_FOUND — the session is already gone daemon-side.
const DAEMON_SESSION_NOT_FOUND = 8;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const DEFAULT_TERM = "xterm-256color";
// How long createSession waits for the telemetry ingester to start recording (worker polls at 1s).
const EPOCH_WAIT_TIMEOUT_MS = 15_000;
const EPOCH_WAIT_INTERVAL_MS = 200;
// How long closeSession waits for the settle evidence (processExited) to be ingested.
const EXIT_WAIT_TIMEOUT_MS = 5_000;
const EXIT_WAIT_INTERVAL_MS = 250;

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const withInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) =>
  effect.pipe(
    Effect.mapError(
      (error) => new SessionInternalServerError({ message: toErrorMessage(error, fallback) }),
    ),
  );

const delay = (ms: number) => Effect.promise(() => new Promise((r) => setTimeout(r, ms)));

// ---------------------------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------------------------

export interface SessionPrincipal {
  readonly ownerUserId: string;
  /** Set when a bearer token narrowed the principal to one workspace. */
  readonly workspaceId?: string;
}

/**
 * Resolves the caller for a session endpoint. A presented bearer token is authoritative: it must
 * exist, be unexpired/unrevoked, and carry `requiredScope` — its owner (and optional workspace
 * narrowing) become the principal. Without a token, the caller-asserted ownerUserId applies (the
 * platform's pre-auth owner model, unchanged).
 */
export const authorize = (input: {
  readonly headers: SessionAuthorizationHeaders;
  readonly requiredScope: AccessTokenScope;
  readonly assertedOwnerUserId: string | undefined;
}) =>
  Effect.gen(function* () {
    const header = input.headers.authorization?.trim();
    if (header === undefined || header.length === 0) {
      if (input.assertedOwnerUserId === undefined) {
        return yield* new SessionBadRequestError({
          message: "ownerUserId is required when no bearer token is presented.",
        });
      }
      return { ownerUserId: input.assertedOwnerUserId } satisfies SessionPrincipal;
    }

    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match === null || match[1] === undefined) {
      return yield* new SessionUnauthorizedError({
        message: "Malformed Authorization header (expected: Bearer <token>).",
      });
    }
    const secret = match[1].trim();
    // A service principal (Mend) acts on behalf of the asserted owner — same as no token.
    if (servicePrincipals.matches(secret)) {
      if (input.assertedOwnerUserId === undefined) {
        return yield* new SessionBadRequestError({
          message: "ownerUserId is required when authenticating as a service principal.",
        });
      }
      return { ownerUserId: input.assertedOwnerUserId } satisfies SessionPrincipal;
    }
    const tokenHash = createHash("sha256").update(secret).digest("hex");

    const tokens = yield* AccessTokenRepo;
    const token = yield* withInternalError(
      tokens.getTokenByHash(tokenHash),
      "Failed to look up access token.",
    );
    if (token === undefined || token.revokedAt !== null) {
      return yield* new SessionUnauthorizedError({ message: "Unknown or revoked access token." });
    }
    if (token.expiresAt !== null && token.expiresAt.getTime() < Date.now()) {
      return yield* new SessionUnauthorizedError({ message: "Access token has expired." });
    }
    if (!token.scopes.includes(input.requiredScope)) {
      return yield* new SessionForbiddenError({
        message: `Access token lacks the required scope: ${input.requiredScope}.`,
      });
    }

    return {
      ownerUserId: token.ownerUserId,
      ...(token.workspaceId === null ? {} : { workspaceId: token.workspaceId }),
    } satisfies SessionPrincipal;
  });

// ---------------------------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------------------------

/** Uniform 404 on owner or token-workspace mismatch — existence is not leaked. */
export const requireSession = (sessionId: string, principal: SessionPrincipal) =>
  Effect.gen(function* () {
    const sessions = yield* WorkspaceSessionRepo;
    const session = yield* withInternalError(
      sessions.getSessionById(sessionId),
      "Failed to load session.",
    );
    if (
      session === undefined ||
      session.ownerUserId !== principal.ownerUserId ||
      (principal.workspaceId !== undefined && session.workspaceId !== principal.workspaceId)
    ) {
      return yield* new SessionNotFoundError({ message: `Session not found: ${sessionId}` });
    }
    return session;
  });

/** Resolve the workspace's live daemon target (docker adapter, ready instance). */
export const resolveDaemonTarget = (workspaceId: string) =>
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const instances = yield* WorkspaceRuntimeInstanceRepo;
    const workspace = yield* withInternalError(
      workspaces.getWorkspaceById(workspaceId),
      "Failed to load workspace.",
    );
    if (workspace === undefined || workspace.latestRunId === null) {
      return undefined;
    }
    const instance = yield* withInternalError(
      instances.getRuntimeInstanceByRunId(workspace.latestRunId),
      "Failed to load workspace runtime.",
    );
    if (instance === undefined || instance.status !== "ready") {
      return undefined;
    }
    return sealantTargetForRuntimeInstance(instance);
  });

/** Run `f` over a short-lived daemon connection (scoped: the bridge is torn down after). */
const withDaemon = <A, E>(
  target: SealantTarget,
  f: (daemon: DaemonConnection) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const runtime = yield* SealantRuntime;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* runtime.connect(target);
        return yield* f(daemon);
      }),
    );
  });

const isDaemonSessionGone = (error: unknown): boolean =>
  error instanceof SealantControlError && error.code === DAEMON_SESSION_NOT_FOUND;

// ---------------------------------------------------------------------------------------------
// Settlement — telemetry is the source of truth for how a session ended
// ---------------------------------------------------------------------------------------------

interface ExitEvidence {
  readonly exitCode?: number;
  readonly exitSignal?: number;
}

/** Look for the ingested `processExited` event of the session's PTY process. */
const findExitEvidence = (session: WorkspaceSession) =>
  Effect.gen(function* () {
    if (session.daemonProcessId === null) {
      return undefined;
    }
    const query = yield* TelemetryQuery;
    const entries = yield* withInternalError(
      Stream.runCollect(query.getTimeline(session.runId, { cases: ["processExited"] })),
      "Failed to read session settle evidence.",
    );
    for (const entry of entries) {
      if (entry.processId !== session.daemonProcessId) {
        continue;
      }
      const ref = entry.ref;
      if (typeof ref === "object" && ref !== null) {
        const record = ref as { exitCode?: unknown; signal?: unknown };
        return {
          ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}),
          ...(typeof record.signal === "number" ? { exitSignal: record.signal } : {}),
        } satisfies ExitEvidence;
      }
      return {} satisfies ExitEvidence;
    }
    return undefined;
  });

/**
 * Settle a session row (and its run) from recorded evidence. DB-only — no daemon roundtrip — so
 * read paths can reconcile on every poll: `processExited` ingested => the session is over and all
 * prior output is durably recorded (the log is ordered). A dead runtime with no exit evidence
 * settles as `failed`.
 */
export const reconcileSession = (session: WorkspaceSession) =>
  Effect.gen(function* () {
    if (session.status !== "starting" && session.status !== "running") {
      return session;
    }
    const sessions = yield* WorkspaceSessionRepo;
    const runs = yield* RunRepo;

    const evidence = yield* findExitEvidence(session);
    if (evidence !== undefined) {
      const updated = yield* withInternalError(
        sessions.markSessionEnded({
          id: session.id,
          status: "exited",
          ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode }),
          ...(evidence.exitSignal === undefined ? {} : { exitSignal: evidence.exitSignal }),
        }),
        "Failed to settle session.",
      );
      yield* withInternalError(
        runs.markRunCompleted({ id: session.runId, exitCode: evidence.exitCode ?? 0 }),
        "Failed to settle session run.",
      );
      return updated ?? session;
    }

    const target = yield* resolveDaemonTarget(session.workspaceId);
    if (target === undefined) {
      const updated = yield* withInternalError(
        sessions.markSessionEnded({
          id: session.id,
          status: "failed",
          errorMessage: "Workspace runtime is gone; the session did not settle cleanly.",
        }),
        "Failed to settle session.",
      );
      yield* withInternalError(
        runs.markRunFailed({
          id: session.runId,
          errorMessage: "Workspace runtime is gone; interactive session did not settle cleanly.",
        }),
        "Failed to settle session run.",
      );
      return updated ?? session;
    }

    return session;
  });

// ---------------------------------------------------------------------------------------------
// Wire mapping
// ---------------------------------------------------------------------------------------------

const mapSession = (session: WorkspaceSession, outputHighWater: bigint): SessionWire => ({
  sessionId: session.id,
  workspaceId: session.workspaceId,
  runId: session.runId,
  ownerUserId: session.ownerUserId,
  status: session.status,
  argv: [...session.argv],
  ...(session.cwd === null ? {} : { cwd: session.cwd }),
  cols: session.cols,
  rows: session.rows,
  mode: session.mode,
  ...(session.exitCode === null ? {} : { exitCode: session.exitCode }),
  ...(session.exitSignal === null ? {} : { exitSignal: session.exitSignal }),
  ...(session.errorMessage === null ? {} : { errorMessage: session.errorMessage }),
  ...(session.metadata === null ? {} : { metadata: session.metadata }),
  outputHighWater: outputHighWater.toString(),
  createdAt: session.createdAt.toISOString(),
  ...(session.endedAt === null ? {} : { endedAt: session.endedAt.toISOString() }),
});

const sessionWithHighWater = (session: WorkspaceSession) =>
  Effect.gen(function* () {
    const query = yield* TelemetryQuery;
    const highWater = yield* withInternalError(
      query.maxSequence(session.runId),
      "Failed to read session output high-water mark.",
    );
    return mapSession(session, highWater);
  });

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

export const createSession = (input: {
  readonly payload: CreateSessionRequest;
  readonly headers: SessionAuthorizationHeaders;
}) =>
  Effect.gen(function* () {
    const principal = yield* authorize({
      headers: input.headers,
      requiredScope: "workspace:exec",
      assertedOwnerUserId: input.payload.ownerUserId,
    });
    if (
      principal.workspaceId !== undefined &&
      principal.workspaceId !== input.payload.workspaceId
    ) {
      return yield* new SessionNotFoundError({
        message: `Workspace not found: ${input.payload.workspaceId}`,
      });
    }

    const workspaces = yield* WorkspaceRepo;
    const workspace = yield* withInternalError(
      workspaces.getWorkspaceById(input.payload.workspaceId),
      "Failed to load workspace.",
    );
    if (workspace === undefined || workspace.ownerUserId !== principal.ownerUserId) {
      return yield* new SessionNotFoundError({
        message: `Workspace not found: ${input.payload.workspaceId}`,
      });
    }

    const target = yield* resolveDaemonTarget(workspace.id);
    if (target === undefined) {
      return yield* new SessionConflictError({
        message: "The workspace has no ready runtime to host a session.",
      });
    }

    // Default cwd: the blueprint's working directory (where the repository lives).
    const attempts = yield* WorkspaceAttemptRepo;
    const snapshot =
      workspace.latestRunId === null
        ? undefined
        : yield* withInternalError(
            attempts.getAttemptSnapshotByRunId(workspace.latestRunId),
            "Failed to load workspace blueprint snapshot.",
          );
    const blueprintWorkingDirectory = (() => {
      const spec = snapshot?.resolvedSpecPayload as
        | { runtime?: { workingDirectory?: string } }
        | undefined;
      return spec?.runtime?.workingDirectory ?? "/workspace/repo";
    })();

    const runs = yield* RunRepo;
    const sessions = yield* WorkspaceSessionRepo;
    const query = yield* TelemetryQuery;

    const runId = `run_${randomUUID()}`;
    const sessionId = `sess_${randomUUID()}`;
    const argv = [...input.payload.argv];
    const cwd = input.payload.cwd ?? blueprintWorkingDirectory;
    const mode = input.payload.mode ?? "pty";
    // A pipe leader has no terminal: size is meaningless, recorded as 0×0.
    const cols = mode === "pipe" ? 0 : (input.payload.cols ?? DEFAULT_COLS);
    const rows = mode === "pipe" ? 0 : (input.payload.rows ?? DEFAULT_ROWS);

    yield* withInternalError(
      runs.createRun({
        id: runId,
        workspaceId: workspace.id,
        ownerUserId: principal.ownerUserId,
        harnessId: "session",
        mode: "interactive",
        command: { executable: argv[0] ?? "", args: argv.slice(1), cwd },
        ...(input.payload.metadata === undefined
          ? {}
          : { metadata: { ...input.payload.metadata } }),
      }),
      "Failed to create session run.",
    );
    yield* withInternalError(
      sessions.createSession({
        id: sessionId,
        workspaceId: workspace.id,
        runId,
        ownerUserId: principal.ownerUserId,
        argv,
        cwd,
        cols,
        rows,
        mode,
        ...(input.payload.metadata === undefined
          ? {}
          : { metadata: { ...input.payload.metadata } }),
      }),
      "Failed to create session.",
    );
    // `running` is what the telemetry worker polls for — flipping it starts the recorder.
    yield* withInternalError(runs.markRunRunning({ id: runId }), "Failed to start session run.");

    // Wait for the recorder before opening the session: the daemon telemetry protocol is live-tail
    // (no replay), so output emitted before the ingester attaches would be unrecoverable.
    const deadline = Date.now() + EPOCH_WAIT_TIMEOUT_MS;
    for (;;) {
      const recording = yield* withInternalError(
        query.hasEpoch(runId),
        "Failed to check session recording status.",
      );
      if (recording) {
        break;
      }
      if (Date.now() > deadline) {
        yield* withInternalError(
          runs.markRunFailed({
            id: runId,
            errorMessage: "Telemetry ingester never attached; is the worker running?",
          }),
          "Failed to settle session run.",
        ).pipe(Effect.ignore);
        yield* withInternalError(
          sessions.markSessionEnded({
            id: sessionId,
            status: "failed",
            errorMessage: "Telemetry ingester never attached; is the worker running?",
          }),
          "Failed to settle session.",
        ).pipe(Effect.ignore);
        return yield* new SessionBadGatewayError({
          message:
            "The session recorder did not attach in time (is the worker running?). No PTY was opened.",
        });
      }
      yield* delay(EPOCH_WAIT_INTERVAL_MS);
    }

    const opened = yield* withDaemon(target, (daemon) =>
      daemon.openSession({
        executionId: runId,
        shell: argv[0] ?? "/bin/bash",
        args: argv.slice(1),
        cwd,
        ...(input.payload.env === undefined ? {} : { env: input.payload.env }),
        cols,
        rows,
        term: input.payload.term ?? DEFAULT_TERM,
        mode,
      }),
    ).pipe(
      Effect.mapError((error) => {
        return new SessionBadGatewayError({
          message: `Failed to open the ${mode} session: ${toErrorMessage(error, "daemon error")}`,
        });
      }),
    );

    const running = yield* withInternalError(
      sessions.markSessionRunning({
        id: sessionId,
        daemonSessionId: opened.sessionId,
        daemonProcessId: opened.processId,
      }),
      "Failed to record session start.",
    );
    if (running === null) {
      return yield* new SessionInternalServerError({
        message: "Session row vanished during creation.",
      });
    }
    return mapSession(running, 0n);
  });

export const getSession = (input: {
  readonly sessionId: string;
  readonly headers: SessionAuthorizationHeaders;
  readonly ownerUserId: string | undefined;
}) =>
  Effect.gen(function* () {
    const principal = yield* authorize({
      headers: input.headers,
      requiredScope: "session:read",
      assertedOwnerUserId: input.ownerUserId,
    });
    const session = yield* requireSession(input.sessionId, principal);
    const reconciled = yield* reconcileSession(session);
    return yield* sessionWithHighWater(reconciled);
  });

export const listSessions = (input: {
  readonly query: ListSessionsQuery;
  readonly headers: SessionAuthorizationHeaders;
}) =>
  Effect.gen(function* () {
    const principal = yield* authorize({
      headers: input.headers,
      requiredScope: "session:read",
      assertedOwnerUserId: input.query.ownerUserId,
    });
    const limitRaw = input.query.limit;
    const limit = limitRaw === undefined ? 50 : Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return yield* new SessionBadRequestError({
        message: "limit must be an integer between 1 and 200.",
      });
    }
    const sessions = yield* WorkspaceSessionRepo;
    const rows = yield* withInternalError(
      sessions.listSessions({
        ownerUserId: principal.ownerUserId,
        ...(principal.workspaceId !== undefined
          ? { workspaceId: principal.workspaceId }
          : input.query.workspaceId === undefined
            ? {}
            : { workspaceId: input.query.workspaceId }),
        ...(input.query.status === undefined ? {} : { statuses: [input.query.status] }),
        limit,
      }),
      "Failed to list sessions.",
    );
    const items = yield* Effect.forEach(rows, (row) => sessionWithHighWater(row));
    return { items } satisfies ListSessionsResponse;
  });

const parseSequence = (raw: string | undefined, field: string) => {
  if (raw === undefined) {
    return Effect.succeed(undefined);
  }
  try {
    return Effect.succeed(BigInt(raw));
  } catch {
    return Effect.fail(
      new SessionBadRequestError({ message: `${field} must be a decimal integer.` }),
    );
  }
};

export const getSessionOutput = (input: {
  readonly sessionId: string;
  readonly headers: SessionAuthorizationHeaders;
  readonly query: GetSessionOutputQuery;
}) =>
  Effect.gen(function* () {
    const principal = yield* authorize({
      headers: input.headers,
      requiredScope: "session:read",
      assertedOwnerUserId: input.query.ownerUserId,
    });
    const session = yield* requireSession(input.sessionId, principal);
    const from = yield* parseSequence(input.query.from, "from");
    const limitRaw = input.query.limit;
    const limit = limitRaw === undefined ? 2000 : Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      return yield* new SessionBadRequestError({
        message: "limit must be an integer between 1 and 10000.",
      });
    }

    const query = yield* TelemetryQuery;
    const chunks = yield* withInternalError(
      query.scrollbackChunks(session.runId, STREAM_KIND_PTY_OUTPUT, {
        ...(from === undefined ? {} : { fromSequence: from }),
        limit,
      }),
      "Failed to read session output.",
    );

    const reconciled = yield* reconcileSession(session);
    const last = chunks[chunks.length - 1];
    const nextFrom = last === undefined ? (from ?? 0n) : last.sequence + 1n;

    return {
      sessionId: session.id,
      chunks: chunks.map((chunk) => ({
        sequence: chunk.sequence.toString(),
        dataBase64: Buffer.from(chunk.bytes).toString("base64"),
      })),
      nextFrom: nextFrom.toString(),
      status: reconciled.status,
    } satisfies SessionOutputResponse;
  });

/** Shared body for the input/resize/signal verbs: authorize, load, require live, run on daemon. */
const withLiveSession = <A, E>(
  input: {
    readonly sessionId: string;
    readonly headers: SessionAuthorizationHeaders;
    readonly assertedOwnerUserId: string | undefined;
    readonly requiredScope: AccessTokenScope;
  },
  f: (
    daemon: DaemonConnection,
    session: WorkspaceSession & { daemonSessionId: string; daemonProcessId: string },
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const principal = yield* authorize({
      headers: input.headers,
      requiredScope: input.requiredScope,
      assertedOwnerUserId: input.assertedOwnerUserId,
    });
    const session = yield* requireSession(input.sessionId, principal);
    if (
      session.status !== "running" ||
      session.daemonSessionId === null ||
      session.daemonProcessId === null
    ) {
      return yield* new SessionConflictError({
        message: `Session ${session.id} is not running (status: ${session.status}).`,
      });
    }
    const target = yield* resolveDaemonTarget(session.workspaceId);
    if (target === undefined) {
      yield* reconcileSession(session).pipe(Effect.ignore);
      return yield* new SessionConflictError({
        message: "The workspace runtime is not available.",
      });
    }
    return yield* withDaemon(target, (daemon) =>
      f(daemon, session as WorkspaceSession & { daemonSessionId: string; daemonProcessId: string }),
    ).pipe(
      Effect.catchIf(isDaemonSessionGone, () =>
        reconcileSession(session).pipe(
          Effect.ignore,
          Effect.andThen(
            new SessionConflictError({
              message: "The PTY session is no longer live on the daemon.",
            }),
          ),
        ),
      ),
      Effect.mapError((error) =>
        error instanceof SessionConflictError ||
        error instanceof SessionBadRequestError ||
        error instanceof SessionInternalServerError
          ? error
          : new SessionBadGatewayError({
              message: `Daemon request failed: ${toErrorMessage(error, "daemon error")}`,
            }),
      ),
    );
  });

export const sendSessionInput = (input: {
  readonly sessionId: string;
  readonly headers: SessionAuthorizationHeaders;
  readonly payload: SessionInputRequest;
}) =>
  Effect.gen(function* () {
    const data = Buffer.from(input.payload.dataBase64, "base64");
    yield* withLiveSession(
      {
        sessionId: input.sessionId,
        headers: input.headers,
        assertedOwnerUserId: input.payload.ownerUserId,
        requiredScope: "session:input",
      },
      (daemon, session) => daemon.writeSessionInput(session.daemonSessionId, new Uint8Array(data)),
    );
    return { ok: true };
  });

export const resizeSession = (input: {
  readonly sessionId: string;
  readonly headers: SessionAuthorizationHeaders;
  readonly payload: SessionResizeRequest;
}) =>
  Effect.gen(function* () {
    yield* withLiveSession(
      {
        sessionId: input.sessionId,
        headers: input.headers,
        assertedOwnerUserId: input.payload.ownerUserId,
        requiredScope: "session:input",
      },
      (daemon, session) =>
        Effect.gen(function* () {
          if (session.mode === "pipe") {
            return yield* new SessionBadRequestError({
              message: "A pipe-mode session has no terminal to resize.",
            });
          }
          yield* daemon.resizePty(session.daemonSessionId, input.payload.cols, input.payload.rows);
        }),
    );
    const sessions = yield* WorkspaceSessionRepo;
    yield* withInternalError(
      sessions.updateSessionSize({
        id: input.sessionId,
        cols: input.payload.cols,
        rows: input.payload.rows,
      }),
      "Failed to record the session size.",
    );
    return { ok: true };
  });

export const signalSession = (input: {
  readonly sessionId: string;
  readonly headers: SessionAuthorizationHeaders;
  readonly payload: SessionSignalRequest;
}) =>
  Effect.gen(function* () {
    yield* withLiveSession(
      {
        sessionId: input.sessionId,
        headers: input.headers,
        assertedOwnerUserId: input.payload.ownerUserId,
        requiredScope: "session:input",
      },
      (daemon, session) => daemon.signalProcess(session.daemonProcessId, input.payload.signal),
    );
    return { ok: true };
  });

export const closeSession = (input: {
  readonly sessionId: string;
  readonly headers: SessionAuthorizationHeaders;
  readonly payload: CloseSessionRequest;
}) =>
  Effect.gen(function* () {
    const principal = yield* authorize({
      headers: input.headers,
      requiredScope: "workspace:exec",
      assertedOwnerUserId: input.payload.ownerUserId,
    });
    const session = yield* requireSession(input.sessionId, principal);
    if (session.status === "exited" || session.status === "failed") {
      return yield* sessionWithHighWater(session);
    }

    const target = yield* resolveDaemonTarget(session.workspaceId);
    if (target !== undefined && session.daemonSessionId !== null) {
      const daemonSessionId = session.daemonSessionId;
      yield* withDaemon(target, (daemon) => daemon.closeSession(daemonSessionId)).pipe(
        // Already gone daemon-side is success for a close.
        Effect.catchIf(isDaemonSessionGone, () => Effect.void),
        Effect.mapError(
          (error) =>
            new SessionBadGatewayError({
              message: `Failed to close the PTY session: ${toErrorMessage(error, "daemon error")}`,
            }),
        ),
      );
    }

    // Wait for the settle evidence to be ingested: `processExited` arriving guarantees every
    // prior output byte is durably recorded (the log is ordered), so a reader that reattaches
    // after close still sees byte-exact history.
    const deadline = Date.now() + EXIT_WAIT_TIMEOUT_MS;
    for (;;) {
      const reconciled = yield* reconcileSession(session);
      if (reconciled.status === "exited" || reconciled.status === "failed") {
        return yield* sessionWithHighWater(reconciled);
      }
      if (Date.now() > deadline) {
        // Best-effort settle: the evidence never arrived; mark the session closed anyway.
        const sessions = yield* WorkspaceSessionRepo;
        const runs = yield* RunRepo;
        const updated = yield* withInternalError(
          sessions.markSessionEnded({ id: session.id, status: "exited" }),
          "Failed to settle session.",
        );
        yield* withInternalError(
          runs.markRunCompleted({ id: session.runId, exitCode: 0 }),
          "Failed to settle session run.",
        );
        return yield* sessionWithHighWater(updated ?? session);
      }
      yield* delay(EXIT_WAIT_INTERVAL_MS);
    }
  });
