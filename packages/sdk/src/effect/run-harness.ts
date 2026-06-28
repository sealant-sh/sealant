/**
 * `harness.run()` — the one-shot host-local execution path.
 *
 * Registered into the Sandbox facade (avoiding a static import cycle). For a run it:
 *   1. resolves the sandbox's docker container (the only bridgeable adapter today);
 *   2. registers a `run` row via the control plane (`POST /v1/runs`) and marks it running;
 *   3. execs the harness over the daemon control connection and drains the telemetry stream up to (and
 *      including) the harness's own `processExited`, persisting it batch-by-batch via the
 *      {@link TelemetrySink}. The harness exiting ends the stream NATURALLY — the final batch flushes
 *      and the epoch closes cleanly. Crucially it does NOT shut the daemon down: sealantd is PID 1, so
 *      shutting it down would collapse the whole sandbox (and race the control connection into a hard
 *      "connection closed"). The sandbox stays alive after the run.
 *   4. captures the file changes with `git diff` (a separate, un-recorded exec);
 *   5. marks the run completed/failed by exit code and returns a `Run` whose record is now queryable.
 */
import {
  execInSandbox,
  SealantRuntime,
  sealantTargetForDockerContainer,
  type SealantTarget,
} from "@sealant/sandboxes";
import { normalizeEnvelope, TelemetrySink } from "@sealant/telemetry";
import { Effect, Schedule, Stream } from "effect";

import { SealantError } from "../errors.js";
import type { SdkContext } from "../facade/context.js";
import { makeRun, type RunChangesData } from "../facade/run.js";
import type { RunHarnessFn, SandboxInit } from "../facade/sandbox.js";
import type { HarnessRunCommand, Run, RunFileChange } from "../types.js";
import { createRunOp, getRunOp, getSandboxOp, updateRunOp } from "./operations.js";

const WORKDIR = "/sandbox/repo";
const BATCH_SIZE = 256;
const BATCH_WINDOW = "250 millis";
// The docker-exec/socat control bridge can fail to establish while a freshly-launched sandbox's
// sealantd is still bringing its control socket up (and under docker-daemon load). Retry with a
// SPACED window (~4s) rather than immediately, so the window covers daemon readiness; each attempt
// spawns a fresh `docker exec` bridge, which is the actual remedy.
const BRIDGE_RETRY = { schedule: Schedule.spaced("400 millis"), times: 10 };

const parseNameStatus = (output: string): RunFileChange[] => {
  const files: RunFileChange[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const code = parts[0] ?? "";
    const change: RunFileChange["change"] =
      code.startsWith("A")
        ? "added"
        : code.startsWith("D")
          ? "deleted"
          : code.startsWith("R")
            ? "renamed"
            : "modified";
    const path = parts.slice(1).join(" ");
    if (path.length > 0) {
      files.push({ path, change });
    }
  }
  return files;
};

// git diff capture is idempotent (`git add -A` + read-only `diff`), so the whole exec is safely retried.
const shellExec = (target: SealantTarget, script: string) =>
  execInSandbox(target, { executable: "sh", args: ["-lc", script], cwd: WORKDIR }).pipe(
    Effect.retry(BRIDGE_RETRY),
  );

/**
 * Execs the harness and records its telemetry, bounded to the harness process. Returns the exit code.
 * The event stream is drained `takeUntil` the harness's `processExited` — a natural end that flushes
 * the final batch and closes the epoch cleanly, WITHOUT shutting the daemon down.
 */
