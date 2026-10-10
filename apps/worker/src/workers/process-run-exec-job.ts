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
  type RunExecClaim,
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
  TelemetrySinkConflictError,
} from "@sealant/telemetry";
import {
  buildDotfilesCleanupScript,
  dotfilesStagePath,
  execInWorkspace,
  liveDotfilesStageChannel,
  liveProcessUserChannel,
  PROCESS_USER_CAPABILITY,
  processUserCheckOutcome,
  type DotfilesStageChannel,
  type ProcessUserChannel,
  type RunDotfilesApply,
  type RunExecCommand,
  SealantRuntime,
  SealantRuntimeControlLive,
  describeUnaddressableRuntimeInstance,
  sealantTargetForRuntimeInstance,
  type SealantTargetDerivationOptions,
  syncBackWorkspaceCredentials,
  type SealantTarget,
  splitWorkingTreeChanges,
  workingTreeChangesScript,
} from "@sealant/workspaces";
import { Cause, Duration, Effect, Layer, Result, Schedule, Schema, Stream } from "effect";

const WORKDIR = "/workspace/repo";
const BATCH_SIZE = 256;
const BATCH_WINDOW = "250 millis";
// The control transport can flake while a freshly-launched daemon comes up (socat bridge, WSS
// service endpoints); retry the connect+health+exec unit with a spaced window. exec resolves on process-accept, so retry can't
// double-run the harness.
const BRIDGE_RETRY = { schedule: Schedule.spaced("400 millis"), times: 10 };
/** How long `dotfiles.apply` may take to answer: the clone and the apply, not the bootstrap. */
const DOTFILES_APPLY_TIMEOUT = Duration.minutes(10);
/** How long a bootstrap (`./install.sh`) may run before it is stopped and its run fails. */
const DOTFILES_BOOTSTRAP_TIMEOUT = Duration.minutes(30);
const SIGTERM = 15;

