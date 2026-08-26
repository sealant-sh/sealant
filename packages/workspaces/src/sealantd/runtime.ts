/**
 * Idiomatic Effect-TS service wrapping the proven sealantd control transport (P3) and the
 * `@sealant/runtime-client` SDK (P5 of the sealantd -> sealant-core integration).
 *
 * Layering mirrors the established package idiom (see `packages/db/src/repositories/workspaces.ts`,
 * `packages/rabbitmq/src/service.ts`, `packages/source-integrations/src/github/{service,layer}.ts`):
 *   - service contracts are plain `interface`s whose methods return `Effect.Effect<A, Error>`;
 *   - the public handle is a `Context.Tag` class; the implementation is wired with `Layer.effect`;
 *   - failures are `Schema.TaggedError`s funnelled through a `map*Error`/`with*Error` helper so no
 *     raw exceptions escape the Effect channel.
 *
 * What this adds on top of that idiom — and why it is new ground for the package:
 *   - `SealantTransport` is a *pluggable* seam. `open(target)` yields a scoped Node `Duplex` carrying
 *     the length-prefixed protobuf control frames. The live transport connects directly to a
 *     persisted host Unix socket when available and retains the P3
 *     `docker exec -i <ctr> socat - UNIX-CONNECT:<sock>` bridge as a fallback.
 *   - `SealantRuntime.connect(target)` is `Scope`-d: it acquires the transport + a `SealantClient`
 *     via `Effect.acquireRelease`, and the release finalizer closes the client (and, transitively,
 *     the transport child). This is the first scoped-resource service in the package; it follows the
 *     Effect resource-safety contract rather than ad-hoc `try/finally`.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";

import {
  SealantClient,
  SealantError as SdkSealantError,
  type Channel,
} from "@sealant/runtime-client";
import {
  SessionMode as WireSessionMode,
  type Capabilities,
  type EventEnvelope,
  type ExecAccepted,
  type HealthReport,
} from "@sealant/runtime-protocol";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import type * as Scope from "effect/Scope";
import { WebSocket, createWebSocketStream } from "ws";

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

/**
 * Addresses a single sealantd instance for a transport to reach. The shape is a discriminated union
 * so additional transports (ssh-gateway, k8s exec) can introduce their own variants without widening
 * the docker case.
 */
export type SealantTarget =
  | {
      readonly kind: "docker-exec";
      /** Container id or name to `docker exec` into. */
      readonly containerId: string;
      /** Absolute path of the control socket inside the container. */
      readonly socketPath: string;
    }
  | {
      readonly kind: "unix-socket";
      /** Absolute path of a control socket exposed on this host. */
      readonly socketPath: string;
    }
  | {
      /**
       * A WebSocket control frontend carrying the exact length-prefixed protobuf byte stream as
       * binary messages. Two authentication shapes, at least one REQUIRED — an unauthenticated
       * control connection is never opened:
       *
       *  - `tls`: client mTLS against sealantd's native `wss://…/control` frontend (Kubernetes,
       *    cluster-internal CA).
       *  - `auth`: a bearer token presented on the upgrade request, for endpoints where a trusted
       *    intermediary terminates auth before the daemon (the Cloudflare bridge Worker); the
       *    server certificate verifies against public PKI (or `tls.caPath` when also set).
       */
      readonly kind: "websocket";
      /** `wss://<service>.<namespace>.svc:<port>/control`, or the bridge's control URL. */
      readonly url: string;
      readonly tls?: SealantWebSocketClientTls | undefined;
      readonly auth?: { readonly bearerToken: string } | undefined;
    };

/** Client-side mTLS material for the `websocket` target: PEM file paths, read at open time. */
export interface SealantWebSocketClientTls {
  /** CA bundle that signed the workspace server certificate. */
  readonly caPath: string;
  /** Control-plane client certificate (must carry the `clientAuth` EKU). */
  readonly certPath: string;
  readonly keyPath: string;
  /** Overrides SNI/verification name; defaults to the URL host. */
  readonly servername?: string;
}

// ---------------------------------------------------------------------------------------------
// Errors (Schema.TaggedError — matches packages/db + source-integrations idiom)
// ---------------------------------------------------------------------------------------------

