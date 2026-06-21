/**
 * Idiomatic Effect-TS service wrapping the proven sealantd control transport (P3) and the
 * `@sealant/runtime-client` SDK (P5 of the sealantd -> sealant-core integration).
 *
 * Layering mirrors the established package idiom (see `packages/db/src/repositories/sandboxes.ts`,
 * `packages/rabbitmq/src/service.ts`, `packages/source-integrations/src/github/{service,layer}.ts`):
 *   - service contracts are plain `interface`s whose methods return `Effect.Effect<A, Error>`;
 *   - the public handle is a `Context.Tag` class; the implementation is wired with `Layer.effect`;
 *   - failures are `Schema.TaggedError`s funnelled through a `map*Error`/`with*Error` helper so no
 *     raw exceptions escape the Effect channel.
 *
 * What this adds on top of that idiom — and why it is new ground for the package:
 *   - `SealantTransport` is a *pluggable* seam. `open(target)` yields a scoped Node `Duplex` carrying
 *     the length-prefixed protobuf control frames. `DockerExecTransport` is the P3
 *     `docker exec -i <ctr> socat - UNIX-CONNECT:<sock>` bridge; an SSH-gateway / k8s exec impl can
 *     slot in later behind the same Tag without touching `SealantRuntime`.
 *   - `SealantRuntime.connect(target)` is `Scope`-d: it acquires the transport + a `SealantClient`
 *     via `Effect.acquireRelease`, and the release finalizer closes the client (and, transitively,
 *     the transport child). This is the first scoped-resource service in the package; it follows the
 *     Effect resource-safety contract rather than ad-hoc `try/finally`.
 */
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";

import { SealantClient, SealantError as SdkSealantError } from "@sealant/runtime-client";
import type {
  Capabilities,
  EventEnvelope,
  ExecAccepted,
  HealthReport,
} from "@sealant/runtime-protocol";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import type * as Scope from "effect/Scope";

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

/**
 * Addresses a single sealantd instance for a transport to reach. The shape is a discriminated union
 * so additional transports (ssh-gateway, k8s exec) can introduce their own variants without widening
 * the docker case.
 */
export type SealantTarget = {
  readonly kind: "docker-exec";
  /** Container id or name to `docker exec` into. */
  readonly containerId: string;
  /** Absolute path of the control socket inside the container. */
  readonly socketPath: string;
};

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
  "signalProcess",
  "shutdown",
  "events",
]);

export type SealantOperation = typeof sealantOperationSchema.Type;

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

export class SealantTransport extends Context.Service<
  SealantTransport,
  SealantTransportService
>()("@sealant/sandboxes/SealantTransport") {}

/**
 * P3 bridge as a transport: `docker exec -i <ctr> socat - UNIX-CONNECT:<sock>`. Deliberately no `-t`
 * (a PTY would mangle the binary framing). `docker exec` runs as root (uid 0), which sealantd's
 * `SO_PEERCRED` check always allows, so no `--user`/allowlist flag is needed. The Scope finalizer
 * SIGKILLs the child so the daemon-side connection is dropped.
 */
const dockerExecTransport: SealantTransportService = {
  open: (target) =>
    withTransportError(
      "open",
      Effect.acquireRelease(
        Effect.sync(() => {
          const child = spawn(
            "docker",
            [
              "exec",
              "-i",
              target.containerId,
              "socat",
              "-",
              `UNIX-CONNECT:${target.socketPath}`,
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );

          // Adapt the child's (readable stdout, writable stdin) into one Duplex transport.
          const duplex = Duplex.from({
            readable: child.stdout as NodeJS.ReadableStream,
            writable: child.stdin as NodeJS.WritableStream,
          });

          return { child, duplex };
        }),
        // Release: drop the transport then kill the bridge child so the daemon sees the disconnect.
        ({ child, duplex }) =>
          Effect.sync(() => {
            duplex.destroy();
            child.kill("SIGKILL");
          }),
      ).pipe(Effect.map(({ duplex }) => duplex)),
    ),
};

/** Live `SealantTransport` layer backed by the docker-exec/socat bridge proven in P3. */
export const DockerExecTransportLive = Layer.succeed(SealantTransport, dockerExecTransport);

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
  /** Delivers a signal to a process. */
  readonly signalProcess: (processId: string, signal: number) => Effect.Effect<void, SealantError>;
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
  readonly connect: (target: SealantTarget) => Effect.Effect<SealantSession, SealantError, Scope.Scope>;
}

export class SealantRuntime extends Context.Service<
  SealantRuntime,
  SealantRuntimeService
>()("@sealant/sandboxes/SealantRuntime") {}

/** Builds the per-connection session handle around a connected `SealantClient`. */
const makeSession = (client: SealantClient): SealantSession => ({
  health: withSealantError("health", Effect.promise(() => client.health())),

  capabilities: withSealantError("capabilities", Effect.promise(() => client.getCapabilities())),

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
    withSealantError("writeStdin", Effect.tryPromise(() => client.writeStdin(processId, data))),

  signalProcess: (processId, signal) =>
    withSealantError(
      "signalProcess",
      Effect.tryPromise(() => client.signalProcess(processId, signal)),
    ),

  shutdown: (graceMillis) =>
    withSealantError("shutdown", Effect.tryPromise(() => client.shutdown(graceMillis))),

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
 * `DockerExecTransportLive`); the transport is resolved once here, mirroring the
 * `Layer.effect` + `yield* DepTag` idiom in `packages/rabbitmq/src/service.ts`.
 */
export const SealantRuntimeLive = Layer.effect(
  SealantRuntime,
  Effect.gen(function* () {
    const transport = yield* SealantTransport;

    return makeSealantRuntime(transport);
  }),
);

/**
 * Convenience composition: the runtime service wired to the docker-exec transport. Equivalent to
 * `SealantRuntimeLive` provided with `DockerExecTransportLive`.
 */
export const SealantRuntimeDockerExecLive = SealantRuntimeLive.pipe(
  Layer.provideMerge(DockerExecTransportLive),
);