export interface ProcessRunExecJobOptions {
  readonly runId: string;
  /** HARNESS framing: one invocation; a nonzero exit marks the run failed. */
  readonly command?: RunExecCommand;
  /**
   * EXEC (check-run) framing: an ordered list; every command executes regardless of exit codes
   * (exit codes are check DATA) and the run completes iff all of them executed and were recorded.
   */
  readonly commands?: readonly RunExecCommand[];
  /** DOTFILES framing: a person's dotfiles applied as their user, the bootstrap recorded. */
  readonly dotfiles?: RunDotfilesApply;
  /** EXEC framing only: every command runs as this Linux user (the API checked the executor). */
  readonly user?: string;
  /** With `user`: the executor (its launch run id) the API checked the user against. */
  readonly checkedExecutorRunId?: string;
  /** For tests: how the user is checked again on another executor (default: the live channel). */
  readonly processUserChannel?: ProcessUserChannel;
  readonly db: DB;
  /**
   * Decrypt/encrypt for connected-account credentials; undefined when SEALANT_CREDENTIALS_KEY is
   * not configured. Only exercised by the best-effort credential sync-backs (codex auth.json,
   * claude session .credentials.json) after the run.
   */
  readonly credentialCipher?: CredentialCipherService;
  /** How this worker reaches each runtime family (client TLS for Kubernetes). */
  readonly targetOptions?: SealantTargetDerivationOptions;
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

/**
 * Runs a script with `sh -c`, not as a login shell. The changes script needs only git and coreutils
 * on the image's own PATH, which every managed image and the custom-base contract provide, and it
 * prints the same bytes either way. A login shell sources `/etc/profile` and `/etc/profile.d` first:
 * in an Arch workspace image `sh -lc true` took 14 ms against 4 ms for `sh -c true` (2026-10-06),
 * and this runs after every exec, before the run is marked finished.
 */
const shellExec = (target: SealantTarget, script: string) =>
  execInWorkspace(target, { executable: "sh", args: ["-c", script], cwd: WORKDIR }).pipe(
    Effect.retry(BRIDGE_RETRY),
  );

/**
 * The executor the run reached does not report `exec.user`: a daemon without it ignores `user` and
 * would start the process as root, so nothing is started. The API checked the executor it saw; this
 * holds when the run reaches another one (a restart in between).
 */
export class ProcessUserUnavailableError extends Schema.TaggedErrorClass<ProcessUserUnavailableError>()(
  "ProcessUserUnavailableError",
  { message: Schema.String },
) {}

/**
 * Execs the harness and records its telemetry, bounded to the harness process. Returns the exit
 * code. With `user`, the daemon starts the process as that Linux user (`ExecArgs.user`), and only a
 * daemon that reports `exec.user` is asked to (one capabilities read on the same connection).
 */
export const captureRun = (
  runId: string,
  target: SealantTarget,
  command: RunExecCommand,
  user?: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* SealantRuntime;
      const sink = yield* TelemetrySink;

      const { session, runtimeId, accepted } = yield* runtime.connect(target).pipe(
        Effect.flatMap((connected) =>
          Effect.gen(function* () {
            const health = yield* connected.health;
            if (user !== undefined) {
              const capabilities = yield* connected.capabilities;
              if (!capabilities.supports.includes(PROCESS_USER_CAPABILITY)) {
                return yield* new ProcessUserUnavailableError({
                  message: `The workspace's sealantd doesn't run processes as another user (it does not report ${PROCESS_USER_CAPABILITY}), so nothing was started as '${user}'.`,
                });
              }
            }
            const started = yield* connected.exec({
              executable: command.executable,
              args: [...command.args],
              // The run id doubles as the daemon execution id: sealantd stamps it on every event
              // this exec produces, which is what lets ingest attribute them to THIS run (and lets
              // concurrent executions — e.g. an SSH session — keep their events out of it).
              executionId: runId,
              cwd: command.cwd ?? WORKDIR,
              stdin: false,
              ...(user === undefined ? {} : { user }),
            });
            return { session: connected, runtimeId: health.runtimeId, accepted: started };
          }),
        ),
        Effect.retry({
          ...BRIDGE_RETRY,
          while: (error) => !(error instanceof ProcessUserUnavailableError),
        }),
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

const resolveRuntimeTarget = (runId: string, targetOptions: SealantTargetDerivationOptions) =>
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
    if (instance === undefined) {
      return yield* Effect.fail(
        new Error(`Workspace ${run.workspaceId} has no runtime instance for run ${runId}.`),
      );
    }
    const target = sealantTargetForRuntimeInstance(instance, targetOptions);
    if (target === undefined) {
      return yield* Effect.fail(
        new Error(
          `Workspace ${run.workspaceId} is not reachable for run ${runId}: ${describeUnaddressableRuntimeInstance(instance, targetOptions)}.`,
        ),
      );
    }
    // attemptId keys the stored attempt snapshot, from which the sync-back re-derives the launch
    // blueprint (and thus the workspace's connected-account refs). The instance row additionally
    // carries the launch-time injection shapes; null (legacy rows) means "nothing file-injected".
    return {
      target,
      attemptId: workspace.latestRunId,
      launchCredentialInjections: instance.launchCredentialInjections ?? [],
    };
  });

/**
 * Captures what the run changed (shared by both framings): the working tree against HEAD, staged
 * in a throwaway index so the repository's own index — the user's git state — is never written.
 * A reading that failed (the script exited nonzero) is no reading: the run's diff and changed
 * files stay unrecorded (null), never an empty change that reads as "nothing changed".
 */
const captureChanges = (runId: string, target: SealantTarget) =>
  Effect.gen(function* () {
    const output = yield* shellExec(target, workingTreeChangesScript());
    if (output.exitCode !== 0) {
      yield* Effect.logWarning(
        `Run ${runId}: reading its changes failed (the working-tree reading exited ${String(output.exitCode)}); recorded as failed.`,
      );
      return { changesReadFailed: true };
    }
    const { diff, nameStatus } = splitWorkingTreeChanges(output.stdout);
    return { diff, changedFiles: parseNameStatus(nameStatus) };
  });

/**
 * The run's record could not take one of its events: the log holds a different event at its id or
 * position. Its output is not all recorded, so the run fails, saying why.
 */
const recordConflictMessage = (error: TelemetrySinkConflictError) =>
  `The run's record could not take its events: ${error.message}.`;

/** HARNESS framing: one command; a nonzero exit marks the run failed. */
const produceHarnessRun = (runId: string, target: SealantTarget, command: RunExecCommand) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const captured = yield* captureRun(runId, target, command).pipe(
      Effect.catchTag("TelemetrySinkConflictError", Effect.succeed),
    );
    const changes = yield* captureChanges(runId, target);
    if (typeof captured !== "number") {
      yield* runs.markRunFailed({
        id: runId,
        errorMessage: recordConflictMessage(captured),
        ...changes,
      });
      return;
    }
    const exitCode = captured;
    yield* exitCode === 0
      ? runs.markRunCompleted({ id: runId, exitCode: 0, ...changes })
      : runs.markRunFailed({ id: runId, exitCode, ...changes });
  });

