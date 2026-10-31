/**
 * Resource instance handlers (see the contract in `@sealant/api-contracts` `resource-instances.ts`).
 * Only a service key reaches them. Each writes what was asked in the repository first, then has the
 * runtime converge Docker to it, then records what the runtime observed: a repeat of any of them
 * finds nothing left to do.
 */
import {
  decodeResourceInstanceSpec,
  ResourceDomainForbiddenError,
  ResourceDomainInternalServerError,
  ResourceDomainNotActiveError,
  ResourceDomainNotFoundError,
  ResourceInstanceAliasTakenError,
  ResourceInstanceArchivedError,
  ResourceInstanceNotFoundError,
  ResourceInstanceSpecRefusedError,
  ResourceRuntimeUnsupportedError,
  ResourceWorkspaceLinkedElsewhereError,
  ResourceWorkspaceNotFoundError,
  ResourceWorktreeKey,
  type ResourceInstanceArchivedVolumeWire,
  type ResourceInstanceKey,
  type ResourceInstanceUpCause,
  type ResourceInstanceWire,
  type ResourceWorkspaceLinkWire,
} from "@sealant/api-contracts";
import { ResourceDomainRepo, ResourceInstanceRepo, type ResourceInstanceRecord } from "@sealant/db";
import {
  desiredAttachments,
  dockerFailureReason,
  instanceVolumeName,
  type ResourceRuntime,
} from "@sealant/workspaces";
import { Effect } from "effect";

import { ResourceRuntimeHost } from "../../services/resource-runtime.js";
import { CurrentPrincipal } from "../../services/service-principals.js";

const internal = (message: string) => () => new ResourceDomainInternalServerError({ message });

const requireServiceKey = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  if (principal.kind !== "service" && principal.kind !== "open") {
    return yield* new ResourceDomainForbiddenError({
      message: "A service key is required to manage resource instances.",
    });
  }
});

/** The Docker runtime, or the refusal that names the runtime this Sealant runs instead. */
export const requireDockerRuntime = Effect.gen(function* () {
  const host = yield* ResourceRuntimeHost;
  if (host.kind === "unsupported") {
    return yield* new ResourceRuntimeUnsupportedError({
      message: `resources run on Docker; this Sealant runs ${host.runtime}`,
      runtime: host.runtime,
    });
  }
  return host.runtime;
});

/** A runtime call; its failure is Docker's, said without the request it carried. */
const docker = <A>(what: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (error) =>
      new ResourceDomainInternalServerError({
        message: `Docker could not ${what}: ${dockerFailureReason(error)}`,
      }),
  });

const requireDomain = (resourceDomainId: string) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const domains = yield* ResourceDomainRepo;
    const domain = yield* domains
      .get(resourceDomainId)
      .pipe(Effect.mapError(internal("Failed to load the resource domain.")));
    if (domain === undefined) {
      return yield* new ResourceDomainNotFoundError({ message: "No such resource domain." });
    }
  });

const requireInstance = (resourceDomainId: string, key: ResourceInstanceKey) =>
  Effect.gen(function* () {
    yield* requireDomain(resourceDomainId);
    const repo = yield* ResourceInstanceRepo;
    const instance = yield* repo
      .get(resourceDomainId, key)
      .pipe(Effect.mapError(internal("Failed to load the resource instance.")));
    if (instance === undefined) {
      return yield* new ResourceInstanceNotFoundError({
        message: "This resource domain has no instance with that key.",
      });
    }
    return instance;
  });

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

export const toInstanceWire = (instance: ResourceInstanceRecord): ResourceInstanceWire => ({
  resourceInstanceId: instance.id,
  key: instance.key,
  alias: instance.spec.alias,
  worktreeKey: instance.spec.worktreeKey,
  specDigest: instance.specDigest,
  desired: instance.desired,
  stopReason: instance.stopReason,
  state: instance.observed,
  observedAt: instance.observedAt.toISOString(),
  startedAt: iso(instance.startedAt),
  lastReachedAt: iso(instance.lastReachedAt),
  volumes: (instance.volumes.length > 0 ? instance.volumes : instance.spec.volumes).map(
    (volume) => ({ name: volume.name, dockerName: instanceVolumeName(instance.id, volume.name) }),
  ),
});

/** Read the instance back after a write, so the answer is the row as it stands. */
const reread = (instance: ResourceInstanceRecord) =>
  Effect.gen(function* () {
    const repo = yield* ResourceInstanceRepo;
    const current = yield* repo
      .get(instance.resourceDomainId, instance.key)
      .pipe(Effect.mapError(internal("Failed to read the resource instance back.")));
    return current ?? instance;
  });

