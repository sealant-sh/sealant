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

import type { MicrovmImageApi } from "../images/microvm/image-api.js";
import { isMicrovmImageNameOf, microvmImageName } from "../images/microvm/recipe.js";
import { parsePublishedReference } from "../images/plan-coordinates.js";
import type { RegistryClient } from "../registry/client.js";
import { parseMicrovmImageReference } from "../runtime/microvm/image-reference.js";

export interface ReapWorkspaceImagesOptions {
  readonly db: DB;
  readonly registryClient: RegistryClient;
  /**
   * The account's MicroVM images, where the worker builds them. A MicroVM image is not in any
   * registry, so it is deleted here; without this, such images are left alone. An image of this
   * control plane's that no build job names (a build that died after `CreateMicrovmImage`, a
   * database started fresh) is swept by the same rules. It is told by its name, `<namePrefix>-<plan
   * hash>`, since a listing carries no tags, and aged by its creation time.
   */
  readonly microvmImages?: {
    readonly api: Pick<MicrovmImageApi, "deleteImage" | "listImages">;
    readonly namePrefix: string;
  };
  /**
   * How many distinct build plans keep their newest image even with no workspace on them, so the
   * plan-hash short-circuit still answers the next create from the store. Defaults to 10.
   */
  readonly retainedPlans?: number;
  /**
   * Images published more recently than this are never deleted, whatever the plan count says: a
   * plan someone built this week is a plan they are still using. Defaults to 7 days.
   */
  readonly minAgeMs?: number;
  readonly now?: number;
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

const DEFAULT_RETAINED_PLANS = 10;
const DEFAULT_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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
 *    create with that plan finds by hash; or
 *  - it was **published within the minimum age** — recent builds are in use whatever the plan
 *    count says.
 *
 * Everything else the build-job history says was published is deleted through the store: on the
 * Engine store an `image rm -f` by image id (refused, and kept, while any container references
 * it), on a registry a manifest delete, on Lambda MicroVMs a `DeleteMicrovmImage`. There one plan is
 * one image whose digest is the plan hash, so every workspace on a plan keeps the same image. Best-effort per image: one failure never aborts the sweep,
 * and the job rows are never touched — they stay the audit trail of what was built.
 */
export const reapWorkspaceImages = async (
  options: ReapWorkspaceImagesOptions,
): Promise<WorkspaceImageReapSummary> => {
  const retainedPlans = options.retainedPlans ?? DEFAULT_RETAINED_PLANS;
  const maxDeletes = options.maxDeletesPerTick ?? DEFAULT_MAX_DELETES_PER_TICK;
  const publishedAfter = (options.now ?? Date.now()) - (options.minAgeMs ?? DEFAULT_MIN_AGE_MS);

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

    // Anything published within the minimum age, whatever plan it belongs to.
    for (const image of published) {
      if (image.publishedAt.getTime() > publishedAfter) keep.add(image.digest);
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
      const microvmImage = parseMicrovmImageReference(image.publishedReference);
      if (microvmImage !== undefined) {
        if (options.microvmImages === undefined) continue;
        attempted += 1;
        const name = microvmImage.imageArn.slice(microvmImage.imageArn.lastIndexOf(":") + 1);
        const removed = yield* deleteMicrovmImage(options.microvmImages.api, name);
        if (removed === "deleted") summary.deleted += 1;
        else if (removed === "not-found") summary.missing += 1;
        else summary.failed += 1;
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

    // MicroVM images of this control plane's that no build job names.
    const microvmImages = options.microvmImages;
    if (microvmImages !== undefined) {
      const { api, namePrefix } = microvmImages;
      // Every name the job history accounts for: kept above, or a candidate the loop above owns.
      const accountedFor = new Set(
        [...keep, ...published.map((image) => image.digest)].map((digest) =>
          microvmImageName(planOf(digest), namePrefix),
        ),
      );
      const listed = yield* Effect.tryPromise(() => api.listImages(namePrefix)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Image retention: listing MicroVM images failed.", cause).pipe(
            Effect.as([] as Awaited<ReturnType<MicrovmImageApi["listImages"]>>),
          ),
        ),
      );
      for (const image of listed) {
        if (!isMicrovmImageNameOf(image.name, namePrefix) || accountedFor.has(image.name)) continue;
        // Still changing, or no creation time: not enough known to delete it.
        if (image.state === "CREATING" || image.state === "UPDATING") continue;
        if (image.state === "DELETING" || image.createdAt === undefined) continue;
        if (image.createdAt.getTime() > publishedAfter) continue;
        if (attempted >= maxDeletes) {
          summary.deferred += 1;
          continue;
        }
        attempted += 1;
        const removed = yield* deleteMicrovmImage(api, image.name);
        if (removed === "deleted") summary.deleted += 1;
        else if (removed === "not-found") summary.missing += 1;
        else summary.failed += 1;
      }
    }
    return summary;
  });

  return Effect.runPromise(program.pipe(Effect.provide(dataAccessLayer)));
};

const deleteMicrovmImage = (api: Pick<MicrovmImageApi, "deleteImage">, name: string) =>
  Effect.tryPromise(() => api.deleteImage(name)).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Image retention: deleting the MicroVM image ${name} failed.`, cause).pipe(
        Effect.as("failed" as const),
      ),
    ),
  );

/** A MicroVM image's digest is `sha256:<plan hash>`. */
const planOf = (digest: string): string => digest.slice(digest.indexOf(":") + 1);
