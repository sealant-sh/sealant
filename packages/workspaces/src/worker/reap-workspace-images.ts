import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join as joinPath } from "node:path";

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

import { hostVmDigestOfKey } from "../images/host-vm-disk.js";
import type { MicrovmImageApi } from "../images/microvm/image-api.js";
import { isMicrovmImageNameOf } from "../images/microvm/recipe.js";
import { parsePublishedReference } from "../images/plan-coordinates.js";
import type { RegistryClient } from "../registry/client.js";
import type { DockerCommandRunner } from "../runtime/docker-runtime-adapter.js";
import { HOST_VM_BASE_IMAGE_LABEL } from "../runtime/host-vm-runtime-adapter.js";

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

const identity = (image: PublishedWorkspaceImage) =>
  image.publication.kind === "oci"
    ? image.publication.image.digest
    : image.publication.image.imageArn;
const planHash = (image: PublishedWorkspaceImage) =>
  image.publication.kind === "microvm"
    ? image.publication.image.planHash
    : image.publication.evidence.planHash;

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
 * it), on a registry a manifest delete, on Lambda MicroVMs a `DeleteMicrovmImage`. Every version of a retained MicroVM
 * image keeps its ARN because deleting the image removes all versions. One failure never aborts the sweep,
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
      if (job.publication?.kind === "oci") keep.add(job.publication.image.digest);
      if (job.publication?.kind === "microvm") keep.add(job.publication.image.imageArn);
    }
    // Belt and braces: a live run whose latest job is a reuse still names the reused digest.
    for (const image of published) {
      if (image.runId !== null && runIds.has(image.runId)) keep.add(identity(image));
    }

    // The newest publish of each of the last N distinct plans (rows arrive newest first).
    const retainedPlanHashes = new Set<string>();
    for (const image of published) {
      const hash = planHash(image);
      if (hash === undefined) continue;
      if (retainedPlanHashes.has(hash)) continue;
      if (retainedPlanHashes.size >= retainedPlans) continue;
      retainedPlanHashes.add(hash);
      keep.add(identity(image));
    }

    // Anything published within the minimum age, whatever plan it belongs to.
    for (const image of published) {
      if (image.publishedAt.getTime() > publishedAfter) keep.add(identity(image));
    }

    // Candidates: every other digest, once each, attributed to the repository it was published in.
    const candidates = new Map<string, PublishedWorkspaceImage>();
    for (const image of published) {
      if (keep.has(identity(image)) || candidates.has(identity(image))) continue;
      candidates.set(identity(image), image);
    }

    const summary = { kept: keep.size, deleted: 0, inUse: 0, missing: 0, failed: 0, deferred: 0 };
    let attempted = 0;
    for (const image of candidates.values()) {
      if (attempted >= maxDeletes) {
        summary.deferred += 1;
        continue;
      }
      const publication = image.publication;
      if (publication.kind === "microvm") {
        if (options.microvmImages === undefined) continue;
        attempted += 1;
        const name = publication.image.imageArn.slice(
          publication.image.imageArn.lastIndexOf(":") + 1,
        );
        const removed = yield* deleteMicrovmImage(options.microvmImages.api, name);
        if (removed === "deleted") summary.deleted += 1;
        else if (removed === "not-found") summary.missing += 1;
        else summary.failed += 1;
        continue;
      }
      attempted += 1;
      const repository =
        parsePublishedReference(publication.image.reference)?.repository ??
        publication.image.repository;
      const outcome = yield* Effect.tryPromise(() =>
        options.registryClient.deleteImage({ repository, digest: identity(image) }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Image retention: deleting ${identity(image)} (${repository}) failed.`,
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
        published.flatMap((image) =>
          image.publication.kind === "microvm"
            ? [
                image.publication.image.imageArn.slice(
                  image.publication.image.imageArn.lastIndexOf(":") + 1,
                ),
              ]
            : [],
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

export interface HostVmBaseImageReapOptions {
  /** Where base disks and data disks live (`HostVmStorage`'s directories). */
  readonly imagesDir: string;
  readonly dataDir: string;
  readonly commandRunner: DockerCommandRunner;
  /**
   * A base disk younger than this is kept whatever names it: one a launch just built is named by
   * its run's row a moment later, before its runner exists. Defaults to an hour.
   */
  readonly minAgeMs?: number;
  readonly now?: number;
}

export interface HostVmBaseImageReapSummary {
  readonly kept: number;
  readonly deleted: number;
  readonly failed: number;
}

const DEFAULT_HOST_VM_BASE_IMAGE_MIN_AGE_MS = 60 * 60 * 1000;

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const pathExists = (path: string): Effect.Effect<boolean, unknown> =>
  Effect.tryPromise({ try: () => stat(path), catch: (error) => error }).pipe(
    Effect.as(true),
    Effect.catchIf(isMissing, () => Effect.succeed(false)),
  );

/**
 * Host VM base disk retention (§5.2): the sweep that deletes `<digest>.img` and its
 * `<digest>.config.json` once nothing can boot from them again. A base disk is kept while ANY of
 * these names its digest:
 *
 *  - a runner container, running or stopped (the `sealant.host-vm.base-image` label);
 *  - a run's row whose executor's removal was not confirmed, or whose data disk is still on disk
 *    (`host_vm_base_image_digest`): a retained executor whose stopped container was pruned
 *    (`docker container prune`) still needs its base disk for the recovery that recreates it;
 *  - the marker beside a data disk (`<data dir>/<container>/base-image-digest`), for a disk whose
 *    row is gone;
 *  - its own age: younger than `minAgeMs`.
 *
 * Anything this sweep cannot read (the container list, the rows, a data directory) keeps every
 * base disk this tick: a disk deleted wrongly is a workspace that cannot be recovered.
 */
export const reapHostVmBaseImagesEffect = (options: HostVmBaseImageReapOptions) =>
  Effect.gen(function* () {
    const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
    const now = options.now ?? Date.now();
    const minAgeMs = options.minAgeMs ?? DEFAULT_HOST_VM_BASE_IMAGE_MIN_AGE_MS;

    const entries = yield* Effect.tryPromise({
      try: () => readdir(options.imagesDir),
      catch: (error) => error,
    }).pipe(Effect.catchIf(isMissing, () => Effect.succeed([] as string[])));
    const files = new Map<string, string[]>();
    for (const entry of entries) {
      const match = /^(sha256-[a-f0-9]{64})\.(img|config\.json)$/.exec(entry);
      if (match === null) continue;
      const key = match[1] ?? "";
      files.set(key, [...(files.get(key) ?? []), entry]);
    }
    if (files.size === 0) return { kept: 0, deleted: 0, failed: 0 };

    const keep = new Set<string>();
    // Containers, running or stopped.
    const listed = yield* Effect.tryPromise({
      try: () =>
        options.commandRunner("docker", [
          "ps",
          "-a",
          "--filter",
          `label=${HOST_VM_BASE_IMAGE_LABEL}`,
          "--format",
          `{{.Label "${HOST_VM_BASE_IMAGE_LABEL}"}}`,
        ]),
      catch: (error) => error,
    });
    for (const digest of listed.stdout.split("\n")) {
      if (digest.trim().length > 0) keep.add(digest.trim());
    }
    // Rows: an executor not removed, or a data disk still there.
    for (const row of yield* runtimeInstances.listHostVmBaseImages()) {
      if (!row.removed || (yield* pathExists(row.dataDiskPath))) keep.add(row.baseImageDigest);
    }
    // Markers beside data disks. A data directory that is not there (an unmounted volume) fails
    // the tick: nothing can be said of the disks it holds.
    const dataEntries = yield* Effect.tryPromise({
      try: () => readdir(options.dataDir, { withFileTypes: true }),
      catch: (error) => error,
    });
    for (const entry of dataEntries) {
      // A stray file beside the runners' directories is no disk.
      if (!entry.isDirectory()) continue;
      const container = entry.name;
      const marker = yield* Effect.tryPromise({
        try: () => readFile(joinPath(options.dataDir, container, "base-image-digest"), "utf8"),
        catch: (error) => error,
      }).pipe(Effect.catchIf(isMissing, () => Effect.succeed("")));
      if (marker.trim().length > 0) keep.add(marker.trim());
    }

    let deleted = 0;
    let failed = 0;
    let kept = 0;
    for (const [key, names] of files) {
      const digest = hostVmDigestOfKey(key);
      if (digest === undefined || keep.has(digest)) {
        kept += 1;
        continue;
      }
      const youngest = yield* Effect.forEach(names, (name) =>
        Effect.tryPromise({
          try: () => stat(joinPath(options.imagesDir, name)),
          catch: (error) => error,
        }).pipe(
          Effect.map((stats) => stats.mtimeMs),
          Effect.catchIf(isMissing, () => Effect.succeed(0)),
        ),
      );
      if (youngest.some((mtime) => now - mtime < minAgeMs)) {
        kept += 1;
        continue;
      }
      // The disk first: once it is gone the pair is incomplete, and a launch builds it again.
      const removed = yield* Effect.forEach(
        names.toSorted((a, b) => (a.endsWith(".img") ? -1 : b.endsWith(".img") ? 1 : 0)),
        (name) => Effect.tryPromise(() => rm(joinPath(options.imagesDir, name), { force: true })),
      ).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning(`Host VM base disk retention: deleting ${key} failed.`, cause).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (removed) deleted += 1;
      else failed += 1;
    }
    return { kept, deleted, failed } satisfies HostVmBaseImageReapSummary;
  });

/** `reapHostVmBaseImagesEffect` against the database. */
export const reapHostVmBaseImages = (
  options: HostVmBaseImageReapOptions & { readonly db: DB },
): Promise<HostVmBaseImageReapSummary> => {
  const { db, ...rest } = options;
  return Effect.runPromise(
    reapHostVmBaseImagesEffect(rest).pipe(
      Effect.provide(
        WorkspaceRuntimeInstanceRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db))),
      ),
    ),
  );
};
