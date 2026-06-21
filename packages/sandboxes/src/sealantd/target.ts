/**
 * The P6 consumer seam: derive a `SealantTarget` from the existing Docker runtime path, then drive a
 * real control session through the P5 `SealantRuntime` service.
 *
 * Two layers live here, both additive and default-off — they introduce no new behavior on the
 * existing sandbox-launch path (`DockerRuntimeAdapter.launch` is unchanged; nothing here is invoked
 * by it):
 *
 *   1. Pure target derivation (`sealantTargetForDockerContainer` /
 *      `sealantTargetForRuntimeInstance`). Maps a docker container id — exactly the `resourceId` that
 *      `DockerRuntimeAdapter.launch` already returns and persists via
 *      `packages/db/.../sandbox-runtime-instances.ts` — onto the `{ kind: "docker-exec";
 *      containerId; socketPath }` shape `SealantRuntime.connect` consumes. No I/O, fully unit
 *      testable.
 *
 *   2. A worker-consumable Effect helper (`execInSandbox`). This is the realistic "what a worker
 *      calls" API: hand it a target + a command, get back decoded stdout + the exit code. It owns the
 *      `Scope` (so the transport/client are torn down on completion), runs the process through
 *      `SealantSession.exec`, and drains the telemetry `Stream` — accumulating STDOUT `ioChunk`
 *      bytes — until `processExited`.
 */
import { StreamKind } from "@sealant/runtime-client";
import type { EventEnvelope } from "@sealant/runtime-protocol";
import { Effect, Stream } from "effect";

import { SealantRuntime, type SealantError, type SealantTarget } from "./runtime.js";

/** Default control socket path the sandbox entrypoint launches sealantd on (matches boot.ts). */
export const DEFAULT_CONTROL_SOCKET_PATH = "/run/sealant/control.sock";

/**
 * Minimal projection of the persisted `SandboxRuntimeInstance` row this seam needs. Declared
 * structurally (rather than importing the drizzle row type) so the pure helper stays dependency-light
 * and trivially unit-testable; the real `SandboxRuntimeInstance` from `@sealant/db` is assignable to
 * it (`adapter` and `resourceId` are both nullable on the row).
 */
export interface RuntimeInstanceTargetSource {
  readonly adapter: "docker" | "k8s" | "k3s" | null;
  readonly resourceId: string | null;
}

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
 * Derives a target from a persisted runtime instance, or `undefined` when the instance can't be
 * reached over the docker-exec transport — i.e. it isn't a docker adapter, or it has no resource id
 * yet (still pending). Only the `docker` adapter is bridgeable today; k8s/k3s return `undefined`
 * until their own transports exist. Pure.
 */
export const sealantTargetForRuntimeInstance = (
  instance: RuntimeInstanceTargetSource,
  socketPath: string = DEFAULT_CONTROL_SOCKET_PATH,
): SealantTarget | undefined => {
  if (instance.adapter !== "docker") {
    return undefined;
  }

  if (instance.resourceId === null || instance.resourceId.length === 0) {
    return undefined;
  }

  return sealantTargetForDockerContainer(instance.resourceId, socketPath);
};

/** A finished one-shot exec: the decoded STDOUT and the process exit code. */
export interface ExecInSandboxResult {
  readonly stdout: string;
  readonly exitCode: number;
}

/** Command to run in the sandbox (a constrained subset of `SealantExecOptions`). */
export interface ExecInSandboxCommand {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

/**
 * The realistic worker-facing API: run one command in a sandbox and collect its result.
 *
 * Owns the connection lifecycle (`Effect.scoped` → `SealantRuntime.connect` → exec → drain), so the
 * docker-exec transport child and SDK client are released when the returned Effect completes. STDOUT
 * `ioChunk` bytes are accumulated across the telemetry `Stream` and decoded once `processExited`
 * arrives; the exit code comes from that terminal event. Events are filtered to this exec's
 * `processId` so a shared event stream can't cross-contaminate.
 *
 * Requires `SealantRuntime` in context (provide e.g. `SealantRuntimeDockerExecLive`). All failures
 * land on the typed `SealantError` channel.
 */
export const execInSandbox = (
  target: SealantTarget,
  command: ExecInSandboxCommand,
): Effect.Effect<ExecInSandboxResult, SealantError, SealantRuntime> =>
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
