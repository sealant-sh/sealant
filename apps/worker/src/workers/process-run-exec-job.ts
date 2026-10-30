/**
 * The run-exec job: claims the run, resolves the workspace's runtime, and hands the run to its
 * framing. The exec recorder itself (`captureRun`, `produceExecRun`) lives in @sealant/telemetry, so
 * the API can run an exec in its own request with the same recording; the harness and dotfiles
 * framings stay here.
 */
import type { CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  type DB,
  type RunExecClaim,
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
  captureChanges,
  captureRun,
  DAEMON_CONNECT_RETRY,
  InlineByteaArtifactStoreLive,
  normalizeEnvelope,
  PostgresTelemetrySinkLive,
  produceExecRun,
  RECORD_BATCH_SIZE,
  RECORD_BATCH_WINDOW,
  recordConflictMessage,
  TelemetrySink,
  TelemetrySinkConflictError,
} from "@sealant/telemetry";
import {
  buildDotfilesCleanupScript,
  dotfilesStagePath,
  liveDotfilesStageChannel,
  liveProcessUserChannel,
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
} from "@sealant/workspaces";
import { Cause, Duration, Effect, Layer, Result, Stream } from "effect";

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
        Effect.retry(DAEMON_CONNECT_RETRY),
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
        Stream.groupedWithin(RECORD_BATCH_SIZE, RECORD_BATCH_WINDOW),
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
