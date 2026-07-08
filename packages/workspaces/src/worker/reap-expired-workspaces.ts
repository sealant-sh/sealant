import {
  SealantDB,
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { processWorkspaceStopEffect } from "./process-workspace-stop.js";

export interface ReapExpiredWorkspacesOptions {
  readonly db: DB;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  /** Upper bound on workspaces stopped per tick, so a sweep can't run unbounded. Defaults to 5. */
  readonly maxReapsPerTick?: number;
}

const DEFAULT_MAX_REAPS_PER_TICK = 5;

/**
 * Workspace runtime reaper: the convergence net that guarantees no container outlives its
 * workspace's intent. It sweeps the live docker instances (status "ready") and drives the shared
 * stop path (`processWorkspaceStopEffect`) for every instance that should not be running:
 *
 *  - **expired** — the workspace's TTL elapsed (`expiresAt <= now`); reason "expired".
 *  - **superseded** — the instance is no longer the workspace's `latestRunId` (a restart left it
 *    behind and the restart's stop message was lost); reason "user".
 *  - **stranded** — the workspace's stored status is "stopped" (the API recorded the stop intent)
 *    but the teardown was lost (queue outage, dead-lettered message, worker crash); reason "user".
 *  - **orphaned** — the workspace row is gone entirely; the container is torn down directly with
 *    reason "failed" (there is no row left to settle).
 *
 * Best-effort per item: one failure never aborts the sweep. No leader election — the adapter stop
 * and both status writes are idempotent, so concurrent reapers are safe.
 */
export const reapExpiredWorkspaces = async (
  options: ReapExpiredWorkspacesOptions,
): Promise<number> => {
  const { db, maxReapsPerTick, runtimeAdapters } = options;
  const maxReaps = maxReapsPerTick ?? DEFAULT_MAX_REAPS_PER_TICK;

  const dataAccessLayer = Layer.mergeAll(WorkspaceRepoLive, WorkspaceRuntimeInstanceRepoLive).pipe(
    Layer.provide(Layer.succeed(SealantDB, db)),
  );

  const program = Effect.gen(function* () {
    const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
    const workspaces = yield* WorkspaceRepo;

    const live = yield* runtimeInstances.listRunningDockerInstances();
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
          yield* processWorkspaceStopEffect({
            runId: instance.runId,
            stopReason: "failed",
            runtimeAdapters,
          });
          return true;
        }

        const isCurrentRuntime = workspace.latestRunId === instance.runId;
        const expired = workspace.expiresAt !== null && workspace.expiresAt.getTime() <= now;
        const stranded = isCurrentRuntime && workspace.status === "stopped";
        const superseded = !isCurrentRuntime;

        if (!expired && !stranded && !superseded) {
          return false;
        }

        yield* processWorkspaceStopEffect({
          // The workspace row only settles for its CURRENT runtime (the shared stop path guards
          // this too); a superseded instance must not stamp "stopped" onto a relaunching workspace.
          ...(isCurrentRuntime ? { workspaceId: workspace.id } : {}),
          runId: instance.runId,
          stopReason: expired ? "expired" : "user",
          runtimeAdapters,
        });
        return true;
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

    return reaped;
  });

  return Effect.runPromise(program.pipe(Effect.provide(dataAccessLayer)));
};
