import type { CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepoLive,
  SealantDB,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
  type WorkspaceRuntimeInstanceStopReason,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import {
  decideExecutorDeletion,
  type ExecutorDeletionBasis,
  type ExecutorRuntimeState,
} from "../runtime/executor-preservation.js";
import {
  hostDirectoryLaunchMaterialStager,
  type LaunchMaterialStager,
} from "../runtime/launch-material.js";
import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { SealantRuntimeControlLive } from "../sealantd/runtime.js";
import {
  sealantTargetForRuntimeInstance,
  type SealantTargetDerivationOptions,
} from "../sealantd/target.js";
import {
  describeDeletionBasis,
  drainCaptureBeforeStop,
  drainPermitsStop,
  recordedDeletionEvidence,
  runIsCaptureSourced,
  type CaptureDrainLedger,
  type CaptureDrainRead,
  type CaptureDrainSettings,
} from "./capture-drain.js";
import { swallowingFailure as sharedSwallowingFailure } from "./errors.js";
import { syncBackWorkspaceCredentials } from "./harness-credentials-sync-back.js";

/**
 * Drain-before-stop for capture-sourced workspaces (`capture-drain.ts`). Absent = no drain (a
 * caller that already drained, or a runtime with nothing to save).
 */
export interface WorkspaceStopCaptureDrain {
  /** Durable drain ownership and progress, shared by every worker (`capture-drain-ledger.ts`). */
  readonly ledger: CaptureDrainLedger;
  readonly settings: CaptureDrainSettings;
  /** How long this one call may wait on the queue before deferring the stop. */
  readonly budgetMs: number;
  /** Who is stopping, for the log lines ("expiry reaper", "lifecycle stop"). */
  readonly label: string;
}

/**
 * What one stop call did. Only `stopped` tore the runtime down; the others left it running:
 *
 *  - `draining`: the capture queue is still moving; the next call (the reaper's next tick)
 *    continues the drain and stops once it is empty.
 *  - `kept`: the daemon answers but its queue stopped moving (`not saved · kept`), the daemon
 *    is silent while the executor runs (`not saved · daemon silent · kept`), the queue is empty
 *    but the daemon did not confirm its final flush complete (`not saved · not confirmed ·
 *    kept`), or the executor ENDED with its disk and nothing proves that disk saved (`not saved ·
 *    executor exited · kept`: retained, and recovery is attempted). Nothing removes it until
 *    the preservation policy (`executor-preservation.ts`) finds evidence it may go.
 *  - `busy`: another drain of the same run is in flight (this worker or another).
 */
export type WorkspaceStopOutcome = "stopped" | "draining" | "kept" | "busy";

export interface ProcessWorkspaceStopEffectOptions {
  /**
   * The workspace whose stored status should settle to "stopped" once the runtime is gone.
   * Absent for ORPHANED instances (workspace row already deleted) — the reaper still tears the
   * container down, there is just no row left to settle.
   */
  readonly workspaceId?: string;
  /** The attempt whose runtime instance is being stopped. */
  readonly runId: string;
  readonly stopReason: WorkspaceRuntimeInstanceStopReason;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  /**
   * Enables the best-effort credential sync-back before the container is destroyed (rotated
   * claude/codex session files must not die with the runtime — interactive/PTY sessions rotate
   * tokens without ever running another exec job). Undefined when SEALANT_CREDENTIALS_KEY is not
   * configured on the worker; the sync-back then only warns for workspaces that carry refs.
   */
  readonly credentialCipher?: CredentialCipherService;
  /** How this worker reaches each runtime family (client TLS for Kubernetes). */
  readonly targetOptions?: SealantTargetDerivationOptions;
  /** Where this worker staged launch material; defaults to host directories (Docker). */
  readonly launchMaterialStager?: LaunchMaterialStager;
  /** Drain a capture-sourced workspace's queue before the runtime goes away. */
  readonly captureDrain?: WorkspaceStopCaptureDrain;
}

export interface ProcessWorkspaceStopOptions extends ProcessWorkspaceStopEffectOptions {
  readonly db: DB;
}

export class WorkspaceStopProcessingError extends Error {
  public override readonly name = "WorkspaceStopProcessingError";

  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}

const toWorkspaceStopProcessingError = (cause: unknown): WorkspaceStopProcessingError => {
  if (cause instanceof WorkspaceStopProcessingError) {
    return cause;
  }
  return new WorkspaceStopProcessingError(
    cause instanceof Error ? cause.message : "Workspace stop failed.",
    { cause },
  );
};

const swallowingFailure = (operation: string) =>
  sharedSwallowingFailure("Workspace stop", operation);

/**
 * What the adapter knows of the runtime: `running`, `exited` (ended, its disk may remain) or
 * `missing`. Unknown — no `inspect`, or a failed read — counts as `running`, so the sync-back
 * keeps its chance and nothing is taken for gone.
 */
const runtimeState = (
  adapter: RuntimeAdapter,
  resourceId: string,
): Effect.Effect<"running" | "exited" | "missing"> => {
  const inspect = adapter.inspect;
  if (inspect === undefined) {
    return Effect.succeed("running");
  }
  return Effect.tryPromise(() => inspect.call(adapter, { resourceId })).pipe(
    Effect.map((result) => result.state),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Workspace stop: inspecting runtime ${resourceId} failed; treating it as running.`,
        cause,
      ).pipe(Effect.as("running" as const)),
    ),
  );
};

const stopOutcome = (outcome: WorkspaceStopOutcome): WorkspaceStopOutcome => outcome;

/**
 * Whether the run is capture-sourced: the kind recorded on its runtime instance, else its attempt
 * snapshot, else — nothing says — yes (fail closed; `runIsCaptureSourced`). A failed read aborts
 * the stop.
 */
const isCaptureSourcedRun = (runId: string, sourceKind: string | null | undefined) =>
  Effect.gen(function* () {
    const attempts = yield* WorkspaceAttemptRepo;
    return yield* runIsCaptureSourced({
      runId,
      sourceKind,
      readSnapshotPayload: attempts.getAttemptSnapshotByRunId(runId),
    });
  }).pipe(Effect.mapError(toWorkspaceStopProcessingError));

/**
 * Stop one workspace runtime: remove the container via the runtime adapter, then record the
 * terminal state (`markStopped` on the instance + workspace stored status "stopped").
 *
 * Ordering is deliberate: the adapter stop comes FIRST, and its failure aborts the status writes —
 * recording "stopped" while the container still runs would leak it forever. The reverse gap
 * (container removed, then the process dies before the writes) self-heals: the message is
 * redelivered or the reaper re-drives it, and the adapter stop is idempotent (`not-found` =
 * success).
 *
 * The workspace row settles to "stopped" ONLY while this run is still the workspace's
 * `latestRunId`. A restart supersedes the old runtime with a new attempt — its stop half must
 * not stamp "stopped" onto a workspace that is already relaunching (the reaper treats a live
 * container on a stored-"stopped" workspace as stranded and would kill the fresh runtime).
 *
 * With `captureDrain`, every removal of a capture-sourced runtime (or one whose source cannot be
 * read) goes through the one preservation policy (`decideExecutorDeletion`): a live one is
 * drained first (`capture-drain.ts`) and removed once the daemon confirms its final flush
 * complete, or once its daemon is silent AND nothing of the executor is left; an ENDED one keeps
 * its disk, and is removed only when Core observed its final flush complete, the control plane
 * attested a sealed final capture of it (`completion` on the stop request), or the owner
 * discarded it — otherwise it is retained (recorded, and recovery is attempted). Otherwise the
 * call returns `draining` / `kept` and writes nothing — the reaper's next tick (a stored
 * "stopped" workspace is `stranded` to it; a replaced run is `superseded`) comes back.
 */
export const processWorkspaceStopEffect = Effect.fn("processWorkspaceStop")(function* (
  options: ProcessWorkspaceStopEffectOptions,
) {
  const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
  const workspaces = yield* WorkspaceRepo;

  const settleWorkspaceRow = Effect.gen(function* () {
    if (options.workspaceId === undefined) {
      return;
    }
    const workspace = yield* workspaces.getWorkspaceById(options.workspaceId);
    if (workspace === undefined || workspace.latestRunId !== options.runId) {
      return;
    }
    yield* workspaces.setWorkspaceStatus({ id: options.workspaceId, status: "stopped" });
  }).pipe(swallowingFailure("workspace-status update"));

  // Record that this stop is under way, then remove the runtime. From the first write on, an
  // exit the runtime reports is this planned stop completing (the exit reconciler records it
  // stopped, never failed). A failure is recorded on the drain (`stop-failed`, with the error)
  // before it propagates; the stop intent is durable, so the next sweep retries it.
  const stopRuntime = (input: {
    readonly adapter: RuntimeAdapter;
    readonly resourceId: string;
    readonly reference: string | null;
    readonly fence: boolean;
    readonly drain: WorkspaceStopCaptureDrain | undefined;
  }) =>
    Effect.gen(function* () {
      yield* runtimeInstances.markStopRequested({
        runId: options.runId,
        stopReason: options.stopReason,
      });
      yield* Effect.tryPromise({
        try: () =>
          input.adapter.stop({
            resourceId: input.resourceId,
            ...(input.reference === null ? {} : { reference: input.reference }),
            ...(input.fence ? { fence: true } : {}),
          }),
        catch: toWorkspaceStopProcessingError,
      });
      yield* runtimeInstances.markStopped({ runId: options.runId, stopReason: options.stopReason });
    }).pipe(
      Effect.mapError(toWorkspaceStopProcessingError),
      Effect.tapError((error) =>
        input.drain === undefined
          ? Effect.void
          : input.drain.ledger.observe(options.runId, {
              state: "stop-failed",
              detail: `removing the runtime failed: ${error.message}; every sweep retries the stop`,
            }),
      ),
    );

  // After the runtime is gone and recorded stopped: drop worker-staged launch material
  // (best-effort — a directory the container re-owned must not fail a stop that already
  // happened: that failure used to strand the row), settle the workspace row.
  const finishStop = Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      (options.launchMaterialStager ?? hostDirectoryLaunchMaterialStager).removeAll(options.runId),
    ).pipe(swallowingFailure("launch-material removal"));
    yield* settleWorkspaceRow;
  });

  const instance = yield* runtimeInstances
    .getRuntimeInstanceByRunId(options.runId)
    .pipe(Effect.mapError(toWorkspaceStopProcessingError));

  if (instance === undefined) {
    // Nothing was ever launched for this run; still settle the workspace row (guarded above) so a
    // stop requested against a stranded workspace converges instead of looping through the DLQ.
    yield* settleWorkspaceRow;
    return stopOutcome("stopped");
  }

  const { adapter: adapterId, resourceId, reference } = instance;
  if (instance.status !== "stopped" && adapterId !== null && resourceId !== null) {
    const adapter = options.runtimeAdapters.find((candidate) => candidate.id === adapterId);
    if (adapter === undefined) {
      return yield* Effect.fail(
        new WorkspaceStopProcessingError(
          `No runtime adapter is registered for '${adapterId}' (run ${options.runId}).`,
        ),
      );
    }

    const target = sealantTargetForRuntimeInstance(instance, options.targetOptions ?? {});
    const state = yield* runtimeState(adapter, resourceId);
    const drain = options.captureDrain;
    const record: CaptureDrainRead =
      drain === undefined
        ? { readable: true, entry: undefined }
        : yield* drain.ledger.read(options.runId);
    const recorded = record.readable ? record.entry : undefined;
    const discard = recorded?.discardRequested;

    if (drain !== undefined && discard !== undefined) {
      // The owner discarded this run's unsaved captures (recorded, with who and when, by the
      // API). Nothing is drained and nothing is kept: the runtime is terminated outright. What is
      // logged before the adapter answers is the request; only its success is the termination.
      const audit = `by ${discard.by}, requested ${new Date(discard.atMs).toISOString()}`;
      yield* Effect.logWarning(
        `Workspace stop (${drain.label}): run ${options.runId}: unsaved captures discard requested by the owner (${audit}); terminating the runtime without a drain.`,
      );
      yield* stopRuntime({ adapter, resourceId, reference, fence: true, drain });
      const detail = `unsaved captures discarded at the owner's request (${audit}); the runtime was terminated without a drain`;
      yield* Effect.logError(`Workspace stop (${drain.label}): run ${options.runId}: ${detail}.`);
      yield* drain.ledger.observe(options.runId, { state: "discarded", detail });
      yield* finishStop;
      return stopOutcome("stopped");
    }

    const captureSourced =
      drain === undefined ? false : yield* isCaptureSourcedRun(options.runId, instance.sourceKind);
    const drainedBefore = captureSourced ? recorded : undefined;
    const recordedEvidence = recordedDeletionEvidence(record, {
      runId: options.runId,
      resourceId,
      reference,
    });
    // The one preservation policy: may this executor (and its disk) be removed now?
    const decide = (runtime: ExecutorRuntimeState, observedNow: boolean) =>
      decideExecutorDeletion({
        captureSourced,
        runtime,
        ...recordedEvidence,
        observedComplete: observedNow || recordedEvidence.observedComplete,
      });

    // Remove the runtime the policy let go; a capture-sourced one records how it went.
    const removeRuntime = (basis: ExecutorDeletionBasis) =>
      Effect.gen(function* () {
        yield* stopRuntime({
          adapter,
          resourceId,
          reference,
          fence: false,
          drain: captureSourced ? drain : undefined,
        });
        yield* finishStop;
        if (drain !== undefined && captureSourced) {
          yield* drain.ledger.observe(options.runId, {
            state: "stopped",
            detail: `the runtime was removed: ${describeDeletionBasis(basis)}`,
          });
        }
        return stopOutcome("stopped");
      });

    if (state !== "running") {
      // The executor ended (or is gone). An ended executor keeps its disk — a container's
      // writable layer, a Failed Pod's emptyDir — and sealantd exits 75 with its staging there
      // after an incomplete final flush, whether or not any drain of ours reached it first (a
      // plain `docker stop`, its own shutdown FINAL, a lost reply). Only evidence lets it go.
      const decision = decide(state, false);
      if (!decision.delete) {
        // Said once, when it is first retained; recovery reports every attempt after that.
        if (drain !== undefined && recorded?.retained === undefined) {
          yield* Effect.logError(
            `Workspace stop (${drain.label}): run ${options.runId} (${adapterId} ${resourceId}): not saved · executor exited · kept · ${decision.reason}. Its disk keeps the staged captures; the runtime is left in place and recovery is attempted.`,
          );
          yield* drain.ledger.markRetained(options.runId, `executor exited · ${decision.reason}`);
        }
        return stopOutcome("kept");
      }
      return yield* removeRuntime(decision.basis);
    }

    // LAST CHANCE to read rotated session credentials out of the container: the official CLIs
    // refresh claude/codex session files in-place, and an interactive/PTY workspace may never run
    // another exec job to sync them. Best-effort by construction (the helper never fails). It
    // runs BEFORE the drain: after a FINAL flush the daemon refuses exec for good, so a sync-back
    // after it would read nothing — and so it is skipped once a drain has reached the daemon. An
    // unaddressable runtime (e.g. Kubernetes without client TLS) is skipped.
    if (target !== undefined && drainedBefore?.lastProgressAt === undefined) {
      yield* syncBackWorkspaceCredentials({
        attemptId: options.runId,
        target,
        launchCredentialInjections: instance.launchCredentialInjections ?? [],
        credentialCipher: options.credentialCipher,
      });
    }

    if (drain === undefined || !captureSourced) {
      const decision = decide("running", false);
      return decision.delete ? yield* removeRuntime(decision.basis) : stopOutcome("kept");
    }

    // No loss of work product: a live capture-sourced runtime holds captures nowhere else until
    // the daemon confirms them saved. Drain first; a queue still moving defers the stop, one that
    // cannot be confirmed keeps the workspace. Nothing below runs unless the drain permits it.
    if (target === undefined) {
      // Nothing here can see the queue, and the runtime says the executor is up: keep it.
      yield* Effect.logError(
        `Workspace stop (${drain.label}): run ${options.runId} is capture-sourced but this worker cannot reach its daemon (${adapterId}): not saved · kept. Configure the worker's control reach for this runtime.`,
      );
      return stopOutcome("kept");
    }
    const outcome = yield* drainCaptureBeforeStop({
      runId: options.runId,
      target,
      ledger: drain.ledger,
      settings: drain.settings,
      budgetMs: drain.budgetMs,
      label: drain.label,
      runtimeState: runtimeState(adapter, resourceId),
    });
    if (!drainPermitsStop(outcome)) {
      if (outcome.kind === "silent") {
        // Silent while the executor ended mid-drain: it is kept with its disk; record it.
        const ended = yield* runtimeState(adapter, resourceId);
        if (ended === "exited") {
          yield* drain.ledger.markRetained(options.runId, `executor exited · ${outcome.detail}`);
        }
      }
      return stopOutcome(
        outcome.kind === "stalled" || outcome.kind === "silent" || outcome.kind === "unconfirmed"
          ? "kept"
          : outcome.kind === "busy"
            ? "busy"
            : "draining",
      );
    }
    const decision = decide(
      outcome.kind === "gone" ? "missing" : "running",
      outcome.kind === "drained",
    );
    if (!decision.delete) {
      yield* Effect.logError(
        `Workspace stop (${drain.label}): run ${options.runId}: the drain ended (${outcome.kind}) but nothing lets the executor go: not saved · kept · ${decision.reason}.`,
      );
      return stopOutcome("kept");
    }
    return yield* removeRuntime(decision.basis);
  }

  // Already stopped, or never addressable: record the terminal state (idempotent) and settle.
  yield* runtimeInstances
    .markStopped({ runId: options.runId, stopReason: options.stopReason })
    .pipe(Effect.mapError(toWorkspaceStopProcessingError));
  yield* finishStop;
  return stopOutcome("stopped");
});

export const processWorkspaceStop = async (
  options: ProcessWorkspaceStopOptions,
): Promise<WorkspaceStopOutcome> => {
  const { db, ...effectOptions } = options;

  const dataAccessLayer = Layer.mergeAll(
    WorkspaceRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
    // The pre-stop credential sync-back re-derives the blueprint from the attempt snapshot and
    // persists rotated session files through the connected-account repo over the exec bridge.
    WorkspaceAttemptRepoLive,
    ConnectedAccountRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));

  return Effect.runPromise(
    processWorkspaceStopEffect(effectOptions).pipe(
      Effect.provide(Layer.mergeAll(dataAccessLayer, SealantRuntimeControlLive)),
    ),
  );
};