/**
 * EXEC (check-run) framing: every command executes in order regardless of exit codes — a nonzero
 * exit is a check DATUM (`base fails · head passes · revert fails`), not an execution failure. The
 * run completes iff every command executed and was recorded (its `exitCode` is the LAST command's;
 * per-command codes live in the record's `processExited` events). It fails only when the machinery
 * broke — a command that never reported an exit code means the recording cannot be trusted.
 */
export const produceExecRun = (
  runId: string,
  target: SealantTarget,
  commands: readonly RunExecCommand[],
  user?: string,
) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    let lastExitCode = 0;
    for (const [index, command] of commands.entries()) {
      const captured = yield* captureRun(runId, target, command, user).pipe(
        Effect.catchTag("ProcessUserUnavailableError", (error) =>
          runs.markRunFailed({ id: runId, errorMessage: error.message }).pipe(Effect.as(undefined)),
        ),
        // The commands after it do not run; what the ones before it changed is still the run's.
        Effect.catchTag("TelemetrySinkConflictError", (error) =>
          Effect.gen(function* () {
            const changes = yield* captureChanges(runId, target);
            yield* runs.markRunFailed({
              id: runId,
              errorMessage: `Command ${index + 1}/${commands.length} (${command.executable}): ${recordConflictMessage(error)} Check run aborted.`,
              ...changes,
            });
            return undefined;
          }),
        ),
      );
      if (captured === undefined) return;
      const exitCode = captured;
      if (exitCode === -1) {
        yield* runs.markRunFailed({
          id: runId,
          errorMessage: `Command ${index + 1}/${commands.length} (${command.executable}) ended without an exit code (transport closed or killed); check run aborted.`,
        });
        return;
      }
      lastExitCode = exitCode;
    }
    const changes = yield* captureChanges(runId, target);
    yield* runs.markRunCompleted({ id: runId, exitCode: lastExitCode, ...changes });
  });

/**
 * The API's check of a process user, made again on the executor the run reached: why the run must
 * not start, or `undefined` when it may. No answer is a refusal too.
 */
const recheckProcessUser = (target: SealantTarget, user: string, channel: ProcessUserChannel) =>
  channel.check(target, user).pipe(
    Effect.timeout(Duration.seconds(30)),
    Effect.result,
    Effect.map((answered): string | undefined => {
      const prefix = `The run reached another executor than the one '${user}' was checked on, and`;
      if (Result.isFailure(answered)) {
        return `${prefix} that executor did not answer the check again; nothing was started.`;
      }
      const outcome = processUserCheckOutcome(answered.success);
      if (outcome === "ok") return undefined;
      if (outcome === "unanswered") {
        return `${prefix} that executor did not confirm the check (it exited ${String(answered.success.exitCode)}); nothing was started.`;
      }
      return `${prefix} there it is refused (${outcome.detail}); nothing was started.`;
    }),
  );

export interface DotfilesRunOptions {
  /** For tests; defaults to the live channel (the staged archives' cleanup). */
  readonly stageChannel?: DotfilesStageChannel;
  /** For tests; defaults to `DOTFILES_APPLY_TIMEOUT`. */
  readonly applyTimeout?: Duration.Input;
  /** For tests; defaults to `DOTFILES_BOOTSTRAP_TIMEOUT`. */
  readonly bootstrapTimeout?: Duration.Input;
}

/**
 * DOTFILES framing (docs/connected-accounts-design.md §6g): `dotfiles.apply` as the person's user,
 * with the run's id as the execution, so the bootstrap's process (`./install.sh`, started by the
 * daemon as that user once every file is applied) is recorded in this run: its `processStarted`
 * says the files are applied, its output and exit are the run's. The staged archives are removed
 * once the daemon answers. The run completes, with the bootstrap's exit code (0 without one), iff
 * the files were applied and the bootstrap's exit was recorded; it fails, with the daemon's words,
 * when the apply was refused or did not answer, and when the bootstrap ran past its bound (it is
 * stopped) or its exit went unobserved. Nothing of the worktree changed, so no changes are read.
 */