/** Converge one instance to running, and record what the runtime saw. */
export const startInstance = (runtime: ResourceRuntime, instance: ResourceInstanceRecord) =>
  Effect.gen(function* () {
    const repo = yield* ResourceInstanceRepo;
    const executors = yield* repo
      .linkedExecutors(instance.resourceDomainId)
      .pipe(Effect.mapError(internal("Failed to read the domain's linked workspaces.")));
    const started = yield* docker("start the instance", () =>
      runtime.up(instance, desiredAttachments(executors, [instance])),
    );
    yield* repo
      .recordObserved(instance.id, started.state, {
        ...(started.startedAt === undefined ? {} : { startedAt: started.startedAt }),
        ...(started.volumes === undefined ? {} : { volumes: started.volumes }),
      })
      .pipe(Effect.mapError(internal("Failed to record the instance's state.")));
    return yield* reread(instance);
  });

export const upResourceInstance = (
  resourceDomainId: string,
  key: ResourceInstanceKey,
  input: { readonly spec: unknown; readonly cause: ResourceInstanceUpCause },
) =>
  Effect.gen(function* () {
    yield* requireDomain(resourceDomainId);
    const runtime = yield* requireDockerRuntime;
    const decoded = decodeResourceInstanceSpec(input.spec);
    if (decoded.kind === "refused") {
      return yield* new ResourceInstanceSpecRefusedError({
        message: decoded.refusals.map((refusal) => refusal.reason).join("; "),
        refusals: decoded.refusals,
      });
    }
    const repo = yield* ResourceInstanceRepo;
    const outcome = yield* repo
      .up({ resourceDomainId, key, spec: decoded.spec, cause: input.cause })
      .pipe(Effect.mapError(internal("Failed to write the resource instance.")));
    switch (outcome.kind) {
      case "no-such-domain":
        return yield* new ResourceDomainNotFoundError({ message: "No such resource domain." });
      case "domain-not-active":
        return yield* new ResourceDomainNotActiveError({
          message: `This resource domain is ${outcome.state} and runs no new instance.`,
          state: outcome.state,
        });
      case "alias-taken":
        return yield* new ResourceInstanceAliasTakenError({
          message: `Another instance of this domain answers to '${decoded.spec.alias}' for the same worktree.`,
        });
      case "archived":
        return yield* new ResourceInstanceArchivedError({
          message: "This instance is archived; its volumes are kept, and it does not run again.",
        });
      case "upserted":
        // A person's stop holds against `use`: answer it stopped, as it stands.
        if (outcome.instance.desired !== "running") return toInstanceWire(outcome.instance);
        return toInstanceWire(yield* startInstance(runtime, outcome.instance));
    }
  });

export const listResourceInstances = (resourceDomainId: string, archived: boolean) =>
  Effect.gen(function* () {
    yield* requireDomain(resourceDomainId);
    const repo = yield* ResourceInstanceRepo;
    const instances = yield* repo
      .list(resourceDomainId, { archived })
      .pipe(Effect.mapError(internal("Failed to list the resource instances.")));
    return { items: instances.map(toInstanceWire) };
  });

export const getResourceInstance = (resourceDomainId: string, key: ResourceInstanceKey) =>
  Effect.map(requireInstance(resourceDomainId, key), toInstanceWire);

export const stopResourceInstance = (
  resourceDomainId: string,
  key: ResourceInstanceKey,
  by: string,
) =>
  Effect.gen(function* () {
    const instance = yield* requireInstance(resourceDomainId, key);
    if (instance.desired === "archived") {
      return yield* new ResourceInstanceArchivedError({ message: "This instance is archived." });
    }
    const runtime = yield* requireDockerRuntime;
    const repo = yield* ResourceInstanceRepo;
    const reason = { kind: "person", by } as const;
    yield* repo
      .setDesired(instance.id, { kind: "stop", reason })
      .pipe(Effect.mapError(internal("Failed to record the stop.")));
    yield* docker("stop the instance", () => runtime.stop(instance));
    yield* repo
      .recordObserved(instance.id, { kind: "stopped", at: new Date().toISOString(), reason })
      .pipe(Effect.mapError(internal("Failed to record the instance's state.")));
    return toInstanceWire(yield* reread(instance));
  });

