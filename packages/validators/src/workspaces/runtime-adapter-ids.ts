import { z } from "zod";

/**
 * The closed set of runtime adapter families a workspace can target. This is the ONE home of the
 * list: every enum, literal union, or column type that names runtime families derives from it, so
 * adding a family is an edit here plus an adapter registration — never a hunt through the repo.
 *
 * A family in this list is a *valid request*, not a promise: a deployment registers only the
 * adapters it is configured for, and `selectRuntimeAdapter` answers an unregistered family with a
 * readable "unsupported-runtime" error.
 *
 * - `docker`: containers on the worker's Docker daemon (the default deployment).
 * - `k8s` / `k3s`: workspace Pods on a cluster (k3s differs only in scheduling defaults).
 * - `cloudflare`: Cloudflare Sandboxes driven through a bridge Worker (hosted deployments).
 */
export const runtimeAdapterIds = ["docker", "k8s", "k3s", "cloudflare"] as const;

export const runtimeAdapterIdSchema = z.enum(runtimeAdapterIds);

export type RuntimeAdapterId = z.infer<typeof runtimeAdapterIdSchema>;
