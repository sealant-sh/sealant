/**
 * Which workspace reaches which resource instance, and when an unreached instance stops: pure
 * functions of the rows Core stores. Every path that changes Docker (an `up`, a link, an executor's
 * launch and end, the reconciler's tick) converges it to `desiredAttachments`.
 */
import type { ResourceInstanceAlias, ResourceInstanceId } from "@sealant/api-contracts";
import type { LinkedExecutor, ResourceInstanceRecord, ResourceWorkspaceLink } from "@sealant/db";

import { instanceContainerName, reachNetworkName } from "./docker-resource-argv.js";

/** One instance joined to one executor's reach network under its alias. */
export interface ReachAttachment {
  readonly network: string;
  readonly executor: string;
  readonly instanceId: ResourceInstanceId;
  readonly container: string;
  readonly alias: ResourceInstanceAlias;
}

/** Same domain, and the instance is the project's (no worktree key) or the link's worktree's. */
export const reaches = (link: ResourceWorkspaceLink, instance: ResourceInstanceRecord): boolean =>
  link.resourceDomainId === instance.resourceDomainId &&
  (instance.spec.worktreeKey === null || instance.spec.worktreeKey === link.worktreeKey);

/** Every attachment Docker should hold: each live linked executor with each instance it reaches. */
export const desiredAttachments = (
  executors: ReadonlyArray<LinkedExecutor>,
  instances: ReadonlyArray<ResourceInstanceRecord>,
): ReadonlyArray<ReachAttachment> =>
  executors.flatMap((executor) =>
    instances
      .filter((instance) => instance.desired === "running" && reaches(executor, instance))
      .map((instance) => ({
        network: reachNetworkName(executor.executor),
        executor: executor.executor,
        instanceId: instance.id,
        container: instanceContainerName(instance.id),
        alias: instance.spec.alias,
      })),
  );

export type IdleVerdict =
  /** A live executor reaches it: its last reach is now. */
  | { readonly kind: "reached" }
  | { readonly kind: "waiting"; readonly stopsAt: Date }
  | { readonly kind: "stop" };

/**
 * An instance no live executor reaches stops `idleStopAfterSeconds` after the later of its start
 * and its last reach. One that never started has nothing to time.
 */
export const idleVerdict = (
  instance: ResourceInstanceRecord,
  reachedNow: boolean,
  now: Date,
): IdleVerdict => {
  if (reachedNow) return { kind: "reached" };
  const since = Math.max(
    instance.startedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    instance.lastReachedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  if (since === Number.NEGATIVE_INFINITY) {
    return {
      kind: "waiting",
      stopsAt: new Date(now.getTime() + instance.spec.idleStopAfterSeconds * 1000),
    };
  }
  const stopsAt = new Date(since + instance.spec.idleStopAfterSeconds * 1000);
  return stopsAt.getTime() <= now.getTime() ? { kind: "stop" } : { kind: "waiting", stopsAt };
};
