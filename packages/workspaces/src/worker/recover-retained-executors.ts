import { CAPTURE_TOKEN_SECRET_ENV_NAME } from "@sealant/api-contracts/workspace-environment";
import type { CredentialCipherService } from "@sealant/credentials";
/**
 * Recovery of RETAINED executors: capture-sourced executors kept because their disk holds work
 * not confirmed saved (they ended without a complete final flush, or their launch failed after
 * they started). Every path that keeps one records it (`CaptureDrainLedger.markRetained`); this
 * sweep works through them on a backoff, loudly:
 *
 *  1. **Evidence first.** If the one preservation policy now lets the executor go (Core observed
 *     its final flush complete, the control plane attested a sealed final capture of it, the
 *     owner discarded it, nothing of it is left), it is removed and the retention ends.
 *  2. **Recover.** Otherwise the runtime is asked to bring it back on its own disk
 *     (`RuntimeAdapter.recover`). Docker restarts the kept container (`docker start`): sealantd
 *     boots, resumes its own staging without materializing over it, and this sweep drains it at
 *     once — the FINAL flush closes admission and terminates every writer the reboot started
 *     (the container's lifecycle steps and foreground harness run again: sealantd has no boot
 *     mode without them yet), snapshots both classes and ships. Once the daemon reports the
 *     final flush complete, the executor is removed and the retention ends. An executor is
 *     restarted only when its launch recorded a daemon with sealantd's recovery boot
 *     (`daemon_recovery_boot`, `daemon-recovery.ts`): an older daemon, or one of unknown build,
 *     would run its ordinary boot over the work its disk holds, so it is kept and reported.
 *  3. **Cannot recover.** Kubernetes cannot restart an ended Pod, and its emptyDir lives only as
 *     long as the Pod object; a terminated MicroVM's disk is gone with it. Those are reported as
 *     such (`unsupported`, with what can still be done by hand) and stay retained — never
 *     deleted without evidence. An executor the runtime no longer knows at all is reported LOST.
 *
 * Every failed or unfinished attempt is counted and the next one scheduled on an exponential
 * backoff (`workspace_capture_drains.next_recovery_at`); the owner can make one due now
 * (`POST /v1/workspaces/:id/recover`). Best-effort per executor: one failure never aborts the
 * sweep.
 */
import {
  SealantDB,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
  type WorkspaceCaptureDrain,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { z } from "zod";

import {
  runtimeRestartsRetainedExecutors,
  decideExecutorDeletion,
  type ExecutorDeletionBasis,
  type ExecutorRuntimeState,
} from "../runtime/executor-preservation.js";
import {
  hostDirectoryLaunchMaterialStager,
  type LaunchMaterialStager,
} from "../runtime/launch-material.js";
import type { RuntimeAdapter, RuntimeAdapterRecoverResult } from "../runtime/runtime-adapter.js";
import { SealantRuntimeControlLive } from "../sealantd/runtime.js";
import {
  sealantTargetForRuntimeInstance,
  type SealantTargetDerivationOptions,
} from "../sealantd/target.js";
import {
  describeDeletionBasis,
  drainCaptureBeforeStop,
  recordedDeletionEvidence,
  type CaptureDrainLedger,
  type CaptureDrainSettings,
} from "./capture-drain.js";

export interface RecoveryBackoff {
  /** The delay after the first failed attempt; doubles with each one after. */
  readonly baseMs: number;
  /** The longest delay between two attempts. */
  readonly maxMs: number;
}

export const DEFAULT_RECOVERY_BACKOFF: RecoveryBackoff = {
  baseMs: 60_000,
  maxMs: 60 * 60_000,
};

export interface RecoverRetainedExecutorsOptions {
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  readonly targetOptions?: SealantTargetDerivationOptions;
  readonly captureDrain: {
    readonly ledger: CaptureDrainLedger;
    readonly settings: CaptureDrainSettings;
    /** How long one sweep may wait on one recovered executor's queue. */
    readonly budgetMs?: number;
  };
  /** Retained executors handled per sweep, the most overdue first. Default 10. */
  readonly maxPerTick?: number;
  readonly backoff?: RecoveryBackoff;
  readonly now?: () => number;
  /**
   * Unseals the capture token kept at launch (`capture_token_sealed`), which a restarted
   * executor's boot needs again. Absent: no restart can be given its token, so none is started.
   */
  readonly credentialCipher?: CredentialCipherService;
  /** Where the executor was created to read its secret env; defaults to host directories. */
  readonly launchMaterialStager?: LaunchMaterialStager;
}

const sealedCaptureTokenSchema = z.object({ [CAPTURE_TOKEN_SECRET_ENV_NAME]: z.string().min(1) });

/**
 * The capture token the executor was launched with, unsealed; `undefined` when none was kept,
 * the cipher is not configured, or it cannot be unsealed.
 */
const recoverCaptureToken = (
  sealed: string | null,
  cipher: CredentialCipherService | undefined,
): Effect.Effect<string | undefined> =>
  sealed === null || cipher === undefined
    ? Effect.succeed(undefined)
    : cipher.decrypt(sealed).pipe(
        Effect.map((plaintext) => {
          try {
            const parsed = sealedCaptureTokenSchema.safeParse(JSON.parse(plaintext));
            return parsed.success ? parsed.data[CAPTURE_TOKEN_SECRET_ENV_NAME] : undefined;
          } catch {
            return undefined;
          }
        }),
        Effect.catchCause(() => Effect.succeed(undefined)),
      );

const DEFAULT_MAX_PER_TICK = 10;
const DEFAULT_DRAIN_BUDGET_MS = 60_000;

/** When the attempt after `attempts` failed ones is due. */
export const nextRecoveryDelayMs = (attempts: number, backoff: RecoveryBackoff): number =>
  Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(Math.max(0, attempts), 30));