/** Operations surfaced on the typed error channel, kept constrained for consistent metadata. */
const sealantOperationSchema = Schema.Literals([
  "open",
  "connect",
  "health",
  "capabilities",
  "exec",
  "writeStdin",
  "closeStdin",
  "signalProcess",
  "shutdown",
  "events",
  "openSession",
  "closeSession",
  "resizePty",
  "listSessions",
  "writeSessionInput",
  "attachSession",
  "openForward",
  "closeForward",
]);

export type SealantOperation = typeof sealantOperationSchema.Type;

/** The closed set of forward targets: workspace loopback, or the dind sidecar's alias. */
export type SealantForwardHost = "127.0.0.1" | "localhost" | "docker";

/**
 * Forward transport: a TCP byte stream (default), or connected UDP where one
 * channel frame is exactly one datagram — the conduit is message-framed end
 * to end, so boundaries survive the whole relay.
 */
export type SealantForwardProtocol = "tcp" | "udp";

/** Failure opening/holding the underlying transport (spawn failure, child exit, stream error). */
export class TransportError extends Schema.TaggedErrorClass<TransportError>()("TransportError", {
  operation: sealantOperationSchema,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A typed control error returned by the daemon (wraps the SDK's `SealantError`). */
export class SealantControlError extends Schema.TaggedErrorClass<SealantControlError>()(
  "SealantControlError",
  {
    operation: sealantOperationSchema,
    /** Stable daemon error code (numeric `ControlErrorCode`). */
    code: Schema.Number,
    message: Schema.String,
    detailJson: Schema.optional(Schema.String),
  },
) {}

/** Any other unexpected defect crossing the SDK boundary, kept on the typed channel. */
export class SealantUnexpectedError extends Schema.TaggedErrorClass<SealantUnexpectedError>()(
  "SealantUnexpectedError",
  {
    operation: sealantOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const sealantErrorSchema = Schema.Union([
  TransportError,
  SealantControlError,
  SealantUnexpectedError,
]);

/** Union of everything that can fail on a `SealantRuntime`/`SealantSession` Effect. */
export type SealantError = typeof sealantErrorSchema.Type;

/**
 * Recognizes the SDK's `SealantError`. Prefers `instanceof`, but falls back to a structural check
 * (an `Error` named `SealantError` carrying a numeric `code`) so the typed control error survives a
 * module-instance boundary — e.g. a bundler/test runner that loads `@sealant/runtime-client` twice,
 * which would otherwise defeat `instanceof` across realms.
 */
const isSdkSealantError = (
  cause: unknown,
): cause is { readonly code: number; readonly message: string; readonly detailJson?: string } => {
  if (cause instanceof SdkSealantError) {
    return true;
  }

  return (
    cause instanceof Error &&
    cause.name === "SealantError" &&
    typeof (cause as { code?: unknown }).code === "number"
  );
};

/**
 * Unwraps Effect's wrapper for a rejected `Effect.tryPromise` (effect 4 tags it `UnknownError`;
 * effect 3 used `UnknownException`) so the original SDK rejection is classified, not the Effect
 * wrapper. The wrapper exposes the original rejection on its `cause` field.
 */
const unwrapEffectCause = (cause: unknown): unknown => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "cause" in cause &&
    (cause as { cause?: unknown }).cause !== undefined
  ) {
    const name = (cause as { name?: unknown }).name;

    if (name === "UnknownError" || name === "UnknownException") {
      return (cause as { cause: unknown }).cause;
    }
  }

  return cause;
};

/** Maps an unknown defect from the SDK boundary onto the typed `SealantError` channel. */
const mapSealantError = (operation: SealantOperation, rawCause: unknown): SealantError => {
  const cause = unwrapEffectCause(rawCause);

  if (
    cause instanceof TransportError ||
    cause instanceof SealantControlError ||
    cause instanceof SealantUnexpectedError
  ) {
    return cause;
  }

  if (isSdkSealantError(cause)) {
    return new SealantControlError({
      operation,
      code: cause.code,
      message: cause.message,
      ...(cause.detailJson === undefined ? {} : { detailJson: cause.detailJson }),
    });
  }

  return new SealantUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

/** Wraps an Effect so any defect is remapped onto the typed `SealantError` channel. */
const withSealantError = <A, R>(
  operation: SealantOperation,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, SealantError, R> => {
  return effect.pipe(Effect.mapError((cause) => mapSealantError(operation, cause)));
};

// ---------------------------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------------------------

/**
 * Pluggable control-channel transport. `open` yields a `Duplex` carrying the raw, length-prefixed
 * protobuf control frames (NOT a PTY: framing is binary). The returned Duplex is `Scope`-bound — its
 * finalizer tears the underlying child/socket down.
 */
export interface SealantTransportService {
  readonly open: (target: SealantTarget) => Effect.Effect<Duplex, TransportError, Scope.Scope>;
}

export class SealantTransport extends Context.Service<SealantTransport, SealantTransportService>()(
  "@sealant/workspaces/SealantTransport",
) {}

/** A live control stream and the teardown operation owned by its enclosing Effect Scope. */
interface OpenTransport {
  readonly duplex: Duplex;
  readonly close: () => void;
}

const openUnixSocket = (socketPath: string) =>
  Effect.callback<OpenTransport, TransportError>((resume) => {
    const socket = createConnection(socketPath);

    const onConnect = () => {
      socket.off("error", onError);
      resume(
        Effect.succeed({
          duplex: socket,
          close: () => socket.destroy(),
        }),
      );
    };
    const onError = (cause: Error) => {
      socket.off("connect", onConnect);
      socket.destroy();
      resume(
        Effect.fail(
          new TransportError({
            operation: "open",
            message: cause.message,
            cause,
          }),
        ),
      );
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);

    return Effect.sync(() => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.destroy();
    });
  });

const openDockerExec = (target: Extract<SealantTarget, { readonly kind: "docker-exec" }>) =>
  Effect.callback<OpenTransport, TransportError>((resume) => {
    const child = spawn(
      "docker",
      ["exec", "-i", target.containerId, "socat", "-", `UNIX-CONNECT:${target.socketPath}`],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const onOpenError = (cause: Error) => {
      resume(
        Effect.fail(
          new TransportError({
            operation: "open",
            message: cause.message,
            cause,
          }),
        ),
      );
    };
    const onSpawn = () => {
      child.off("error", onOpenError);
      const duplex = Duplex.from({
        readable: child.stdout as NodeJS.ReadableStream,
        writable: child.stdin as NodeJS.WritableStream,
      });
      const close = () => {
        duplex.destroy();
        child.kill("SIGKILL");
      };
      child.on("error", () => duplex.destroy());
      child.on("exit", () => duplex.destroy());
      resume(Effect.succeed({ duplex, close }));
    };

    child.once("error", onOpenError);
    child.once("spawn", onSpawn);

    return Effect.sync(() => {
      child.off("error", onOpenError);
      child.off("spawn", onSpawn);
      child.kill("SIGKILL");
    });
  });

/**
 * Open a `wss://` control connection with client-certificate authentication. `createWebSocketStream`
 * yields a Duplex whose bytes are exactly the binary message payloads, so the daemon's framing is
 * untouched and `SealantClient.fromStream` works unchanged. Nothing about the handshake (or its
 * failure) is logged here beyond the error message — TLS material never leaves this closure.
 */
const openWebSocket = (target: Extract<SealantTarget, { readonly kind: "websocket" }>) =>
  Effect.callback<OpenTransport, TransportError>((resume) => {
    let socket: WebSocket;
    try {
      if (target.tls === undefined && target.auth === undefined) {
        throw new Error(
          "Refusing an unauthenticated websocket control connection: the target carries neither client TLS material nor a bearer token.",
        );
      }
      const tls = target.tls;
      socket = new WebSocket(target.url, {
        ...(tls === undefined
          ? {}
          : {
              ca: readFileSync(tls.caPath),
              cert: readFileSync(tls.certPath),
              key: readFileSync(tls.keyPath),
              ...(tls.servername === undefined ? {} : { servername: tls.servername }),
            }),
        ...(target.auth === undefined
          ? {}
          : { headers: { authorization: `Bearer ${target.auth.bearerToken}` } }),
        rejectUnauthorized: true,
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
      });
    } catch (cause) {
      resume(
        Effect.fail(
          new TransportError({
            operation: "open",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        ),
      );
      return Effect.void;
    }

    const onOpenError = (cause: Error) => {
      socket.off("open", onOpen);
      resume(
        Effect.fail(
          new TransportError({
            operation: "open",
            message: cause.message,
            cause,
          }),
        ),
      );
    };
    const onOpen = () => {
      socket.off("error", onOpenError);
      const duplex = createWebSocketStream(socket, { allowHalfOpen: false });
      const close = () => {
        duplex.destroy();
        socket.terminate();
      };
      resume(Effect.succeed({ duplex, close }));
    };

    socket.once("error", onOpenError);
    socket.once("open", onOpen);

    return Effect.sync(() => {
      socket.off("error", onOpenError);
      socket.off("open", onOpen);
      socket.terminate();
    });
  });

const openTarget = (target: SealantTarget) => {
  switch (target.kind) {
    case "unix-socket":
      return openUnixSocket(target.socketPath);
    case "docker-exec":
      return openDockerExec(target);
    case "websocket":
      return openWebSocket(target);
  }
};

const controlTransport: SealantTransportService = {
  open: (target) =>
    withTransportError(
      "open",
      Effect.acquireRelease(openTarget(target), ({ close }) => Effect.sync(close)).pipe(
        Effect.map(({ duplex }) => duplex),
      ),
    ),
};

/**
 * Live control transport: persisted host Unix sockets, docker-exec fallback, and sealantd's
 * secure WebSocket frontend. One layer for every runtime adapter.
 */
export const ControlTransportLive = Layer.succeed(SealantTransport, controlTransport);

/** Narrower error wrapper for transport-only failures (defect -> typed `TransportError`). */
function withTransportError<A, R>(
  operation: SealantOperation,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, TransportError, R> {
  return effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof TransportError
        ? cause
        : new TransportError({
            operation,
            message: cause instanceof Error ? cause.message : `${operation} failed.`,
            cause,
          }),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Runtime service
// ---------------------------------------------------------------------------------------------

/** Options accepted by `SealantSession.exec` (mirrors the SDK's `ExecOptions`). */
export interface SealantExecOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly executionId?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly stdin?: boolean;
  readonly timeoutMillis?: number;
  readonly background?: boolean;
}

/** Options for opening a PTY session (mirrors the daemon's `OpenSessionArgs`). */
/**
 * How a session's leader is wired: a pseudoterminal (interactive shells, TUIs) or plain stdio
 * pipes with no tty (protocol processes such as JSON-RPC servers — stdout is the recorded output,
 * stderr is recorded as diagnostics only, `writeSessionInput` feeds stdin, resize is rejected).
 */
export type SealantSessionMode = "pty" | "pipe";

export interface SealantOpenSessionOptions {
  /** The run id, threaded as the daemon execution id so the session's events attribute to it. */
  readonly executionId?: string;
  /** The program the session runs (defaults to the daemon's configured shell, `/bin/bash`). */
  readonly shell?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  readonly term?: string;
  /** Leader wiring; defaults to `pty`. */
  readonly mode?: SealantSessionMode;
}

const toWireSessionMode = (mode: SealantSessionMode | undefined): WireSessionMode =>
  mode === "pipe" ? WireSessionMode.PIPE : WireSessionMode.PTY;

const fromWireSessionMode = (mode: WireSessionMode): SealantSessionMode =>
  mode === WireSessionMode.PIPE ? "pipe" : "pty";

/** The daemon's accepted-session handle. */
export interface SealantSessionOpened {
  readonly sessionId: string;
  readonly processId: string;
  readonly pid: number;
}

/** One live PTY session as reported by `listSessions`. */
export interface SealantSessionSummary {
  readonly sessionId: string;
  readonly processId: string;
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  readonly mode: SealantSessionMode;
  readonly executionId?: string;
}

/**
 * A live, connected control session against one sealantd instance. All methods are
 * exception-free: failures land on the typed `SealantError` channel. The session's lifetime is the
 * `Scope` it was opened in — when that scope closes, the client and transport are released.
 */
export interface SealantSession {
  /** Round-trips a health probe; proves the control channel is live. */
  readonly health: Effect.Effect<HealthReport, SealantError>;
  /** Returns the daemon's advertised capabilities. */
  readonly capabilities: Effect.Effect<Capabilities, SealantError>;
  /** Starts a process; resolves with the accepted handle (processId, pid, ...). */
  readonly exec: (options: SealantExecOptions) => Effect.Effect<ExecAccepted, SealantError>;
  /** Writes bytes to a process's stdin. */
  readonly writeStdin: (processId: string, data: Uint8Array) => Effect.Effect<void, SealantError>;
  /** Half-close a process's stdin so `base64 -d`-style readers see EOF. */
  readonly closeStdin: (processId: string) => Effect.Effect<void, SealantError>;
  /** Delivers a signal to a process. */
  readonly signalProcess: (processId: string, signal: number) => Effect.Effect<void, SealantError>;
  /**
   * Opens a PTY-backed session. The session is DAEMON-OWNED, not connection-owned: it keeps
   * running when this control connection closes (only stream *attachments* are connection-scoped),
   * which is what lets the control plane drive sessions over short-lived per-request connections.
   */
  readonly openSession: (
    options: SealantOpenSessionOptions,
  ) => Effect.Effect<SealantSessionOpened, SealantError>;
  /** Closes a PTY session (hangs up the terminal; the daemon reaps the process group). */
  readonly closeSession: (sessionId: string) => Effect.Effect<void, SealantError>;
  /** Resizes a session's PTY. */
  readonly resizePty: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, SealantError>;
  /** Lists the live PTY sessions on this daemon. */
  readonly listSessions: Effect.Effect<readonly SealantSessionSummary[], SealantError>;
  /** Writes keystrokes to a session's PTY input. */
  readonly writeSessionInput: (
    sessionId: string,
    data: Uint8Array,
  ) => Effect.Effect<void, SealantError>;
  /**
   * Attaches a reliable output channel to a PTY session: byte-exact replay
   * from `fromSequence`, then live output, as one `AsyncIterable<Uint8Array>`.
   * The channel is CONNECTION-scoped — it dies with this control connection —
   * which is exactly what a held attach (WS bridge) wants: one connection, one
   * channel, torn down together.
   */
  readonly attachSession: (
    sessionId: string,
    options?: { readonly fromSequence?: bigint },
  ) => Effect.Effect<Channel, SealantError>;
  /**
   * Opens a raw TCP (or connected-UDP) forward INSIDE the workspace and returns its byte
   * channel. The target host is a CLOSED workspace-private set — the
   * container's own loopback, or `docker`: the workspace-scoped dind
   * sidecar's network alias, where inner `docker compose` publishes its
   * ports. Never an arbitrary host: that would be an in-container SSRF
   * primitive. Like an attach, the channel is CONNECTION-scoped: dropping
   * this control connection reaps the forward's socket and pumps daemon-side.
   */
  readonly openForward: (
    port: number,
    host?: SealantForwardHost,
    protocol?: SealantForwardProtocol,
  ) => Effect.Effect<{ readonly channelId: string; readonly channel: Channel }, SealantError>;
  /** Closes a forward explicitly — cheaper than waiting for connection teardown. */
  readonly closeForward: (channelId: string) => Effect.Effect<void, SealantError>;
  /** Asks the daemon to shut down gracefully. */
  readonly shutdown: (graceMillis?: number) => Effect.Effect<void, SealantError>;
  /**
   * Telemetry as an Effect `Stream`. Adapts the SDK's async-iterator (`client.events()`); the SDK
   * ends the iterator on `client.close()`, which becomes normal stream completion here.
   */
  readonly events: Stream.Stream<EventEnvelope, SealantError>;
}

/** The runtime service: opens scoped sessions over whichever `SealantTransport` is provided. */
export interface SealantRuntimeService {
  /**
   * Opens the transport, builds a `SealantClient`, and registers a finalizer (via
   * `Effect.acquireRelease`) that closes the client. Resource-safe: closing the `Scope` releases the
   * client and the transport child in reverse order.
   */
  readonly connect: (
    target: SealantTarget,
  ) => Effect.Effect<SealantSession, SealantError, Scope.Scope>;
}

export class SealantRuntime extends Context.Service<SealantRuntime, SealantRuntimeService>()(
  "@sealant/workspaces/SealantRuntime",
) {}

/**
 * Drives a raw control command through the SDK's low-level `request()` and unwraps the outcome.
 * The session lifecycle commands (openSession/resizePty/closeSession/listSessions) have no typed
 * SDK sugar yet, so this mirrors the unwrap the SDK's typed methods perform internally: a daemon
 * `error` outcome becomes a `SealantControlError`, and a result-case mismatch is unexpected.
 */
const requestResult = (
  client: SealantClient,
  operation: SealantOperation,
  command: Parameters<SealantClient["request"]>[0],
  expect: string | undefined,
): Effect.Effect<unknown, SealantError> =>
  withSealantError(
    operation,
    Effect.tryPromise(async () => {
      const response = await client.request(command);
      const outcome = response.outcome?.outcome;
      if (outcome?.case === "error") {
        const error = outcome.value;
        throw new SealantControlError({
          operation,
          code: error.code,
          message: error.message || `control error (${String(error.code)})`,
          ...(error.detailJson === undefined || error.detailJson === ""
            ? {}
            : { detailJson: error.detailJson }),
        });
      }
      if (outcome?.case !== "ok") {
        throw new Error(`${operation}: control response had no outcome`);
      }
      if (expect === undefined) {
        return undefined;
      }
      const result = outcome.value.result;
      if (result.case !== expect) {
        throw new Error(`${operation}: expected result ${expect}, got ${String(result.case)}`);
      }
      return (result as { value: unknown }).value;
    }),
  );

const toEnvVars = (env: Readonly<Record<string, string>> | undefined) =>
  Object.entries(env ?? {}).map(([key, value]) => ({ key, value }));

/** Builds the per-connection session handle around a connected `SealantClient`. */
const makeSession = (client: SealantClient): SealantSession => ({
  // `health`/`capabilities` are round-trip control requests that REJECT when the connection drops
  // (e.g. a flaky docker-exec bridge). Use `tryPromise` so the rejection lands on the typed
  // `SealantError` channel (retryable) — `Effect.promise` would turn it into a defect that escapes
  // `withSealantError` and bypasses `Effect.retry`.
  health: withSealantError(
    "health",
    Effect.tryPromise(() => client.health()),
  ),

  capabilities: withSealantError(
    "capabilities",
    Effect.tryPromise(() => client.getCapabilities()),
  ),

  exec: (options) =>
    withSealantError(
      "exec",
      Effect.tryPromise(() =>
        client.exec({
          executable: options.executable,
          ...(options.args === undefined ? {} : { args: [...options.args] }),
          ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
          ...(options.timeoutMillis === undefined ? {} : { timeoutMillis: options.timeoutMillis }),
          ...(options.background === undefined ? {} : { background: options.background }),
        }),
      ),
    ),

  writeStdin: (processId, data) =>
    withSealantError(
      "writeStdin",
      Effect.tryPromise(() => client.writeStdin(processId, data)),
    ),

  closeStdin: (processId) =>
    requestResult(
      client,
      "closeStdin",
      { case: "closeStdin", value: { processId } },
      undefined,
    ).pipe(Effect.asVoid),

  signalProcess: (processId, signal) =>
    withSealantError(
      "signalProcess",
      Effect.tryPromise(() => client.signalProcess(processId, signal)),
    ),

  openSession: (options) =>
    requestResult(
      client,
      "openSession",
      {
        case: "openSession",
        value: {
          ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
          ...(options.shell === undefined ? {} : { shell: options.shell }),
          ...(options.args === undefined ? {} : { args: [...options.args] }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: toEnvVars(options.env),
          cols: options.cols,
          rows: options.rows,
          ...(options.term === undefined ? {} : { term: options.term }),
          mode: toWireSessionMode(options.mode),
        },
      },
      "sessionOpened",
    ).pipe(
      Effect.map((value) => {
        const opened = value as { sessionId: string; processId: string; pid: number };
        return { sessionId: opened.sessionId, processId: opened.processId, pid: opened.pid };
      }),
    ),

  closeSession: (sessionId) =>
    requestResult(
      client,
      "closeSession",
      { case: "closeSession", value: { sessionId } },
      undefined,
    ).pipe(Effect.asVoid),

  resizePty: (sessionId, cols, rows) =>
    requestResult(
      client,
      "resizePty",
      { case: "resizePty", value: { sessionId, cols, rows } },
      undefined,
    ).pipe(Effect.asVoid),

  listSessions: requestResult(
    client,
    "listSessions",
    { case: "listSessions", value: {} },
    "sessionList",
  ).pipe(
    Effect.map((value) => {
      const list = value as {
        sessions: Array<{
          sessionId: string;
          processId: string;
          pid: number;
          cols: number;
          rows: number;
          mode: WireSessionMode;
          executionId?: string;
        }>;
      };
      return list.sessions.map((s) => ({
        sessionId: s.sessionId,
        processId: s.processId,
        pid: s.pid,
        cols: s.cols,
        rows: s.rows,
        mode: fromWireSessionMode(s.mode),
        ...(s.executionId === undefined ? {} : { executionId: s.executionId }),
      }));
    }),
  ),

  writeSessionInput: (sessionId, data) =>
    withSealantError(
      "writeSessionInput",
      Effect.tryPromise(() => client.writeSessionInput(sessionId, data)),
    ),

  attachSession: (sessionId, options) =>
    withSealantError(
      "attachSession",
      Effect.tryPromise(() =>
        client.attachSession(
          sessionId,
          options?.fromSequence === undefined ? {} : { fromSequence: options.fromSequence },
        ),
      ),
    ).pipe(Effect.map(({ channel }) => channel)),

  openForward: (port, host, protocol) =>
    withSealantError(
      "openForward",
      Effect.tryPromise(() => client.openForward(host ?? "127.0.0.1", port, undefined, protocol)),
    ).pipe(Effect.map(({ result, channel }) => ({ channelId: result.channelId, channel }))),

  closeForward: (channelId) =>
    withSealantError(
      "closeForward",
      Effect.tryPromise(() => client.closeForward(channelId)),
    ),

  shutdown: (graceMillis) =>
    withSealantError(
      "shutdown",
      Effect.tryPromise(() => client.shutdown(graceMillis)),
    ),

  // `Stream.fromAsyncIterable` pulls one event per `next()` (the SDK iterator is the backpressure
  // boundary). Iterator exhaustion (after `client.close()`) is normal completion; any throw is
  // remapped to the typed channel.
  events: Stream.fromAsyncIterable(client.events(), (cause) => mapSealantError("events", cause)),
});

/** Builds the runtime service around a resolved transport (captured once at layer construction). */
const makeSealantRuntime = (transport: SealantTransportService): SealantRuntimeService => ({
  connect: (target) =>
    Effect.gen(function* () {
      const duplex = yield* transport.open(target);

      // Acquire the SDK client over the transport; release closes it (and lets the transport
      // finalizer kill the child). Resource-safe regardless of how the scope unwinds.
      const client = yield* Effect.acquireRelease(
        withSealantError(
          "connect",
          Effect.sync(() => SealantClient.fromStream(duplex)),
        ),
        (c) => Effect.sync(() => c.close()),
      );

      return makeSession(client);
    }),
});

/**
 * Live `SealantRuntime` layer. Requires a `SealantTransport` in context (e.g.
 * `ControlTransportLive`); the transport is resolved once here, mirroring the
 * `Layer.effect` + `yield* DepTag` idiom in `packages/rabbitmq/src/service.ts`.
 */
export const SealantRuntimeLive = Layer.effect(
  SealantRuntime,
  Effect.gen(function* () {
    const transport = yield* SealantTransport;

    return makeSealantRuntime(transport);
  }),
);

/** Convenience composition: the runtime service wired to the live control transport. */
export const SealantRuntimeControlLive = SealantRuntimeLive.pipe(
  Layer.provideMerge(ControlTransportLive),
);
