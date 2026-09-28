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
 *     boots in its recovery mode (resumes its own staging without materializing over it; no
 *     dotfiles, no lifecycle step, no harness; admission closed), and this sweep drains it at
 *     once — the FINAL flush snapshots both classes and ships. Once the daemon reports the
 *     final flush complete, the executor is removed and the retention ends. An executor is
 *     restarted only when its launch recorded a daemon with sealantd's recovery boot
 *     (`daemon_recovery_boot`, `daemon-recovery.ts`): an older daemon, or one of unknown build,
 *     would run its ordinary boot over the work its disk holds, so it is kept and reported.
 *     A MicroVM whose daemon ended while the VM runs on (sealantd exited 75) keeps its disk until
 *     the platform's cap: its agent starts sealantd again in recovery mode on that disk, handed
 *     the kept capture token with the request, and it is drained the same way — the deadline
 *     sweep makes that recovery due before the cap.
 *     While it waits, an ended executor has nothing running beside it: its runtime stops what it
 *     no longer needs (`RuntimeAdapter.parkRetained`; Docker: its dockerd sidecar), never its
 *     disk.
 *     A recovery boot that finds nothing to save exits 76 (sealantd `EXIT_NOTHING_TO_SAVE`: the
 *     executor never materialized a capture — it died before its first materialize, e.g. at its
 *     first plan request — and capture starts before any user code, so nothing ran on it). The
 *     runtime reports it (`nothing-to-save`) and the executor is removed, the daemon's own words
 *     recorded with why. Exit 75 (not saved) stays a failed attempt: kept.
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
  runtimeRecoveryTakesSecretEnv,
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
  removeUnderDeletion,
  authorizedDeletion,
  type CaptureDrainLedger,
  type CaptureDrainSettings,
  type DeletionTicket,
} from "./capture-drain.js";

export interface RecoveryBackoff {
  /** The delay after the first failed attempt; doubles with each one after. */
  readonly baseMs: number;
  /** The longest delay between two attempts. */
  readonly maxMs: number;
}

/**
 * The first attempt runs as soon as the executor is retained (the worker starts a sweep when it
 * records one); a failed attempt is retried after 10 s, then 20 s, 40 s, … up to an hour. A
 * recovery that races a control plane still letting go of the session (a boot refused its plan)
 * gets its next chance within seconds, not minutes.
 */
