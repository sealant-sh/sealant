/**
 * Derive the reachable sealantd control target for a persisted runtime instance, then drive a real
 * control session through `SealantRuntime`.
 *
 * Two layers live here:
 *
 *   1. Pure target derivation (`sealantTargetForDockerContainer` /
 *      `sealantTargetForRuntimeInstance`). Docker: prefers the persisted `unix://` endpoint and
 *      falls back to the container `resourceId` plus docker-exec. Kubernetes: the persisted
 *      `wss://` endpoint plus the caller's client TLS material. No I/O, fully unit testable.
 *
 *   2. A worker-consumable Effect helper (`execInWorkspace`). This is the realistic "what a worker
 *      calls" API: hand it a target + a command, get back decoded stdout + the exit code. It owns the
 *      `Scope` (so the transport/client are torn down on completion), runs the process through
 *      `SealantSession.exec`, and drains the telemetry `Stream` — accumulating STDOUT `ioChunk`
 *      bytes — until `processExited`.
 */
import { StreamKind } from "@sealant/runtime-client";
import type { EventEnvelope } from "@sealant/runtime-protocol";
import { Effect, Stream } from "effect";

import {
  SealantRuntime,
  type SealantError,
  type SealantTarget,
  type SealantWebSocketClientTls,
} from "./runtime.js";

/** Default control socket path the workspace entrypoint launches sealantd on (matches boot.ts). */
export const DEFAULT_CONTROL_SOCKET_PATH = "/run/sealant/control.sock";

/**
 * Minimal projection of the persisted `WorkspaceRuntimeInstance` row this seam needs. Declared
 * structurally (rather than importing the drizzle row type) so the pure helper stays dependency-light
 * and trivially unit-testable; the real `WorkspaceRuntimeInstance` from `@sealant/db` is assignable to
 * it (`adapter` and `resourceId` are both nullable on the row).
 */
export interface RuntimeInstanceTargetSource {
  readonly adapter: "docker" | "k8s" | "k3s" | null;
  readonly resourceId: string | null;
  readonly endpoint: string | null;
}

/** How a consumer reaches each runtime family; everything optional so Docker needs nothing. */
export interface SealantTargetDerivationOptions {
  /** Control socket path inside a Docker container (docker-exec fallback). */
  readonly socketPath?: string;
  /**
   * Client mTLS material for `wss://` endpoints (Kubernetes). Without it a Kubernetes instance
   * yields no target — the consumer is not configured to authenticate to the daemon.
   */
  readonly websocketTls?: SealantWebSocketClientTls;
}

const UNIX_ENDPOINT_PREFIX = "unix://";
const WSS_ENDPOINT_PREFIX = "wss://";

/**
 * Derives the docker-exec target for a container id. Pure. `containerId` is the `resourceId` returned
 * by `DockerRuntimeAdapter.launch` (the `docker run -d` container id). `socketPath` defaults to the
 * entrypoint's control socket and can be overridden for non-default boots.
 */
export const sealantTargetForDockerContainer = (
  containerId: string,
  socketPath: string = DEFAULT_CONTROL_SOCKET_PATH,
): SealantTarget => ({
  kind: "docker-exec",
  containerId,
  socketPath,
});

/**
 * Derives a target from a persisted runtime instance. Pure.
 *
 *  - Docker: prefers the persisted `unix://` host socket, falls back to docker-exec on the
 *    container `resourceId`.
 *  - Kubernetes (`k8s` / `k3s`): the persisted `wss://` endpoint, reachable only with client TLS
 *    material in `options.websocketTls`.
 *
 * Returns `undefined` when the instance cannot be addressed with what the caller has. The second
 * parameter accepts the legacy bare `socketPath` string for source compatibility.
 */