export const produceDotfilesRun = (
  runId: string,
  target: SealantTarget,
  dotfiles: RunDotfilesApply,
  options: DotfilesRunOptions = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runs = yield* RunRepo;
      const runtime = yield* SealantRuntime;
      const sink = yield* TelemetrySink;
      const stageChannel = options.stageChannel ?? liveDotfilesStageChannel;

      const { session, runtimeId } = yield* runtime.connect(target).pipe(
        Effect.flatMap((connected) =>
          Effect.map(connected.health, (health) => ({
            session: connected,
            runtimeId: health.runtimeId,
          })),
        ),
        Effect.retry(BRIDGE_RETRY),
      );
      yield* sink.openEpoch({ runId, runtimeId, schemaVersion: 0 });

      // Only the directory the API staged for this run is ever removed.
      const staged =
        dotfiles.archiveDir !== undefined && dotfiles.archiveDir === dotfilesStagePath(runId);
      const applied = yield* session
        .dotfilesApply({
          user: dotfiles.user,
          ...(dotfiles.repository === undefined ? {} : { repository: dotfiles.repository }),
          ...(dotfiles.archiveDir === undefined ? {} : { archiveDir: dotfiles.archiveDir }),
          executionId: runId,
        })
        .pipe(Effect.timeout(options.applyTimeout ?? DOTFILES_APPLY_TIMEOUT), Effect.result);
      if (staged) {
        yield* stageChannel
          .run(target, buildDotfilesCleanupScript(runId))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`Run ${runId}: the staged dotfiles were not removed.`, cause),
            ),
          );
      }

      const close = (closeReason: "stream-end" | "transport-close", suspicious: boolean) =>
        sink.closeEpoch({ runId, runtimeId, closeReason, suspicious }).pipe(Effect.ignore);

      if (Result.isFailure(applied)) {
        yield* close("stream-end", false);
        const failure = applied.failure;
        const why = Cause.isTimeoutError(failure)
          ? "the workspace did not answer within 10 minutes"
          : failure.message;
        yield* runs.markRunFailed({
          id: runId,
          errorMessage: `The dotfiles were not applied as ${dotfiles.user}: ${why}`,
        });
        return;
      }
      if (applied.success.home !== dotfiles.home) {
        // The passwd entry changed between the API's check and the apply.
        yield* close("stream-end", false);
        yield* runs.markRunFailed({
          id: runId,
          errorMessage: `The dotfiles were applied as ${dotfiles.user} into ${applied.success.home}, which is no longer ${dotfiles.home}.`,
        });
        return;
      }
      const bootstrap = applied.success.bootstrap;
      if (bootstrap === undefined) {
        yield* close("stream-end", false);
        yield* runs.markRunCompleted({ id: runId, exitCode: 0 });
        return;
      }

      let exitCode: number | undefined;
      const drained = yield* session.events.pipe(
        // Only this run's own events: the bootstrap's (the daemon stamps the execution on them).
        Stream.filter((event) => event.executionId === runId),
        Stream.takeUntil(
          (event) =>
            event.payload.case === "processExited" && event.processId === bootstrap.processId,
        ),
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.payload.case === "processExited" && event.processId === bootstrap.processId) {
              exitCode = event.payload.value.exitCode ?? -1;
            }
          }),
        ),
        Stream.groupedWithin(BATCH_SIZE, BATCH_WINDOW),
        Stream.mapEffect((batch) =>
          sink.appendBatch({ runId, runtimeId, batch: Array.from(batch).map(normalizeEnvelope) }),
        ),
        Stream.runDrain,
        Effect.timeout(options.bootstrapTimeout ?? DOTFILES_BOOTSTRAP_TIMEOUT),
        Effect.result,
      );
      yield* close(
        exitCode === undefined ? "transport-close" : "stream-end",
        exitCode === undefined,
      );
      if (Result.isFailure(drained) && Cause.isTimeoutError(drained.failure)) {
        yield* session.signalProcess(bootstrap.processId, SIGTERM).pipe(Effect.ignore);
        yield* runs.markRunFailed({
          id: runId,
          errorMessage: `The dotfiles were applied as ${dotfiles.user}; their bootstrap ran for more than 30 minutes and was stopped.`,
        });
        return;
      }
      if (exitCode === undefined) {
        const conflict =
          Result.isFailure(drained) && drained.failure instanceof TelemetrySinkConflictError
            ? drained.failure
            : undefined;
        yield* runs.markRunFailed({
          id: runId,
          errorMessage:
            conflict === undefined
              ? `The dotfiles were applied as ${dotfiles.user}; their bootstrap's exit was not observed (the connection to the workspace closed).`
              : `The dotfiles were applied as ${dotfiles.user}; ${recordConflictMessage(conflict)}`,
        });
        return;
      }
      yield* runs.markRunCompleted({ id: runId, exitCode });
    }),
  );

/**
 * Pure dispatch on the claim outcome. The queue is at-least-once: a redelivered job must never
 * re-run the harness. `already-running` means a previous delivery died mid-run (worker crash,
 * queue redelivery) or is still executing elsewhere — either way this delivery cannot safely execute,
 * so the honest move is to fail the run with a message rather than run it twice or strand it.
 */
