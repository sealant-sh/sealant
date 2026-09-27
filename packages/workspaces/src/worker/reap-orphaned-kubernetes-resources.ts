/**
 * Kubernetes reconciliation after a worker restart or a lost message: every workspace Pod the
 * worker manages (by label) must correspond to a runtime instance that is still meant to run.
 *
 *  - A Pod whose row is `stopped` (the stop path drained it first) or `failed` (it exited, or
 *    its launch failed before the daemon answered) is torn down through the adapter's idempotent
 *    stop.
 *  - A Pod whose row is `failed` with `LAUNCH_RETAINED_ERROR_CODE` is left to the retained-launch
 *    sweep, which drains it before it stops it.
 *  - A Pod with NO row at all — the launch could not record it (the database failed after the
 *    Pod came up) — may hold unsaved work. Unless its attempt snapshot says it is not
 *    capture-sourced, it is recorded as a retained launch (the Pod's deterministic identity), so
 *    the retained-launch sweep drains it; when even that write fails it is kept and logged, never
 *    deleted.
 *
 * Best-effort per run id; one failure never aborts the sweep.
 */
import {
  LAUNCH_RETAINED_ERROR_CODE,
  SealantDB,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import type { KubernetesRuntimeAdapter } from "../runtime/kubernetes/adapter.js";
import { blueprintSourceKind } from "./capture-drain.js";

export interface ReapOrphanedKubernetesResourcesOptions {
  readonly db: DB;
  readonly adapter: KubernetesRuntimeAdapter;
  readonly maxReapsPerTick?: number;
}

const DEFAULT_MAX_REAPS_PER_TICK = 10;

export const reapOrphanedKubernetesResourcesEffect = Effect.fn("reapOrphanedKubernetesResources")(
  function* (options: Omit<ReapOrphanedKubernetesResourcesOptions, "db">) {
    const maxReaps = options.maxReapsPerTick ?? DEFAULT_MAX_REAPS_PER_TICK;
    const instances = yield* WorkspaceRuntimeInstanceRepo;
    const managed = yield* Effect.promise(() => options.adapter.listManagedWorkspaces());
    if (managed.length === 0) {
      return 0;
    }
    const known = yield* instances.listRuntimeInstancesByRunIds(
      managed.map((entry) => entry.runId),
    );
    let reaped = 0;
    for (const { runId, resourceId } of managed) {
      if (reaped >= maxReaps) {
        break;
      }
      const instance = known.get(runId);
      if (instance !== undefined) {
        const wanted = instance.status !== "stopped" && instance.status !== "failed";
        const retained =
          instance.errorCode === LAUNCH_RETAINED_ERROR_CODE && instance.status === "failed";
        if (wanted || retained) {
          continue;
        }
      } else {
        // No row: the launch never recorded this Pod. Stop it only when its snapshot proves it
        // holds no captures; otherwise record it retained, so it is drained before any stop.
        const recorded = yield* recordUnrecordedPod(options.adapter, runId);
        if (recorded !== "not-capture") {
          continue;
        }
      }
      const ok = yield* Effect.tryPromise(() => options.adapter.stop({ resourceId })).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Kubernetes reconciler: removing orphaned resources for run ${runId} failed.`,
            cause,
          ).pipe(Effect.as(false)),
        ),
      );
      if (ok) {
        reaped += 1;
      }
    }
    return reaped;
  },
);

/**
 * A managed Pod with no runtime row: `not-capture` when the attempt snapshot names a source that
 * is not a capture (safe to remove, as before); otherwise the Pod is recorded as a retained
 * launch (`recorded`), or — the write failed, e.g. the attempt itself is gone — kept (`kept`).
 */
const recordUnrecordedPod = (adapter: KubernetesRuntimeAdapter, runId: string) =>
  Effect.gen(function* () {
    const attempts = yield* WorkspaceAttemptRepo;
    const instances = yield* WorkspaceRuntimeInstanceRepo;
    const snapshot = yield* attempts
      .getAttemptSnapshotByRunId(runId)
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    const kind =
      snapshot === undefined ? undefined : blueprintSourceKind(snapshot.blueprintPayload);
    if (kind !== undefined && kind !== "capture") {
      return "not-capture" as const;
    }
    const identity = adapter.launchIdentityFor(runId);
    return yield* instances
      .upsertRuntimeInstance({
        runId,
        status: "failed",
        errorCode: LAUNCH_RETAINED_ERROR_CODE,
        errorMessage:
          "The workspace Pod is running but its launch was never recorded; it was kept so no work is lost, and is drained before it is stopped.",
        adapter: identity.adapter,
        resourceId: identity.resourceId,
        reference: identity.reference,
        ...(identity.endpoint === undefined ? {} : { endpoint: identity.endpoint }),
        ...(kind === undefined ? {} : { sourceKind: kind }),
      })
      .pipe(
        Effect.tap(() =>
          Effect.logWarning(
            `Kubernetes reconciler: run ${runId} has a running Pod and no runtime row; recorded it as a retained launch (${kind === undefined ? "source unknown" : "capture-sourced"}) so it is drained before any stop.`,
          ),
        ),
        Effect.as("recorded" as const),
        Effect.catchCause((cause) =>
          Effect.logError(
            `Kubernetes reconciler: run ${runId} has a running Pod, no runtime row, and ${kind === undefined ? "no readable source" : "a capture source"}; recording it failed, so it is kept (not saved · kept). Remove it by hand only once its work is saved.`,
            cause,
          ).pipe(Effect.as("kept" as const)),
        ),
      );
  });

export const reapOrphanedKubernetesResources = async (
  options: ReapOrphanedKubernetesResourcesOptions,
): Promise<number> => {
  const { db, ...effectOptions } = options;
  return Effect.runPromise(
    reapOrphanedKubernetesResourcesEffect(effectOptions).pipe(
      Effect.provide(
        Layer.mergeAll(WorkspaceRuntimeInstanceRepoLive, WorkspaceAttemptRepoLive).pipe(
          Layer.provide(Layer.succeed(SealantDB, db)),
        ),
      ),
    ),
  );
};
