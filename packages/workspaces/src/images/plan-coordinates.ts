/**
 * Where a workspace image lives in the registry: one repository per OS family, one tag per plan
 * hash. The image is a pure function of the rendered Containerfile (the plan hash), and nothing
 * from the workspace itself — the worktree, the owner, the session — is in it, so two workspaces
 * with the same plan share one image and one name.
 *
 * Before this, the SDK stamped every create with `<mount basename>:sdk-<random>`: the shared image
 * lived under whichever workspace happened to build it, every genuine rebuild landed under a new
 * repository, and a registry filled with hundreds of `wt-<id>` repositories that all held the same
 * few images. The build job's own `repository`/`tag` columns still record what the client asked
 * for; the worker publishes here.
 */

export interface ImageCoordinates {
  readonly repository: string;
  readonly tag: string;
}

export const PLAN_TAG_PREFIX = "plan-";
export const PLAN_REPOSITORY_PREFIX = "sealant-workspace-";
/** Enough of a sha256 to never collide across the plans one deployment will ever see. */
export const PLAN_TAG_HASH_LENGTH = 12;

/** An OCI path component: lowercase alphanumerics with `.`, `_`, `-` separators. */
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "") || "custom";

export const planImageCoordinates = (planned: {
  readonly osFamily: string;
  readonly planHash: string;
}): ImageCoordinates => ({
  repository: `${PLAN_REPOSITORY_PREFIX}${slug(planned.osFamily)}`,
  tag: `${PLAN_TAG_PREFIX}${planned.planHash.slice(0, PLAN_TAG_HASH_LENGTH)}`,
});

/**
 * The repository and tag a published reference (`<registry>/<repository>:<tag>`) was pushed as.
 * Null for a digest reference or anything without a tag — the caller then falls back to whatever
 * name the job recorded, which is what every publish before plan-keyed coordinates used.
 */
export const parsePublishedReference = (reference: string): ImageCoordinates | null => {
  if (reference.includes("@")) return null;
  const firstSlash = reference.indexOf("/");
  if (firstSlash === -1) return null;
  const path = reference.slice(firstSlash + 1);
  const lastColon = path.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === path.length - 1) return null;
  const repository = path.slice(0, lastColon);
  const tag = path.slice(lastColon + 1);
  if (repository === "" || repository.includes(":")) return null;
  return { repository, tag };
};