/** Archive one instance: its container goes, every volume stays and is listed with its size. */
export const archiveInstance = (runtime: ResourceRuntime, instance: ResourceInstanceRecord) =>
  Effect.gen(function* () {
    const repo = yield* ResourceInstanceRepo;
    yield* repo
      .setDesired(instance.id, { kind: "archive" })
      .pipe(Effect.mapError(internal("Failed to record the archive.")));
    const volumes = yield* docker("archive the instance", () => runtime.archive(instance));
    yield* repo
      .recordObserved(instance.id, { kind: "archived", at: new Date().toISOString() })
      .pipe(Effect.mapError(internal("Failed to record the instance's state.")));
    return {
      instance: yield* reread(instance),
      volumes: volumes.map(
        (volume): ResourceInstanceArchivedVolumeWire => ({ instanceKey: instance.key, ...volume }),
      ),
    };
  });

export const archiveResourceInstance = (resourceDomainId: string, key: ResourceInstanceKey) =>
  Effect.gen(function* () {
    const instance = yield* requireInstance(resourceDomainId, key);
    const runtime = yield* requireDockerRuntime;
    const archived = yield* archiveInstance(runtime, instance);
    return { instance: toInstanceWire(archived.instance), volumes: archived.volumes };
  });

export const linkResourceWorkspace = (
  resourceDomainId: string,
  workspaceId: string,
  worktreeKey: ResourceWorktreeKey,
) =>
  Effect.gen(function* () {
    yield* requireDomain(resourceDomainId);
    const runtime = yield* requireDockerRuntime;
    const repo = yield* ResourceInstanceRepo;
    const outcome = yield* repo
      .link({ workspaceId, resourceDomainId, worktreeKey })
      .pipe(Effect.mapError(internal("Failed to link the workspace.")));
    switch (outcome.kind) {
      case "no-such-domain":
        return yield* new ResourceDomainNotFoundError({ message: "No such resource domain." });
      case "domain-not-active":
        return yield* new ResourceDomainNotActiveError({
          message: `This resource domain is ${outcome.state} and links no workspace.`,
          state: outcome.state,
        });
      case "no-such-workspace":
        return yield* new ResourceWorkspaceNotFoundError({ message: "No such workspace." });
      case "other-domain":
        return yield* new ResourceWorkspaceLinkedElsewhereError({
          message: "This workspace is linked to another resource domain.",
          resourceDomainId: outcome.resourceDomainId,
        });
      case "linked": {
        // Attach the executors it runs now; a later launch attaches its own (the worker's hook).
        const executors = (yield* repo
          .linkedExecutors(resourceDomainId)
          .pipe(Effect.mapError(internal("Failed to read the workspace's executors.")))).filter(
          (executor) => executor.workspaceId === workspaceId,
        );
        const instances = yield* repo
          .list(resourceDomainId, { archived: false })
          .pipe(Effect.mapError(internal("Failed to list the resource instances.")));
        const attachments = desiredAttachments(executors, instances);
        for (const { executor } of executors) {
          yield* docker("attach the workspace", () =>
            runtime.attachExecutor(executor, attachments),
          );
        }
        return {
          workspaceId,
          worktreeKey: ResourceWorktreeKey.make(outcome.link.worktreeKey),
          attachedExecutors: executors.length,
        } satisfies ResourceWorkspaceLinkWire;
      }
    }
  });

/**
 * Fence the domain, archive every instance (volumes kept), detach and unlink every workspace,
 * then mark it archived. A repeat finds nothing live and answers no volume.
 */
export const archiveResourceDomain = (resourceDomainId: string) =>
  Effect.gen(function* () {
    yield* requireDomain(resourceDomainId);
    const runtime = yield* requireDockerRuntime;
    const repo = yield* ResourceInstanceRepo;
    const failed = internal("Failed to archive the resource domain.");
    yield* repo.setDomainState(resourceDomainId, "fenced").pipe(Effect.mapError(failed));
    const volumes: Array<ResourceInstanceArchivedVolumeWire> = [];
    for (const instance of yield* repo
      .list(resourceDomainId, { archived: false })
      .pipe(Effect.mapError(failed))) {
      volumes.push(...(yield* archiveInstance(runtime, instance)).volumes);
    }
    for (const { executor } of yield* repo
      .linkedExecutors(resourceDomainId)
      .pipe(Effect.mapError(failed))) {
      yield* docker("detach a workspace", () => runtime.detachExecutor(executor));
    }
    for (const link of yield* repo.links(resourceDomainId).pipe(Effect.mapError(failed))) {
      yield* repo.unlink(link.workspaceId).pipe(Effect.mapError(failed));
    }
    yield* repo.setDomainState(resourceDomainId, "archived").pipe(Effect.mapError(failed));
    return { volumes };
  });
