/**
 * Server-side harness run execution — the worker counterpart of what the SDK used to do host-local.
 *
 * Given a run id + the harness command, it: resolves the workspace's docker container, marks the run
 * running, docker-execs the harness over the sealantd control connection while draining its telemetry
 * into the {@link TelemetrySink} (bounded to the harness process, epoch bracketed + suspicious-flagged
 * on a dropped bridge), captures the git diff, and marks the run completed/failed with the changes.
 *
 * Lives in the worker app (not @sealant/workspaces) because it needs @sealant/telemetry, which already
 * depends on @sealant/workspaces — putting it in workspaces would be a dependency cycle.
 */
import type { CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  type DB,
  type RunFileChange,
  RunRepo,
  RunRepoLive,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  SealantDB,
} from "@sealant/db";
import {
  InlineByteaArtifactStoreLive,
  normalizeEnvelope,
  PostgresTelemetrySinkLive,
  TelemetrySink,
} from "@sealant/telemetry";
import { newWorkspaceSchema } from "@sealant/validators";
import {
  execInWorkspace,
  type RunExecCommand,
  SealantRuntime,
  SealantRuntimeDockerExecLive,
  sealantTargetForDockerContainer,
  syncBackCodexAuthJson,
  type SealantTarget,
} from "@sealant/workspaces";
import { Effect, Layer, Schedule, Stream } from "effect";

const WORKDIR = "/workspace/repo";
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
  /**
   * Decrypt/encrypt for connected-account credentials; undefined when SEALANT_CREDENTIALS_KEY is
   * not configured. Only exercised by the best-effort codex auth.json sync-back after the run.
   */
  readonly credentialCipher?: CredentialCipherService;
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
  execInWorkspace(target, { executable: "sh", args: ["-lc", script], cwd: WORKDIR }).pipe(
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
              // The run id doubles as the daemon execution id: sealantd stamps it on every event
              // this exec produces, which is what lets ingest attribute them to THIS run (and lets
              // concurrent executions — e.g. an SSH session — keep their events out of it).
              executionId: runId,
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
        // Ingest this run's own events plus untagged daemon events (boot, heartbeats — the
        // pre-attribution behavior, and the compatibility path for daemons that ignore
        // execution_id). Events tagged with a DIFFERENT execution (a concurrent SSH session)
        // belong to that run; the telemetry worker's full-stream ingester attributes them there.
        Stream.filter((event) => event.executionId === undefined || event.executionId === runId),
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
    const workspaces = yield* WorkspaceRepo;
    const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;

    const run = yield* runs.getRunById(runId);
    if (run === undefined) {
      return yield* Effect.fail(new Error(`Run not found: ${runId}`));
    }
    const workspace = yield* workspaces.getWorkspaceById(run.workspaceId);
    if (workspace === undefined || workspace.latestRunId === null) {
      return yield* Effect.fail(
        new Error(`Workspace ${run.workspaceId} has no active attempt for run ${runId}.`),
      );
    }
    const instance = yield* runtimeInstances.getRuntimeInstanceByRunId(workspace.latestRunId);
    if (instance === undefined || instance.adapter !== "docker" || instance.resourceId === null) {
      return yield* Effect.fail(
        new Error(
          `Workspace ${run.workspaceId} is not a running docker workspace for run ${runId}.`,
        ),
      );
    }
    // attemptId keys the stored attempt snapshot, from which the sync-back re-derives the launch
    // blueprint (and thus the workspace's connected-account refs) without new columns.
    return { resourceId: instance.resourceId, attemptId: workspace.latestRunId };
  });

/**
 * Best-effort codex auth.json sync-back after the run (design doc §2 codex / §6): the official
 * Codex CLI in the workspace rotates its refresh token, so the mutated file must be persisted —
 * newest-wins only, and never at the cost of the run result. The blueprint is re-derived from the
 * stored attempt snapshot; workspaces without a codex credentialRef no-op immediately.
 */
const syncBackCodexAuth = (
  attemptId: string,
  target: SealantTarget,
  credentialCipher: CredentialCipherService | undefined,
) =>
  Effect.gen(function* () {
    const attempts = yield* WorkspaceAttemptRepo;
    const snapshot = yield* attempts.getAttemptSnapshotByRunId(attemptId);
    if (snapshot === undefined) {
      return;
    }
    const blueprint = newWorkspaceSchema.parse(snapshot.blueprintPayload);

    yield* syncBackCodexAuthJson({
      blueprint,
      credentialCipher,
      // `$HOME` expands inside the container shell; a missing file surfaces as a non-zero exit.
      readAuthJson: () =>
        execInWorkspace(target, {
          executable: "sh",
          args: ["-c", 'cat "$HOME/.codex/auth.json"'],
        }).pipe(
          Effect.filterOrFail(
            (result) => result.exitCode === 0,
            (result) => new Error(`Reading codex auth.json exited with code ${result.exitCode}.`),
          ),
          Effect.map((result) => result.stdout),
        ),
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Codex auth sync-back failed after run exec; continuing.", cause),
    ),
    Effect.asVoid,
  );

/** The Effect pipeline: resolve container, mark running, exec+capture, diff, mark terminal. */
export const processRunExecJobEffect = (
  options: Omit<ProcessRunExecJobOptions, "db">,
): Effect.Effect<
  void,
  unknown,
  | RunRepo
  | WorkspaceRepo
  | WorkspaceRuntimeInstanceRepo
  | WorkspaceAttemptRepo
  | ConnectedAccountRepo
  | SealantRuntime
  | TelemetrySink
> =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const { resourceId, attemptId } = yield* resolveContainerResourceId(options.runId);
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
    // The codex sync-back runs on EVERY exit path (`ensuring`): the CLI may have rotated its refresh
    // token even when the harness itself failed, and the helper never fails (warnings only).
    yield* produce.pipe(
      Effect.onError(() =>
        runs
          .markRunFailed({
            id: options.runId,
            errorMessage: "Harness run failed before completion.",
          })
          .pipe(Effect.ignore),
      ),
      Effect.ensuring(syncBackCodexAuth(attemptId, target, options.credentialCipher)),
    );
  });

/** Thin Promise boundary used by the worker: builds the data-access + runtime + sink layers once. */
export const processRunExecJob = (options: ProcessRunExecJobOptions): Promise<void> => {
  const dbLayer = Layer.succeed(SealantDB, options.db);
  const dataAccessLayer = Layer.mergeAll(
    RunRepoLive,
    WorkspaceRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceAttemptRepoLive,
    ConnectedAccountRepoLive,
  ).pipe(Layer.provide(dbLayer));
  const artifactLayer = InlineByteaArtifactStoreLive.pipe(Layer.provide(dbLayer));
  const sinkLayer = PostgresTelemetrySinkLive.pipe(
    Layer.provide(Layer.mergeAll(dbLayer, artifactLayer)),
  );
  const appLayer = Layer.mergeAll(dataAccessLayer, SealantRuntimeDockerExecLive, sinkLayer);

  return Effect.runPromise(processRunExecJobEffect(options).pipe(Effect.provide(appLayer)));
};