/** What one recovery pass over a retained executor concluded. */
export type RecoveryOutcome =
  /** It was removed: the policy found evidence it may go (after recovery, or without it). */
  | "released"
  /** Nothing of it is left: its unsaved captures are lost, and said so. */
  | "lost"
  /** Still retained; the next attempt is scheduled. */
  | "retained";

/**
 * One sweep over the retained executors whose next recovery attempt is due. Returns what each
 * concluded, by run id.
 */
export const recoverRetainedExecutorsEffect = Effect.fn("recoverRetainedExecutors")(function* (
  options: RecoverRetainedExecutorsOptions,
) {
  const drains = yield* WorkspaceCaptureDrainRepo;
  const due = yield* drains.listRetainedDue({
    limit: options.maxPerTick ?? DEFAULT_MAX_PER_TICK,
  });
  const outcomes = new Map<string, RecoveryOutcome>();
  for (const row of due) {
    const outcome = yield* recoverOne(options, row).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          `Executor recovery: run ${row.runId}'s retained executor could not be handled this sweep; it stays retained.`,
          cause,
        ).pipe(Effect.as("retained" as const)),
      ),
    );
    outcomes.set(row.runId, outcome);
  }
  return outcomes;
});

const recoverOne = (options: RecoverRetainedExecutorsOptions, row: WorkspaceCaptureDrain) =>
  Effect.gen(function* () {
    const drains = yield* WorkspaceCaptureDrainRepo;
    const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
    const { ledger } = options.captureDrain;
    const now = options.now ?? Date.now;
    const backoff = options.backoff ?? DEFAULT_RECOVERY_BACKOFF;
    const runId = row.runId;
    const prefix = `Executor recovery · run ${runId}`;

    const retry = (error: string, delayMs = nextRecoveryDelayMs(row.recoveryAttempts, backoff)) =>
      drains
        .recordRecoveryAttempt({ runId, error, nextRecoveryAt: new Date(now() + delayMs) })
        .pipe(Effect.as("retained" as const));

    const instance = yield* runtimeInstances.getRuntimeInstanceByRunId(runId);
    if (instance === undefined || instance.adapter === null || instance.resourceId === null) {
      yield* Effect.logError(
        `${prefix}: not saved · retained · no runtime identity is recorded for it, so nothing can reach it; it stays on record.`,
      );
      return yield* retry("no runtime identity is recorded for this run");
    }
    const { resourceId, reference } = instance;
    const adapter = options.runtimeAdapters.find((candidate) => candidate.id === instance.adapter);
    if (adapter === undefined) {
      yield* Effect.logError(
        `${prefix}: not saved · retained · no runtime adapter is registered for '${instance.adapter}' on this worker.`,
      );
      return yield* retry(`no runtime adapter is registered for '${instance.adapter}'`);
    }
    const executor = { runId, resourceId, reference };
    const stopReason = instance.stopReason ?? "failed";

    // Remove it and end the retention: only ever on a basis the policy gave.
    const release = (basis: ExecutorDeletionBasis) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          adapter.stop({ resourceId, ...(reference === null ? {} : { reference }) }),
        );
        yield* runtimeInstances.markStopped({ runId, stopReason });
        const detail = `the retained executor was removed: ${describeDeletionBasis(basis)}`;
        yield* ledger.observe(runId, { state: "stopped", detail });
        yield* Effect.logInfo(`${prefix}: ${detail}.`);
        return "released" as const;
      });

    const inspect = adapter.inspect;
    const runtimeNow: Effect.Effect<ExecutorRuntimeState> =
      inspect === undefined
        ? Effect.succeed("unknown")
        : Effect.tryPromise(() => inspect.call(adapter, { resourceId })).pipe(
            Effect.map((result) => result.state),
            Effect.catchCause(() => Effect.succeed("unknown" as const)),
          );

    // 1. Evidence first: an attestation or a discard may have arrived since it was retained.
    const record = yield* ledger.read(runId);
    const state = yield* runtimeNow;
    const decision = decideExecutorDeletion({
      captureSourced: true,
      runtime: state,
      ...recordedDeletionEvidence(record, executor),
    });
    if (decision.delete) {
      if (decision.basis === "missing") {
        const detail = `the runtime no longer knows the retained executor (${instance.adapter} ${resourceId}); whatever it held that was not saved is lost`;
        yield* Effect.logError(`${prefix}: LOST · ${detail}.`);
        yield* ledger.observe(runId, { state: "gone", detail });
        return "lost" as const;
      }
      return yield* release(decision.basis);
    }

    // 2. Recover it on its own disk. A restart boots it with the environment it was created
    // with, and its capture token was in the secret env file removed once it was ready: stage the
    // same token again (Mend still honours it for the session) before anything starts it. Without
    // a token nothing is started — a boot without it would exit, not save.
    const stager = options.launchMaterialStager ?? hostDirectoryLaunchMaterialStager;
    const restarts = state === "exited" && runtimeRestartsRetainedExecutors(adapter.id);
    if (restarts && instance.daemonRecoveryBoot !== true) {
      // A daemon without sealantd's recovery boot ignores the request for it and runs its
      // ORDINARY boot: it restores the store's head over the staging and edits this disk holds,
      // and runs the lifecycle steps and the harness again. Unknown is treated the same (fail
      // closed). Nothing is started; the executor stays retained with its disk.
      const build = instance.daemonImage ?? "a daemon build Core did not record";
      const why =
        instance.daemonRecoveryBoot === false
          ? `its daemon (${build}) predates sealantd's recovery boot`
          : `Core cannot tell whether its daemon (${build}) has sealantd's recovery boot`;
      yield* (row.recoveryAttempts === 0 ? Effect.logError : Effect.logWarning)(
        `${prefix}: not recoverable in place · ${why}. Restarting it would run its ordinary boot (restore, dotfiles, lifecycle steps, harness) over the work its disk holds, so it is kept and not started. Recover its disk by hand, or discard it.`,
      );
      return yield* retry(`not recoverable in place · ${why}`);
    }
    if (restarts) {
      const token = yield* recoverCaptureToken(
        row.captureTokenSealed ?? null,
        options.credentialCipher,
      );
      const restage = stager.restageSecretEnv;
      if (token === undefined || restage === undefined) {
        const why =
          token === undefined
            ? row.captureTokenSealed === null || row.captureTokenSealed === undefined
              ? "no capture token was kept at launch"
              : options.credentialCipher === undefined
                ? "the worker has no credential cipher to unseal it"
                : "the kept capture token cannot be unsealed"
            : "this worker cannot stage launch material for it";
        yield* (row.recoveryAttempts === 0 ? Effect.logError : Effect.logWarning)(
          `${prefix}: not recoverable · no capture token · ${why}. The executor is kept and not started.`,
        );
        return yield* retry(`not recoverable · no capture token · ${why}`);
      }
      const staged = yield* Effect.tryPromise({
        try: () => restage.call(stager, runId, { [CAPTURE_TOKEN_SECRET_ENV_NAME]: token }),
        catch: (error) => error,
      }).pipe(
        Effect.as(undefined),
        Effect.catch((error) =>
          Effect.succeed(error instanceof Error ? error.message : String(error)),
        ),
      );
      if (staged !== undefined) {
        yield* Effect.logError(
          `${prefix}: not saved · retained · staging its capture token again failed: ${staged}. It is kept and not started.`,
        );
        return yield* retry(`staging the capture token failed: ${staged}`);
      }
    }
    const recover = adapter.recover;
    const recovered:
      | RuntimeAdapterRecoverResult
      | { readonly outcome: "failed"; readonly detail: string } =
      recover === undefined
        ? {
            outcome: "unsupported",
            detail: `the ${adapter.id} runtime cannot restart an ended executor on its own disk`,
          }
        : yield* Effect.tryPromise({
            try: () =>
              recover.call(adapter, {
                resourceId,
                ...(reference === null ? {} : { reference }),
              }),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed({
                outcome: "failed" as const,
                detail: error instanceof Error ? error.message : String(error),
              }),
            ),
          );
    switch (recovered.outcome) {
      case "missing": {
        const detail = `the runtime no longer knows the retained executor (${instance.adapter} ${resourceId}); whatever it held that was not saved is lost`;
        yield* Effect.logError(`${prefix}: LOST · ${detail}.`);
        yield* ledger.observe(runId, { state: "gone", detail });
        return "lost" as const;
      }
      case "unsupported":
        yield* (row.recoveryAttempts === 0 ? Effect.logError : Effect.logWarning)(
          `${prefix}: not saved · retained · cannot be recovered automatically: ${recovered.detail}`,
        );
        return yield* retry(recovered.detail);
      case "failed":
        if (restarts) {
          yield* Effect.tryPromise(() => stager.removeSecretEnv(runId)).pipe(
            Effect.catchCause(() => Effect.void),
          );
        }
        yield* Effect.logError(
          `${prefix}: not saved · retained · recovering the executor failed (attempt ${String(row.recoveryAttempts + 1)}): ${recovered.detail}. It is kept; the next attempt follows the backoff.`,
        );
        return yield* retry(recovered.detail);
      case "restarted":
      case "running":
        break;
    }
    if (recovered.outcome === "restarted") {
      yield* Effect.logWarning(
        `${prefix}: the retained executor (${instance.adapter} ${resourceId}) was restarted on its own disk; asking its daemon for a final flush.`,
      );
    }

    const target = sealantTargetForRuntimeInstance(instance, options.targetOptions ?? {});
    if (target === undefined) {
      yield* Effect.logError(
        `${prefix}: not saved · retained · the executor is up but this worker cannot reach its daemon (${instance.adapter}); configure the worker's control reach.`,
      );
      return yield* retry("the executor is up but this worker cannot reach its daemon");
    }
    const outcome = yield* drainCaptureBeforeStop({
      runId,
      target,
      ledger,
      settings: options.captureDrain.settings,
      budgetMs: options.captureDrain.budgetMs ?? DEFAULT_DRAIN_BUDGET_MS,
      label: "recovery",
      runtimeState: runtimeNow.pipe(
        Effect.map((value) => (value === "unknown" ? ("running" as const) : value)),
      ),
    });
    if (restarts) {
      // The daemon read its token at boot (its control socket answered before this drain).
      yield* Effect.tryPromise(() => stager.removeSecretEnv(runId)).pipe(
        Effect.catchCause(() => Effect.void),
      );
    }
    if (outcome.kind === "drained") {
      return yield* release("observed-complete");
    }
    if (outcome.kind === "gone") {
      const detail = `the recovered executor vanished before its final flush completed (${outcome.detail}); whatever it held that was not saved is lost`;
      yield* Effect.logError(`${prefix}: LOST · ${detail}.`);
      yield* ledger.observe(runId, { state: "gone", detail });
      return "lost" as const;
    }
    // Still shipping, or another drain holds it: come back soon, not on the long backoff.
    const moving = outcome.kind === "pending" || outcome.kind === "busy";
    return yield* retry(
      `the recovered executor's final flush is not complete yet (${outcome.kind})`,
      moving ? backoff.baseMs : nextRecoveryDelayMs(row.recoveryAttempts, backoff),
    );
  });

export interface RecoverRetainedExecutorsRunOptions extends RecoverRetainedExecutorsOptions {
  readonly db: DB;
}

export const recoverRetainedExecutors = (
  options: RecoverRetainedExecutorsRunOptions,
): Promise<ReadonlyMap<string, RecoveryOutcome>> => {
  const { db, ...effectOptions } = options;
  const dataAccessLayer = Layer.mergeAll(
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceCaptureDrainRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));
  return Effect.runPromise(
    recoverRetainedExecutorsEffect(effectOptions).pipe(
      Effect.provide(Layer.mergeAll(dataAccessLayer, SealantRuntimeControlLive)),
    ),
  );
};