const captureHarnessRun = (runId: string, target: SealantTarget, command: HarnessRunCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* SealantRuntime;
      const sink = yield* TelemetrySink;

      // Connect, prove liveness (health), and START the harness — retrying transient bridge flakes
      // as one unit. `exec` resolves the instant the process is ACCEPTED, so a "connection closed"
      // here means the harness never started: retrying is safe (no double-run). Once we hold an
      // ExecAccepted the connection is live, so the drain below is not retried (a later close ends
      // the event stream cleanly). Failed attempts' bridges release at scope close.
      const { session, runtimeId, accepted } = yield* runtime.connect(target).pipe(
        Effect.flatMap((connected) =>
          Effect.gen(function* () {
            const health = yield* connected.health;
            const started = yield* connected.exec({
              executable: command.executable,
              args: command.args,
              cwd: WORKDIR,
              stdin: false,
            });
            return { session: connected, runtimeId: health.runtimeId, accepted: started };
          }),
        ),
        Effect.retry(BRIDGE_RETRY),
      );

      yield* sink.openEpoch({ runId, runtimeId, schemaVersion: 0 });

      let exitCode = -1;
      const drain = session.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.payload.case === "processExited" && event.processId === accepted.processId,
        ),
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.payload.case === "processExited" && event.processId === accepted.processId) {
              exitCode = event.payload.value.exitCode ?? -1;
            }
          }),
        ),
        Stream.groupedWithin(BATCH_SIZE, BATCH_WINDOW),
        Stream.mapEffect((batch) =>
          sink.appendBatch({ runId, runtimeId, batch: Array.from(batch).map(normalizeEnvelope) }),
        ),
        Stream.runDrain,
      );

      // Bracket the epoch so it is ALWAYS closed — on success, failure, OR interruption. If the drain
      // ended WITHOUT the harness's own processExited (a dropped bridge), exitCode stays -1: flag the
      // epoch suspicious + transport-close so a truncated capture isn't recorded as a clean, complete
      // run (audit finding). A clean harness exit closes as a non-suspicious stream-end.
      yield* drain.pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            sink
              .closeEpoch({
                runId,
                runtimeId,
                closeReason: exitCode === -1 ? "transport-close" : "stream-end",
                suspicious: exitCode === -1,
              })
              .pipe(Effect.ignore),
          ),
        ),
      );
      return exitCode;
    }),
  );

const runHarnessEffect = (ctx: SdkContext, init: SandboxInit, prompt: string) =>
  Effect.gen(function* () {
    const harness = init.harness;
    if (harness === undefined) {
      return yield* Effect.fail(
        new SealantError(
          "This sandbox handle has no harness; use the handle returned by sandboxes.create().",
          { code: "harness_required" },
        ),
      );
    }

    // 1. resolve the docker container backing the sandbox.
    const details = yield* getSandboxOp(init.id);
    const resourceId = details.runtime?.resourceId;
    if (details.runtime?.adapter !== "docker" || resourceId === undefined) {
      return yield* Effect.fail(
        new SealantError(
          `Sandbox ${init.id} is not a running docker sandbox; run() requires the docker-exec transport.`,
          { code: "runtime_not_bridgeable" },
        ),
      );
    }
    const target = sealantTargetForDockerContainer(resourceId);

    // 2. register the run and mark it running.
    const created = yield* createRunOp({
      sandboxId: init.id,
      ownerUserId: ctx.config.hostLocal.ownerUserId,
      harnessId: harness.id,
      mode: "one-shot",
      prompt,
    });
    const runId = created.runId;
    yield* updateRunOp(runId, { status: "running" });

    const command = harness.buildRunCommand(prompt);

    // 3-5. Run + record the harness, capture changes, reconcile terminal status, return the run.
    const produce = Effect.gen(function* () {
      const exitCode = yield* captureHarnessRun(runId, target, command);

      const diff = yield* shellExec(
        target,
        `git add -A >/dev/null 2>&1; git --no-pager diff --cached`,
      );
      const names = yield* shellExec(target, `git --no-pager diff --cached --name-status`);

      yield* updateRunOp(
        runId,
        exitCode === 0
          ? { status: "completed", exitCode: 0 }
          : { status: "failed", exitCode },
      );
      const settled = yield* getRunOp(runId);
      const changes: RunChangesData = { files: parseNameStatus(names.stdout), diff: diff.stdout };
      return makeRun(ctx, { wire: settled, changes });
    });

    // Never leave the run pinned in "running": reconcile to a terminal status on ANY abnormal exit
    // — `onError` fires on typed failures AND defects (e.g. a "connection closed" surfaced as a die).
    return yield* produce.pipe(
      Effect.onError(() =>
        updateRunOp(runId, {
          status: "failed",
          errorMessage: "Harness run failed before completion.",
        }).pipe(Effect.ignore),
      ),
    );
  });

/** The host-local `harness.run()` implementation, registered into the Sandbox facade by the client. */
export const runHarness: RunHarnessFn = (ctx, init, prompt): Promise<Run> =>
  ctx.runtime.run(runHarnessEffect(ctx, init, prompt));
