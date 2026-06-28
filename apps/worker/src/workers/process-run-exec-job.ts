/**
 * Server-side harness run execution — the worker counterpart of what the SDK used to do host-local.
 *
 * Given a run id + the harness command, it: resolves the sandbox's docker container, marks the run
 * running, docker-execs the harness over the sealantd control connection while draining its telemetry
 * into the {@link TelemetrySink} (bounded to the harness process, epoch bracketed + suspicious-flagged
 * on a dropped bridge), captures the git diff, and marks the run completed/failed with the changes.
 *
 * Lives in the worker app (not @sealant/sandboxes) because it needs @sealant/telemetry, which already
 * depends on @sealant/sandboxes — putting it in sandboxes would be a dependency cycle.
 */
import {
  type DB,
  type RunFileChange,
  RunRepo,
  RunRepoLive,
  SandboxRepo,
  SandboxRepoLive,
  SandboxRuntimeInstanceRepo,
  SandboxRuntimeInstanceRepoLive,
  SealantDB,
} from "@sealant/db";
import {
  execInSandbox,
  type RunExecCommand,
  SealantRuntime,
  SealantRuntimeDockerExecLive,
  sealantTargetForDockerContainer,
  type SealantTarget,
} from "@sealant/sandboxes";
import {
  InlineByteaArtifactStoreLive,
  normalizeEnvelope,
  PostgresTelemetrySinkLive,
  TelemetrySink,
} from "@sealant/telemetry";
import { Effect, Layer, Schedule, Stream } from "effect";

const WORKDIR = "/sandbox/repo";
const BATCH_SIZE = 256;
const BATCH_WINDOW = "250 millis";
// The docker-exec/socat bridge can flake while a freshly-launched daemon's socket comes up; retry the
// connect+health+exec unit with a spaced window. exec resolves on process-accept, so retry can't
// double-run the harness.
const BRIDGE_RETRY = { schedule: Schedule.spaced("400 millis"), times: 10 };

export interface ProcessRunExecJobOptions {
  readonly runId: string;
  readonly command: RunExecCommand;
  readonly db: DB;
}

const parseNameStatus = (output: string): RunFileChange[] => {
  const files: RunFileChange[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const code = parts[0] ?? "";
    const change: RunFileChange["change"] = code.startsWith("A")
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

const shellExec = (target: SealantTarget, script: string) =>
  execInSandbox(target, { executable: "sh", args: ["-lc", script], cwd: WORKDIR }).pipe(
    Effect.retry(BRIDGE_RETRY),
  );

/** Execs the harness and records its telemetry, bounded to the harness process. Returns the exit code. */
const captureRun = (runId: string, target: SealantTarget, command: RunExecCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* SealantRuntime;
      const sink = yield* TelemetrySink;

      const { session, runtimeId, accepted } = yield* runtime.connect(target).pipe(
        Effect.flatMap((connected) =>
          Effect.gen(function* () {
            const health = yield* connected.health;
            const started = yield* connected.exec({
              executable: command.executable,
              args: [...command.args],
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

const resolveContainerResourceId = (runId: string) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const sandboxes = yield* SandboxRepo;
    const runtimeInstances = yield* SandboxRuntimeInstanceRepo;

    const run = yield* runs.getRunById(runId);
    if (run === undefined) {
      return yield* Effect.fail(new Error(`Run not found: ${runId}`));
    }
    const sandbox = yield* sandboxes.getSandboxById(run.sandboxId);
    if (sandbox === undefined || sandbox.latestRunId === null) {
      return yield* Effect.fail(
        new Error(`Sandbox ${run.sandboxId} has no active attempt for run ${runId}.`),
      );
    }
    const instance = yield* runtimeInstances.getRuntimeInstanceByRunId(sandbox.latestRunId);
    if (instance === undefined || instance.adapter !== "docker" || instance.resourceId === null) {
      return yield* Effect.fail(
        new Error(`Sandbox ${run.sandboxId} is not a running docker sandbox for run ${runId}.`),
      );
    }
    return instance.resourceId;
  });

/** The Effect pipeline: resolve container, mark running, exec+capture, diff, mark terminal. */
export const processRunExecJobEffect = (
  options: Omit<ProcessRunExecJobOptions, "db">,
): Effect.Effect<
  void,
  unknown,
  RunRepo | SandboxRepo | SandboxRuntimeInstanceRepo | SealantRuntime | TelemetrySink
> =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const resourceId = yield* resolveContainerResourceId(options.runId);
    const target = sealantTargetForDockerContainer(resourceId);

    yield* runs.markRunRunning({ id: options.runId });

    const produce = Effect.gen(function* () {
      const exitCode = yield* captureRun(options.runId, target, options.command);
      const diff = yield* shellExec(
        target,
        `git add -A >/dev/null 2>&1; git --no-pager diff --cached`,
      );
      const names = yield* shellExec(target, `git --no-pager diff --cached --name-status`);
      const changedFiles = parseNameStatus(names.stdout);
      yield* exitCode === 0
        ? runs.markRunCompleted({ id: options.runId, exitCode: 0, diff: diff.stdout, changedFiles })
        : runs.markRunFailed({ id: options.runId, exitCode, diff: diff.stdout, changedFiles });
    });

    // Never leave the run pinned in "running": reconcile to failed on ANY abnormal exit (onError fires
    // on typed failures AND defects, e.g. a "connection closed" surfaced as a die).
    yield* produce.pipe(
      Effect.onError(() =>
        runs
          .markRunFailed({
            id: options.runId,
            errorMessage: "Harness run failed before completion.",
          })
          .pipe(Effect.ignore),
      ),
    );
  });

/** Thin Promise boundary used by the worker: builds the data-access + runtime + sink layers once. */
export const processRunExecJob = (options: ProcessRunExecJobOptions): Promise<void> => {
  const dbLayer = Layer.succeed(SealantDB, options.db);
  const dataAccessLayer = Layer.mergeAll(
    RunRepoLive,
    SandboxRepoLive,
    SandboxRuntimeInstanceRepoLive,
  ).pipe(Layer.provide(dbLayer));
  const artifactLayer = InlineByteaArtifactStoreLive.pipe(Layer.provide(dbLayer));
  const sinkLayer = PostgresTelemetrySinkLive.pipe(
    Layer.provide(Layer.mergeAll(dbLayer, artifactLayer)),
  );
  const appLayer = Layer.mergeAll(dataAccessLayer, SealantRuntimeDockerExecLive, sinkLayer);

  return Effect.runPromise(processRunExecJobEffect(options).pipe(Effect.provide(appLayer)));
};
