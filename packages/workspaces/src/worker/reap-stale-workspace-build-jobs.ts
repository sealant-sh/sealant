import {
  ConnectedAccountRepoLive,
  GitHubInstallationRepoLive,
  GitHubInstallationRepositoryCacheRepoLive,
  WorkspaceAttemptRepoLive,
  WorkspaceBuildJobRepo,
  WorkspaceBuildJobRepoLive,
  WorkspaceRuntimeInstanceRepoLive,
  SealantDB,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import {
  processWorkspaceBuildJobEffect,
  type ProcessWorkspaceBuildJobOptions,
} from "./process-workspace-build-job.js";

export interface ReapStaleWorkspaceBuildJobsOptions extends Omit<
  ProcessWorkspaceBuildJobOptions,
  "jobId"
> {
  /** Upper bound on jobs re-driven per tick, so a sweep can't run unbounded. Defaults to 5. */
  readonly maxReapsPerTick?: number;
}

const DEFAULT_MAX_REAPS_PER_TICK = 5;

/**
 * Re-drive workspace build jobs whose worker died mid-build — status `running` with an EXPIRED lease.
 *
 * Closes confirmed finding #5: when the lease holder dies (OOM/SIGKILL/eviction), the broker's
 * redelivery is acked-and-discarded (the worker treats `claimJobById -> null` as success), and with no
 * reaper the job never completes and never fails — it strands forever, surfacing only as an SDK
 * `ready()` timeout. This sweep is that missing reaper.
 *
 * Recovery reuses the normal path: `processWorkspaceBuildJobEffect` re-claims via `claimJobById` (whose
 * predicate matches `running AND lease-expired`) and reprocesses. Reprocessing is safe to repeat —
 * the image build/push is content-idempotent and launch adopts the existing container (Stage 1).
 *
 * No leader election: `claimJobById` is atomic, so if multiple replicas reap concurrently exactly one
 * wins each job and the rest no-op (claim returns null). True single-owner recovery + per-job lease
 * expiry arrive natively with the pg-boss migration (Stage 4), which retires this reaper.
 */
export const reapStaleWorkspaceBuildJobs = async (
  options: ReapStaleWorkspaceBuildJobsOptions,
): Promise<number> => {
  const { db, maxReapsPerTick, ...effectBase } = options;
  const maxReaps = maxReapsPerTick ?? DEFAULT_MAX_REAPS_PER_TICK;

  const dataAccessLayer = Layer.mergeAll(
    WorkspaceBuildJobRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceAttemptRepoLive,
    GitHubInstallationRepoLive,
    GitHubInstallationRepositoryCacheRepoLive,
    ConnectedAccountRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));

  const program = Effect.gen(function* () {
    const jobs = yield* WorkspaceBuildJobRepo;
    const running = yield* jobs.listJobsByStatus("running");
    const now = Date.now();
    const stale = running.filter(
      (job) => job.leaseExpiresAt !== null && job.leaseExpiresAt.getTime() <= now,
    );

    let reaped = 0;
    for (const job of stale.slice(0, maxReaps)) {
      // Best-effort per job: a failure (or a lost claim race -> null) must not abort the sweep.
      const ok = yield* processWorkspaceBuildJobEffect({ ...effectBase, jobId: job.id }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning(`Reaper: reprocessing stale build job ${job.id} failed.`, cause).pipe(
            Effect.as(false),
          ),
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
