import {
  WorkspaceBuildJobRepo,
  WorkspaceBuildJobRepoLive,
  SealantDB,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
} from "@sealant/db";
import { withProcessObservers } from "@sealant/observability";
import { Effect, Layer } from "effect";

import { asLaunchFollowUp } from "./launch-trace.js";
import {
  processWorkspaceBuildJob,
  type ProcessWorkspaceBuildJobOptions,
} from "./process-workspace-build-job.js";

export interface ReapStaleWorkspaceBuildJobsOptions extends Omit<
  ProcessWorkspaceBuildJobOptions,
  "jobId" | "parentSpan"
> {
  /** Upper bound on jobs re-driven per tick, so a sweep can't run unbounded. Defaults to 5. */
  readonly maxReapsPerTick?: number;
}

const DEFAULT_MAX_REAPS_PER_TICK = 5;

/**
 * Re-drive queued jobs and expired worker claims through the normal, atomically claimed path. Each
 * re-driven job is a trace of its own (`sealant.workspace.redrive_build`), linked to its launch
 * when the launch got far enough to record one.
 */
export const reapStaleWorkspaceBuildJobs = async (
  options: ReapStaleWorkspaceBuildJobsOptions,
): Promise<number> => {
  const { db, maxReapsPerTick, ...effectBase } = options;
  const maxReaps = maxReapsPerTick ?? DEFAULT_MAX_REAPS_PER_TICK;

  const dataAccessLayer = Layer.mergeAll(
    WorkspaceBuildJobRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));

  const program = Effect.gen(function* () {
    const jobs = yield* WorkspaceBuildJobRepo;
    const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
    const candidates = yield* jobs.listRecoverableJobs({ now: new Date(), limit: maxReaps });

    let reaped = 0;
    for (const job of candidates) {
      const instance =
        job.runId === null
          ? undefined
          : yield* runtimeInstances
              .getRuntimeInstanceByRunId(job.runId)
              .pipe(Effect.orElseSucceed(() => undefined));
      // Best-effort per job: a failure (or a lost claim race -> null) must not abort the sweep.
      const ok = yield* Effect.currentSpan.pipe(
        Effect.flatMap((span) =>
          Effect.tryPromise(() =>
            processWorkspaceBuildJob({ ...effectBase, db, jobId: job.id, parentSpan: span }),
          ),
        ),
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning(`Reaper: reprocessing build job ${job.id} failed.`, cause).pipe(
            Effect.as(false),
          ),
        ),
        asLaunchFollowUp("sealant.workspace.redrive_build", instance, {
          "sealant.job_id": job.id,
          ...(job.runId === null ? {} : { "sealant.run_id": job.runId }),
        }),
      );
      if (ok) {
        reaped += 1;
      }
    }
    return reaped;
  });

  return Effect.runPromise(withProcessObservers(program.pipe(Effect.provide(dataAccessLayer))));
};