export const DEFAULT_RECOVERY_BACKOFF: RecoveryBackoff = {
  baseMs: 10_000,
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
  /**
   * Only these runs: the executors just recorded retained, recovered at once rather than behind
   * whatever else is due. Absent: every due retention.
   */
  readonly runIds?: readonly string[];
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
  if (options.runIds !== undefined && options.runIds.length === 0) {
    return new Map<string, RecoveryOutcome>();
  }
  const due = yield* drains.listRetainedDue({
    limit: options.maxPerTick ?? DEFAULT_MAX_PER_TICK,
    ...(options.runIds === undefined ? {} : { runIds: options.runIds }),
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

    // Remove it and end the retention: only ever on a basis the policy (or the daemon's own
    // nothing-to-save answer) gave, under the ticket holding a removal authorized on recorded
    // evidence (decision 21: re-checked right before the runtime call, `deleted` after). `said`:
    // the daemon's words, kept with the record. Voided before the call (newer evidence): nothing
    // is removed and it is looked at again soon.
    const release = (basis: ExecutorDeletionBasis, ticket?: DeletionTicket, said?: string) =>
      Effect.gen(function* () {
        const removal = yield* removeUnderDeletion({
          ledger,
          runId,
          ticket,
          remove: Effect.tryPromise(() =>
            adapter.stop({ resourceId, ...(reference === null ? {} : { reference }) }),
          ),
        });
        if (!removal.removed) {
          return yield* retry(
            "its removal was voided by newer evidence before it was made",
            backoff.baseMs,
          );
        }
        yield* runtimeInstances.markStopped({ runId, stopReason });
        const detail = `the retained executor was removed: ${describeDeletionBasis(basis)}${
          said === undefined ? "" : ` (${said})`
        }`;
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
    const state = yield* runtimeNow;

    // An ended executor waits for its recovery with nothing running beside it: its runtime
    // stops what it no longer needs (Docker: its dockerd sidecar), never its disk. The recovery
    // boot runs no user code, so nothing it does needs them. Best-effort.
    const park = adapter.parkRetained;
    if (state === "exited" && park !== undefined) {
      yield* Effect.tryPromise(() =>
        park.call(adapter, { resourceId, ...(reference === null ? {} : { reference }) }),
      ).pipe(
        Effect.flatMap((parked) =>
          parked.stopped.length === 0
            ? Effect.void
            : Effect.logInfo(
                `${prefix}: the retained executor ended; stopped ${parked.stopped.join(", ")} beside it while it waits for its recovery (its disk is kept).`,
              ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `${prefix}: stopping what runs beside the ended executor failed; the next attempt tries again.`,
            cause,
          ),
        ),
      );
    }
    // Weighed on the evidence as it stands after the inspection and the parking, and authorized
    // against it (decision 18): an observation recorded meanwhile, or one in flight, is weighed,
    // never raced (review 6 #3).
    const first = yield* authorizedDeletion({
      ledger,
      runId,
      decide: (record) =>
        decideExecutorDeletion({
          captureSourced: true,
          runtime: state,
          ...recordedDeletionEvidence(record, executor),
        }),
    });
    const { decision } = first;
    if (decision.delete) {
      if (decision.basis === "missing") {
        const detail = `the runtime no longer knows the retained executor (${instance.adapter} ${resourceId}); whatever it held that was not saved is lost`;
        yield* Effect.logError(`${prefix}: LOST · ${detail}.`);
        yield* ledger.observe(runId, { state: "gone", detail });
        return "lost" as const;
      }
      return yield* release(decision.basis, first.ticket);
    }
    if (first.heldElsewhere === true) {
      return yield* retry("another path is removing the executor right now", backoff.baseMs);
    }

    // Recovery admission honours a removal (decision 21): an executor whose removal another
    // path holds is not started under it, and one that was removed is not recovered at all.
    const admission = yield* ledger.admitRecovery(runId);
    if (admission === "deleted") {
      const detail = `the retained executor was removed by another path (${instance.adapter} ${resourceId}), on the evidence its removal was authorized on`;
      yield* Effect.logWarning(`${prefix}: ${detail}; its retention ends.`);
      yield* ledger.observe(runId, { state: "stopped", detail });
      return "released" as const;
    }
    if (admission !== "admitted") {
      return yield* retry(
        admission === "deleting"
          ? "another path is removing the executor right now"
          : "whether another path is removing the executor cannot be read",
        backoff.baseMs,
      );
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
    // Docker's restart reads the token from the host directory it was created to read it from:
    // staged there again. The MicroVM agent takes it with the recovery request instead.
    const handsTokenOver = runtimeRecoveryTakesSecretEnv(adapter.id);
    let recoverySecretEnv: Readonly<Record<string, string>> | undefined;
    let restaged = false;
    if (restarts) {
      const token = yield* recoverCaptureToken(
        row.captureTokenSealed ?? null,
        options.credentialCipher,
      );
      const restage = handsTokenOver ? undefined : stager.restageSecretEnv;
      if (token === undefined || (!handsTokenOver && restage === undefined)) {
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
      recoverySecretEnv = { [CAPTURE_TOKEN_SECRET_ENV_NAME]: token };
    }
    const restage = stager.restageSecretEnv;
    if (restarts && !handsTokenOver && recoverySecretEnv !== undefined && restage !== undefined) {
      const secretEnv = recoverySecretEnv;
      const staged = yield* Effect.tryPromise({
        try: () => restage.call(stager, runId, secretEnv),
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
      restaged = true;
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
                ...(handsTokenOver && recoverySecretEnv !== undefined
                  ? { runId, secretEnv: recoverySecretEnv }
                  : {}),
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
      case "nothing-to-save": {
        // sealantd's recovery boot exited 76: the executor never materialized a capture (its
        // worktree is absent or holds only the boot lock), and capture starts before any user
        // code, so nothing ran on it and nothing is lost by removing it. Recorded with the
        // daemon's own words; exit 75 (not saved) never comes here.
        if (restaged) {
          yield* Effect.tryPromise(() => stager.removeSecretEnv(runId)).pipe(
            Effect.catchCause(() => Effect.void),
          );
        }
        yield* Effect.logWarning(
          `${prefix}: nothing to save · the recovery boot of ${instance.adapter} ${resourceId} found no materialized capture (${recovered.detail}); no user code ran on it. Removing it.`,
        );
        return yield* release("nothing-to-save", undefined, recovered.detail);
      }
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
        if (restaged) {
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
    if (restaged) {
      // The daemon read its token at boot (its control socket answered before this drain).
      yield* Effect.tryPromise(() => stager.removeSecretEnv(runId)).pipe(
        Effect.catchCause(() => Effect.void),
      );
    }
    if (outcome.kind === "drained") {
      // Its final flush read complete: removed only while the record still says so, authorized
      // against it (an observation recorded since, or in flight, keeps it).
      const drained = yield* authorizedDeletion({
        ledger,
        runId,
        decide: (record) => {
          const evidence = recordedDeletionEvidence(record, executor);
          return decideExecutorDeletion({
            captureSourced: true,
            runtime: "running",
            ...evidence,
            drainedNow: evidence.observedComplete,
          });
        },
      });
      if (drained.decision.delete) {
        return yield* release(drained.decision.basis, drained.ticket);
      }
      if (drained.heldElsewhere === true) {
        return yield* retry("another path is removing the executor right now", backoff.baseMs);
      }
      yield* Effect.logError(
        `${prefix}: not saved · retained · its final flush read complete, but ${drained.decision.reason}.`,
      );
      return yield* retry(drained.decision.reason, backoff.baseMs);
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