export const sealantTargetForRuntimeInstance = (
  instance: RuntimeInstanceTargetSource,
  options: string | SealantTargetDerivationOptions = {},
): SealantTarget | undefined => {
  const resolved: SealantTargetDerivationOptions =
    typeof options === "string" ? { socketPath: options } : options;
  const socketPath = resolved.socketPath ?? DEFAULT_CONTROL_SOCKET_PATH;
  const endpoint = instance.endpoint?.trim();

  switch (instance.adapter) {
    case "docker": {
      if (endpoint?.startsWith(UNIX_ENDPOINT_PREFIX)) {
        const endpointSocketPath = endpoint.slice(UNIX_ENDPOINT_PREFIX.length);
        if (endpointSocketPath.length > 0) {
          return { kind: "unix-socket", socketPath: endpointSocketPath };
        }
      }
      if (instance.resourceId === null || instance.resourceId.length === 0) {
        return undefined;
      }
      return sealantTargetForDockerContainer(instance.resourceId, socketPath);
    }
    case "k8s":
    case "k3s": {
      if (
        endpoint === undefined ||
        !endpoint.startsWith(WSS_ENDPOINT_PREFIX) ||
        resolved.websocketTls === undefined
      ) {
        return undefined;
      }
      return { kind: "websocket", url: endpoint, tls: resolved.websocketTls };
    }
    case null:
      return undefined;
  }
};

/** Human-readable reason a runtime instance yields no target; for error messages, never thrown. */
export const describeUnaddressableRuntimeInstance = (
  instance: RuntimeInstanceTargetSource,
  options: SealantTargetDerivationOptions = {},
): string => {
  if (instance.adapter === null) {
    return "the runtime instance has no adapter recorded";
  }
  if (instance.adapter === "docker") {
    return "the docker instance has neither a unix:// endpoint nor a container id";
  }
  if (options.websocketTls === undefined) {
    return `the ${instance.adapter} instance needs client TLS material (SEALANT_CONTROL_CLIENT_CERT_PATH / _KEY_PATH / SEALANT_CONTROL_CA_PATH) which is not configured`;
  }
  return `the ${instance.adapter} instance has no wss:// endpoint recorded`;
};

/** A finished one-shot exec: the decoded STDOUT and the process exit code. */
export interface ExecInWorkspaceResult {
  readonly stdout: string;
  readonly exitCode: number;
}

/** Command to run in the workspace (a constrained subset of `SealantExecOptions`). */
export interface ExecInWorkspaceCommand {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

/**
 * The realistic worker-facing API: run one command in a workspace and collect its result.
 *
 * Owns the connection lifecycle (`Effect.scoped` → `SealantRuntime.connect` → exec → drain), so the
 * docker-exec transport child and SDK client are released when the returned Effect completes. STDOUT
 * `ioChunk` bytes are accumulated across the telemetry `Stream` and decoded once `processExited`
 * arrives; the exit code comes from that terminal event. Events are filtered to this exec's
 * `processId` so a shared event stream can't cross-contaminate.
 *
 * Requires `SealantRuntime` in context (provide e.g. `SealantRuntimeControlLive`). All failures
 * land on the typed `SealantError` channel.
 */
export const execInWorkspace = (
  target: SealantTarget,
  command: ExecInWorkspaceCommand,
): Effect.Effect<ExecInWorkspaceResult, SealantError, SealantRuntime> =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* SealantRuntime;
      const session = yield* runtime.connect(target);

      const accepted = yield* session.exec({
        executable: command.executable,
        ...(command.args === undefined ? {} : { args: command.args }),
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        stdin: false,
      });

      // Drain telemetry to the terminal `processExited` (inclusive: `takeUntil` keeps the matching
      // event), filtered to this exec so a shared stream can't cross-contaminate. Collect rather than
      // fold-in-place so the accumulation stays referentially transparent.
      const events = yield* session.events.pipe(
        Stream.filter(
          (event: EventEnvelope) =>
            event.processId === undefined || event.processId === accepted.processId,
        ),
        Stream.takeUntil((event: EventEnvelope) => event.payload.case === "processExited"),
        Stream.runCollect,
      );

      const stdoutChunks: Buffer[] = [];
      let exitCode: number | undefined;
      for (const event of events) {
        const payload = event.payload;
        if (
          payload.case === "ioChunk" &&
          payload.value.stream === StreamKind.STDOUT &&
          payload.value.content !== undefined
        ) {
          stdoutChunks.push(Buffer.from(payload.value.content));
        } else if (payload.case === "processExited") {
          exitCode = payload.value.exitCode;
        }
      }

      return {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        // `processExited` is the only path out of `takeUntil`; the fallback only guards a stream that
        // ended early (e.g. daemon close), which surfaces as a non-zero sentinel rather than a throw.
        exitCode: exitCode ?? -1,
      };
    }),
  );
