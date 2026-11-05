import { WorkspaceBuildJobRepo, WorkspaceBuildJobRepoLive, SealantDB } from "@sealant/db";
import { Effect, Layer } from "effect";

import {
  processWorkspaceBuildJob,
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

/** Re-drive queued jobs and expired worker claims through the normal, atomically claimed path. */
export const reapStaleWorkspaceBuildJobs = async (
  options: ReapStaleWorkspaceBuildJobsOptions,
): Promise<number> => {
  const { db, maxReapsPerTick, ...effectBase } = options;
  const maxReaps = maxReapsPerTick ?? DEFAULT_MAX_REAPS_PER_TICK;

  const dataAccessLayer = WorkspaceBuildJobRepoLive.pipe(
    Layer.provide(Layer.succeed(SealantDB, db)),
  );

  const program = Effect.gen(function* () {
    const jobs = yield* WorkspaceBuildJobRepo;
    const candidates = yield* jobs.listRecoverableJobs({ now: new Date(), limit: maxReaps });

    let reaped = 0;
    for (const job of candidates) {
      // Best-effort per job: a failure (or a lost claim race -> null) must not abort the sweep.
      const ok = yield* Effect.tryPromise(() =>
        processWorkspaceBuildJob({ ...effectBase, db, jobId: job.id }),
      ).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning(`Reaper: reprocessing build job ${job.id} failed.`, cause).pipe(
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