export const runExecClaimAction = (
  claim: RunExecClaim,
): "execute" | "skip-terminal" | "fail-already-running" | "fail-missing" => {
  switch (claim.outcome) {
    case "claimed":
      return "execute";
    case "terminal":
      return "skip-terminal";
    case "already-running":
      return "fail-already-running";
    case "not-found":
      return "fail-missing";
  }
};

/** The Effect pipeline: claim the run, resolve container, exec+capture, diff, mark terminal. */
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
    const { command, commands, dotfiles, user } = options;
    if ([command, commands, dotfiles].filter((framing) => framing !== undefined).length !== 1) {
      return yield* Effect.fail(
        new Error(`Run-exec job for ${options.runId} must carry exactly one framing.`),
      );
    }
    if (user !== undefined && commands === undefined) {
      return yield* Effect.fail(
        new Error(`Run-exec job for ${options.runId}: only the exec framing runs as a user.`),
      );
    }
    const claim = yield* runs.claimRunForExec({ id: options.runId });
    const action = runExecClaimAction(claim);
    if (action === "skip-terminal") {
      yield* Effect.logInfo(
        `Run-exec job for ${options.runId} redelivered after the run reached ${
          claim.outcome === "not-found" ? "an unknown state" : claim.run.status
        }; nothing to do.`,
      );
      return;
    }
    if (action === "fail-missing") {
      return yield* Effect.fail(new Error(`Run-exec job for unknown run ${options.runId}.`));
    }
    if (action === "fail-already-running") {
      yield* runs
        .markRunFailed({
          id: options.runId,
          errorMessage:
            "Run-exec job was redelivered while the run was already marked running: a previous delivery died mid-run or is still executing. Failed rather than executed twice.",
        })
        .pipe(Effect.ignore);
      return;
    }

    // From here the run is claimed: every exit path must move it off "running".
    const { target, attemptId, launchCredentialInjections } = yield* resolveRuntimeTarget(
      options.runId,
      options.targetOptions ?? {},
    ).pipe(
      Effect.onError(() =>
        runs
          .markRunFailed({
            id: options.runId,
            errorMessage: "Run execution failed before the workspace runtime was resolved.",
          })
          .pipe(Effect.ignore),
      ),
    );

    // The run reached another executor than the API checked the user against (a restart in
    // between): the user is checked again here, as the API would, before anything starts.
    if (user !== undefined && attemptId !== options.checkedExecutorRunId) {
      const refusal = yield* recheckProcessUser(
        target,
        user,
        options.processUserChannel ?? liveProcessUserChannel,
      );
      if (refusal !== undefined) {
        yield* runs.markRunFailed({ id: options.runId, errorMessage: refusal }).pipe(Effect.ignore);
        return;
      }
    }

    if (dotfiles !== undefined) {
      // A home's dotfiles touch no login and no worktree: no credential sync-back, no changes.
      yield* produceDotfilesRun(options.runId, target, dotfiles).pipe(
        Effect.onError(() =>
          runs
            .markRunFailed({
              id: options.runId,
              errorMessage: "Applying the dotfiles failed before completion.",
            })
            .pipe(Effect.ignore),
        ),
      );
      return;
    }

    const produce =
      commands !== undefined
        ? produceExecRun(options.runId, target, commands, user)
        : command !== undefined
          ? produceHarnessRun(options.runId, target, command)
          : Effect.void; // unreachable: the framing guard above rejected the neither-set case

    // Never leave the run pinned in "running": reconcile to failed on ANY abnormal exit (onError fires
    // on typed failures AND defects, e.g. a "connection closed" surfaced as a die).
    // The credential sync-back runs on EVERY exit path (`ensuring`): the CLIs may have rotated their
    // session files even when the run itself failed, and the helpers never fail (warnings only).
    yield* produce.pipe(
      Effect.onError(() =>
        runs
          .markRunFailed({
            id: options.runId,
            errorMessage: "Run execution failed before completion.",
          })
          .pipe(Effect.ignore),
      ),
      Effect.ensuring(
        syncBackWorkspaceCredentials({
          attemptId,
          target,
          launchCredentialInjections,
          credentialCipher: options.credentialCipher,
        }),
      ),
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
  const appLayer = Layer.mergeAll(dataAccessLayer, SealantRuntimeControlLive, sinkLayer);

  return Effect.runPromise(processRunExecJobEffect(options).pipe(Effect.provide(appLayer)));
};
