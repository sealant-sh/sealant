/**
 * Kubernetes reconciliation after a worker restart or a lost message: every workspace Pod the
 * worker manages (by label) must correspond to a runtime instance that is still meant to run.
 * Anything else — an instance row marked stopped, or no row at all — is torn down through the
 * adapter's idempotent stop. Best-effort per run id; one failure never aborts the sweep.
 */
import {
  SealantDB,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import type { KubernetesRuntimeAdapter } from "../runtime/kubernetes/adapter.js";

export interface ReapOrphanedKubernetesResourcesOptions {
  readonly db: DB;
  readonly adapter: KubernetesRuntimeAdapter;
  readonly maxReapsPerTick?: number;
}

const DEFAULT_MAX_REAPS_PER_TICK = 10;

export const reapOrphanedKubernetesResources = async (
  options: ReapOrphanedKubernetesResourcesOptions,
): Promise<number> => {
  const maxReaps = options.maxReapsPerTick ?? DEFAULT_MAX_REAPS_PER_TICK;
  const program = Effect.gen(function* () {
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
      const wanted =
        instance !== undefined && instance.status !== "stopped" && instance.status !== "failed";
      if (wanted) {
        continue;
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
  });
  return Effect.runPromise(
    program.pipe(
      Effect.provide(
        WorkspaceRuntimeInstanceRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, options.db))),
      ),
    ),
  );
};
