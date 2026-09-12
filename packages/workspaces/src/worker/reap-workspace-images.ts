import {
  SealantDB,
  WorkspaceBuildJobRepo,
  WorkspaceBuildJobRepoLive,
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
  type PublishedWorkspaceImage,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import { parsePublishedReference } from "../images/plan-coordinates.js";
import type { RegistryClient } from "../registry/client.js";

export interface ReapWorkspaceImagesOptions {
  readonly db: DB;
  readonly registryClient: RegistryClient;
  /**
   * How many distinct build plans keep their newest image even with no workspace on them, so the
   * plan-hash short-circuit still answers the next create from the store. Defaults to 3.
   */
  readonly retainedPlans?: number;
  /** Upper bound on deletes per tick, so one sweep can't monopolize the daemon. Defaults to 25. */
  readonly maxDeletesPerTick?: number;
}

export interface WorkspaceImageReapSummary {
  /** Distinct digests the sweep decided to keep. */
  readonly kept: number;
  readonly deleted: number;
  /** Refused by the store because a container still references the image; retried next tick. */
  readonly inUse: number;
  /** Already gone from the store. */
  readonly missing: number;
  /** The store threw; logged and left for the next tick. */
  readonly failed: number;
  /** Candidates beyond `maxDeletesPerTick`, left for the next tick. */
  readonly deferred: number;
}

const DEFAULT_RETAINED_PLANS = 3;
const DEFAULT_MAX_DELETES_PER_TICK = 25;

/** Workspace statuses whose image a launch or a running container may still need. */
const LIVE_WORKSPACE_STATUSES = ["queued", "running", "ready"] as const;

/**
 * Workspace image retention: the sweep that keeps the image store from growing without bound. Every
 * build publishes one image; a restart re-enqueues a build (which the plan-hash short-circuit
 * turns into a reuse when the plan is unchanged), and a stopped workspace never launches from its
 * old image directly. So an image is worth keeping only while:
 *
 *  - a **live workspace** (queued, running, ready) or a **running runtime instance** was launched
 *    from it — its latest build job's digest; or
 *  - it is the **newest publish of one of the last N distinct plans** — the reuse target the next
 *    create with that plan finds by hash.
 *
 * Everything else the build-job history says was published is deleted through the store: on the
 * Engine store an `image rm -f` by image id (refused, and kept, while any container references
 * it), on a registry a manifest delete. Best-effort per image: one failure never aborts the sweep,
 * and the job rows are never touched — they stay the audit trail of what was built.
 */
export const reapWorkspaceImages = async (
  options: ReapWorkspaceImagesOptions,
): Promise<WorkspaceImageReapSummary> => {
  const retainedPlans = options.retainedPlans ?? DEFAULT_RETAINED_PLANS;
  const maxDeletes = options.maxDeletesPerTick ?? DEFAULT_MAX_DELETES_PER_TICK;

  const dataAccessLayer = Layer.mergeAll(
    WorkspaceRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceBuildJobRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, options.db)));

  const program = Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
    const jobs = yield* WorkspaceBuildJobRepo;

    const published = yield* jobs.listPublishedImages();
    const keep = new Set<string>();

    // Live workspaces and running containers: whatever their latest build published.
    const liveWorkspaces = yield* workspaces.listWorkspaces({
      statuses: [...LIVE_WORKSPACE_STATUSES],
      limit: 100_000,
    });
    const runIds = new Set<string>();
    for (const workspace of liveWorkspaces) {
      if (workspace.latestRunId !== null) runIds.add(workspace.latestRunId);
    }
    for (const instance of yield* runtimeInstances.listRunningInstances()) {
      runIds.add(instance.runId);
    }
    const latestJobs = yield* jobs.listLatestJobsByRunIds([...runIds]);
    for (const job of latestJobs.values()) {
      if (job.publishedDigest !== null) keep.add(job.publishedDigest);
    }
    // Belt and braces: a live run whose latest job is a reuse still names the reused digest.
    for (const image of published) {
      if (image.runId !== null && runIds.has(image.runId)) keep.add(image.digest);
    }

    // The newest publish of each of the last N distinct plans (rows arrive newest first).
    const retainedPlanHashes = new Set<string>();
    for (const image of published) {
      if (image.planHash === null) continue;
      if (retainedPlanHashes.has(image.planHash)) continue;
      if (retainedPlanHashes.size >= retainedPlans) continue;
      retainedPlanHashes.add(image.planHash);
      keep.add(image.digest);
    }

    // Candidates: every other digest, once each, attributed to the repository it was published in.
    const candidates = new Map<string, PublishedWorkspaceImage>();
    for (const image of published) {
      if (keep.has(image.digest) || candidates.has(image.digest)) continue;
      candidates.set(image.digest, image);
    }

    const summary = { kept: keep.size, deleted: 0, inUse: 0, missing: 0, failed: 0, deferred: 0 };
    let attempted = 0;
    for (const image of candidates.values()) {
      if (attempted >= maxDeletes) {
        summary.deferred += 1;
        continue;
      }
      attempted += 1;
      const repository =
        parsePublishedReference(image.publishedReference)?.repository ?? image.repository;
      const outcome = yield* Effect.tryPromise(() =>
        options.registryClient.deleteImage({ repository, digest: image.digest }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Image retention: deleting ${image.digest} (${repository}) failed.`,
            cause,
          ).pipe(Effect.as("failed" as const)),
        ),
      );
      switch (outcome) {
        case "deleted":
          summary.deleted += 1;
          break;
        case "in-use":
          summary.inUse += 1;
          break;
        case "missing":
          summary.missing += 1;
          break;
        case "failed":
          summary.failed += 1;
          break;
      }
    }
    return summary;
  });

  return Effect.runPromise(program.pipe(Effect.provide(dataAccessLayer)));
};
