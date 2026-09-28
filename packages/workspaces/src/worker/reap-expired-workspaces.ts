import type { CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepoLive,
  SealantDB,
  WorkspaceAttemptRepoLive,
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { SealantRuntimeControlLive } from "../sealantd/runtime.js";
import type { SealantTargetDerivationOptions } from "../sealantd/target.js";
import type { CaptureDrainLedger, CaptureDrainSettings } from "./capture-drain.js";
import { processWorkspaceStopEffect, type WorkspaceStopOutcome } from "./process-workspace-stop.js";

export interface ReapExpiredWorkspacesOptions {
  readonly db: DB;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  /** Upper bound on workspaces stopped per tick, so a sweep can't run unbounded. Defaults to 5. */
  readonly maxReapsPerTick?: number;
  /**
   * Enables the shared stop path's pre-teardown credential sync-back (rotated claude/codex
   * session files are read back before the container is destroyed). Undefined when
   * SEALANT_CREDENTIALS_KEY is not configured on the worker.
   */
  readonly credentialCipher?: CredentialCipherService;
  /** How this worker reaches each runtime family (client TLS for Kubernetes). */
  readonly targetOptions?: SealantTargetDerivationOptions;
  /**
   * Drain capture-sourced workspaces before stopping them (no loss of work product). The ledger
   * is durable and shared by every stop path of every worker, so a drain spans ticks and workers
   * and never runs twice at once. Absent = stop without draining (tests, callers that drain
   * themselves).
   */
  readonly captureDrain?: {
    readonly ledger: CaptureDrainLedger;
    readonly settings: CaptureDrainSettings;
    /** How long one tick may wait on one workspace's queue before moving on. */
    readonly budgetMs?: number;
  };
}

const DEFAULT_MAX_REAPS_PER_TICK = 5;
/** One tick waits at most this long on one workspace's queue; the next tick picks it up again. */
const DEFAULT_DRAIN_BUDGET_PER_TICK_MS = 60_000;

/** Only a stop that did work counts against the per-tick budget: busy and kept cost a probe. */
const countsAsReaped = (outcome: WorkspaceStopOutcome): boolean =>
  outcome === "stopped" || outcome === "draining";

/**
 * Workspace runtime reaper: the convergence net that guarantees no container outlives its
 * workspace's intent. It sweeps the live runtime instances (status "ready", any adapter) and drives the shared
 * stop path (`processWorkspaceStopEffect`) for every instance that should not be running:
 *
 *  - **expired** — the workspace's TTL elapsed (`expiresAt <= now`); reason "expired".
 *  - **superseded** — the instance is no longer the workspace's `latestRunId` (a restart left it
 *    behind and the restart's stop message was lost); reason "user".
 *  - **stranded** — the workspace's stored status is "stopped" (the API recorded the stop intent)
 *    but the teardown was lost (queue outage, dead-lettered message, worker crash); reason "user".
 *  - **orphaned** — the workspace row is gone entirely; the container is torn down directly with
 *    reason "failed" (there is no row left to settle).
 *  - **retained** — a capture-sourced launch that failed after its runtime became ready, kept
 *    with `LAUNCH_RETAINED_ERROR_CODE`; reason "failed", workspace row untouched.
 *
 * Every one of those is platform-initiated, so with `captureDrain` a capture-sourced workspace is
 * drained first and stopped only once the daemon confirms its final flush complete
 * (`capture-drain.ts`); a queue still moving is revisited next tick, one that cannot be confirmed
 * is kept (`not saved · kept`).
 *
 * Best-effort per item: one failure never aborts the sweep. No leader election — the adapter stop
 * and both status writes are idempotent, so concurrent reapers are safe.
 */
export const reapExpiredWorkspacesEffect = (options: Omit<ReapExpiredWorkspacesOptions, "db">) => {
  const { maxReapsPerTick, runtimeAdapters, credentialCipher, targetOptions } = options;
  const maxReaps = maxReapsPerTick ?? DEFAULT_MAX_REAPS_PER_TICK;
  const drainFor = (label: string) =>
    options.captureDrain === undefined
      ? {}
      : {
          captureDrain: {
            ledger: options.captureDrain.ledger,
            settings: options.captureDrain.settings,
            budgetMs: options.captureDrain.budgetMs ?? DEFAULT_DRAIN_BUDGET_PER_TICK_MS,
            label,
          },
        };

  return Effect.gen(function* () {
    const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
    const workspaces = yield* WorkspaceRepo;

    const live = yield* runtimeInstances.listRunningInstances();
    const now = Date.now();

    let reaped = 0;
    for (const instance of live) {
      if (reaped >= maxReaps) {
        break;
      }

      // Best-effort per instance: resolve the workspace, decide, stop. Any failure is logged and
      // the sweep moves on.
      const ok = yield* Effect.gen(function* () {
        const workspace = yield* workspaces.getWorkspaceByAttemptId(instance.runId);

        if (workspace === undefined) {
          // Orphaned: live container, workspace row gone.
          const outcome = yield* processWorkspaceStopEffect({
            runId: instance.runId,
            stopReason: "failed",
            runtimeAdapters,
            ...(credentialCipher === undefined ? {} : { credentialCipher }),
            ...(targetOptions === undefined ? {} : { targetOptions }),
            ...drainFor("orphan reaper"),
          });
          return countsAsReaped(outcome);
        }

        const isCurrentRuntime = workspace.latestRunId === instance.runId;
        const expired = workspace.expiresAt !== null && workspace.expiresAt.getTime() <= now;
        const stranded = isCurrentRuntime && workspace.status === "stopped";
        const superseded = !isCurrentRuntime;

        if (!expired && !stranded && !superseded) {
          return false;
        }

        const outcome = yield* processWorkspaceStopEffect({
          // The workspace row only settles for its CURRENT runtime (the shared stop path guards
          // this too); a superseded instance must not stamp "stopped" onto a relaunching workspace.
          ...(isCurrentRuntime ? { workspaceId: workspace.id } : {}),
          runId: instance.runId,
          stopReason: expired ? "expired" : "user",
          runtimeAdapters,
          ...(credentialCipher === undefined ? {} : { credentialCipher }),
          ...(targetOptions === undefined ? {} : { targetOptions }),
          ...drainFor(
            expired ? "expiry reaper" : superseded ? "superseded reaper" : "stranded reaper",
          ),
        });
        return countsAsReaped(outcome);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Expiry reaper: stopping workspace runtime for run ${instance.runId} failed.`,
            cause,
          ).pipe(Effect.as(false)),
        ),
      );

      if (ok) {
        reaped += 1;
      }
    }

    // Retained launches: a capture-sourced launch that failed after its runtime became ready was
    // kept, not removed (a writer may already have run). Drain it, then stop it, through the same
    // path. The workspace row is left alone: the launch failed, and its stored status is the
    // API's intent anchor.
    const retained = yield* runtimeInstances.listRetainedLaunches();
    for (const instance of retained) {
      if (reaped >= maxReaps) {
        break;
      }
      const ok = yield* processWorkspaceStopEffect({
        runId: instance.runId,
        stopReason: "failed",
        runtimeAdapters,
        ...(credentialCipher === undefined ? {} : { credentialCipher }),
        ...(targetOptions === undefined ? {} : { targetOptions }),
        ...drainFor("retained launch"),
      }).pipe(
        Effect.map(countsAsReaped),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Expiry reaper: releasing the retained launch of run ${instance.runId} failed.`,
            cause,
          ).pipe(Effect.as(false)),
        ),
      );
      if (ok) {
        reaped += 1;
      }
    }

    return reaped;
  });
};

export const reapExpiredWorkspaces = async (
  options: ReapExpiredWorkspacesOptions,
): Promise<number> => {
  const { db, ...effectOptions } = options;
  const dataAccessLayer = Layer.mergeAll(
    WorkspaceRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
    // The shared stop path's pre-teardown credential sync-back needs the attempt snapshot (for
    // the blueprint refs), the connected-account repo, and the docker exec bridge.
    WorkspaceAttemptRepoLive,
    ConnectedAccountRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));

  return Effect.runPromise(
    reapExpiredWorkspacesEffect(effectOptions).pipe(
      Effect.provide(Layer.mergeAll(dataAccessLayer, SealantRuntimeControlLive)),
    ),
  );
};
