/**
 * Kubernetes reconciliation after a worker restart or a lost message: every workspace Pod the
 * worker manages (by label) must correspond to a runtime instance that is still meant to run.
 *
 *  - A Pod whose row is `stopped` or `failed` is torn down through the adapter's idempotent stop
 *    ONLY when the one preservation policy lets it go (`decideExecutorDeletion`): the run is not
 *    capture-sourced, or Core observed its final flush complete, the control plane attested a
 *    sealed final capture of it, or the owner discarded it. A capture Pod the exit reconciler
 *    kept (`failed`, `runtime-exited`: its emptyDir holds the staged captures) — or whose source,
 *    state or drain record cannot be read — is kept and recorded retained.
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

import {
  decideExecutorDeletion,
  type ExecutorDeletionBasis,
  type ExecutorRuntimeState,
} from "../runtime/executor-preservation.js";
import type { KubernetesRuntimeAdapter } from "../runtime/kubernetes/adapter.js";
import {
  blueprintSourceKind,
  describeDeletionBasis,
  recordedDeletionEvidence,
  authorizedDeletion,
  removeUnderDeletion,
  runIsCaptureSourced,
  type CaptureDrainLedger,
  type CaptureDrainRead,
  type DeletionTicket,
} from "./capture-drain.js";

export interface ReapOrphanedKubernetesResourcesOptions {
  readonly db: DB;
  readonly adapter: KubernetesRuntimeAdapter;
  readonly maxReapsPerTick?: number;
  /**
   * The drain ledger: what Core observed of each run's capture drain (a complete final flush,
   * an attestation, a discard). Absent = nothing is known, so no capture Pod is removed.
   */
  readonly ledger?: CaptureDrainLedger;
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
      // A capture Pod the policy let go ends its drain record once it is removed (below), under
      // the ticket holding a removal authorized on recorded evidence (decision 21).
      let captureRemoval: ExecutorDeletionBasis | undefined;
      let ticket: DeletionTicket | undefined;
      if (instance !== undefined) {
        const wanted = instance.status !== "stopped" && instance.status !== "failed";
        const retained =
          instance.errorCode === LAUNCH_RETAINED_ERROR_CODE && instance.status === "failed";
        if (wanted || retained) {
          continue;
        }
        const mayGo = yield* podMayGo(options, instance, resourceId);
        if (mayGo === false) {
          continue;
        }
        captureRemoval = mayGo === "not-capture" ? undefined : mayGo.basis;
        ticket = mayGo === "not-capture" ? undefined : mayGo.ticket;
      } else {
        // No row: the launch never recorded this Pod. Stop it only when its snapshot proves it
        // holds no captures; otherwise record it retained, so it is drained before any stop.
        const recorded = yield* recordUnrecordedPod(options.adapter, runId);
        if (recorded !== "not-capture") {
          continue;
        }
      }
      const ok = yield* removeUnderDeletion({
        ledger: options.ledger,
        runId,
        ticket,
        remove: Effect.tryPromise(() => options.adapter.stop({ resourceId })),
      }).pipe(
        Effect.map((removal) => removal.removed),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Kubernetes reconciler: removing orphaned resources for run ${runId} failed.`,
            cause,
          ).pipe(Effect.as(false)),
        ),
      );
      if (ok) {
        reaped += 1;
        if (captureRemoval !== undefined && options.ledger !== undefined) {
          // Its retention ends and the sealed capture token kept for its recovery is cleared.
          yield* options.ledger.observe(runId, {
            state: "stopped",
            detail: `the ended Pod was removed: ${describeDeletionBasis(captureRemoval)}`,
          });
        }
      }
    }
    return reaped;
  },
);

/**
 * The one preservation policy, for a Pod whose row says it should not run: its source (the row,
 * else the attempt snapshot; unreadable = capture), what the Pod is now, and the drain record.
 * A retained Pod is recorded retained (so recovery reports it) and kept (`false`). A Pod that may
 * go answers why: `not-capture`, or the policy's basis for a capture Pod. Never fails: a failed
 * read keeps the Pod.
 */
const podMayGo = (
  options: Omit<ReapOrphanedKubernetesResourcesOptions, "db">,
  instance: {
    readonly runId: string;
    readonly sourceKind: string | null;
    readonly reference: string | null;
  },
  resourceId: string,
) =>
  Effect.gen(function* () {
    const attempts = yield* WorkspaceAttemptRepo;
    const captureSourced = yield* runIsCaptureSourced({
      runId: instance.runId,
      sourceKind: instance.sourceKind,
      readSnapshotPayload: attempts.getAttemptSnapshotByRunId(instance.runId),
    });
    if (!captureSourced) {
      return "not-capture" as const;
    }
    const inspect = options.adapter.inspect;
    const runtime: ExecutorRuntimeState =
      typeof inspect !== "function"
        ? "unknown"
        : yield* Effect.tryPromise(() => inspect.call(options.adapter, { resourceId })).pipe(
            Effect.map((result) => result.state),
            Effect.catchCause(() => Effect.succeed("unknown" as const)),
          );
    // Decided on the evidence as it stands after the inspection, and authorized against it
    // (decision 18): a newer observation recorded meanwhile, or one in flight, keeps the Pod.
    const { decision, record, ticket, heldElsewhere } = yield* authorizedDeletion({
      ledger: options.ledger,
      runId: instance.runId,
      runtime,
      decide: (current: CaptureDrainRead) =>
        decideExecutorDeletion({
          captureSourced,
          runtime,
          ...recordedDeletionEvidence(current, {
            runId: instance.runId,
            resourceId,
            reference: instance.reference,
          }),
        }),
    });
    if (decision.delete) {
      return { basis: decision.basis, ticket };
    }
    if (heldElsewhere === true) {
      // Another path is removing it right now: kept here, not a retention.
      return false as const;
    }
    if (!(record.readable && record.entry?.retained !== undefined)) {
      yield* Effect.logError(
        `Kubernetes reconciler: run ${instance.runId}'s Pod ${resourceId} is capture-sourced and its row says it should not run, but ${decision.reason}: not saved · kept. It is not deleted.`,
      );
      yield* (
        options.ledger?.markRetained(instance.runId, `Pod ${resourceId} · ${decision.reason}`) ??
          Effect.void
      );
    }
    return false as const;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Kubernetes reconciler: deciding whether run ${instance.runId}'s Pod may go failed; it is kept this sweep.`,
        cause,
      ).pipe(Effect.as(false as const)),
    ),
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
