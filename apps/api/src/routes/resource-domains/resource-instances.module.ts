/**
 * Resource instance handlers (see the contract in `@sealant/api-contracts` `resource-instances.ts`).
 * Only a service key reaches them. Each writes what was asked in the repository first, then has the
 * runtime converge Docker to it, then records what the runtime observed: a repeat of any of them
 * finds nothing left to do.
 */
import { randomUUID } from "node:crypto";

import {
  resourceInstanceSecretEnvSchema,
  decodeResourceInstanceSpec,
  ResourceDomainForbiddenError,
  ResourceDomainInternalServerError,
  ResourceDomainNotActiveError,
  ResourceDomainNotFoundError,
  ResourceInstanceAliasTakenError,
  ResourceInstanceBudgetError,
  ResourceInstanceArchivedError,
  ResourceInstanceNotFoundError,
  ResourceInstancePurgeRefusedError,
  ResourceInstanceSpecRefusedError,
  ResourceRuntimeUnsupportedError,
  ResourceWorkspaceLinkedElsewhereError,
  ResourceWorkspaceNotFoundError,
  ResourceWorkspaceWithoutResourcesError,
  type ResourceReachAliases,
  ResourceWorktreeKey,
  type ResourceInstanceArchivedVolumeWire,
  type ResourceInstanceKey,
  type ResourceInstanceId,
  type ResourceInstancePurgeResult,
  type ResourceInstanceUpCause,
  type ResourceInstanceWire,
  type ResourceWorkspaceLinkWire,
} from "@sealant/api-contracts";
import { CredentialCipher } from "@sealant/credentials";
import { ResourceDomainRepo, ResourceInstanceRepo, type ResourceInstanceRecord } from "@sealant/db";
import {
  desiredAttachments,
  dockerFailureReason,
  instanceVolumeName,
  callerInstanceName,
  makeResourceAccounting,
  type ResourceRuntime,
} from "@sealant/workspaces";
import { Schema } from "effect";
import { Effect } from "effect";

import { ResourceRuntimeHost } from "../../services/resource-runtime.js";
import { CurrentPrincipal } from "../../services/service-principals.js";

const internal = (message: string) => () => new ResourceDomainInternalServerError({ message });
const canonicalEnv = (env: Readonly<Record<string, string>>): string =>
  JSON.stringify(
    Object.fromEntries(Object.entries(env).toSorted(([a], [b]) => a.localeCompare(b))),
  );

const requireServiceKey = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  if (principal.kind !== "service" && principal.kind !== "open") {
    return yield* new ResourceDomainForbiddenError({
      message: "A service key is required to manage resource instances.",
    });
  }
});

/** The instance runtime, or a refusal naming this deployment's unsupported provider. */
export const requireDockerRuntime = Effect.gen(function* () {
  const host = yield* ResourceRuntimeHost;
  if (host.kind === "unsupported") {
    return yield* new ResourceRuntimeUnsupportedError({
      message: `Resource instances require Docker or Kubernetes; this Sealant runs ${host.runtime}.`,
      runtime: host.runtime,
    });
  }
  return host.runtime;
});

const requireWorkspaceRuntime = Effect.gen(function* () {
  const host = yield* ResourceRuntimeHost;
  if (host.kind === "kubernetes")
    return yield* new ResourceRuntimeUnsupportedError({
      message: "Kubernetes supports caller-only instances; workspace instances require Docker.",
      runtime: "kubernetes-workspace-reach",
    });
  return yield* requireDockerRuntime;
});
const requireInstanceRuntime = (instance: ResourceInstanceRecord) =>
  instance.spec.reach === undefined ? requireWorkspaceRuntime : requireDockerRuntime;

/** Provider errors are sanitized before reaching persistent state or an HTTP reply. */
const docker = <A>(what: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (error) =>
      new ResourceDomainInternalServerError({
        message: `The runtime could not ${what}: ${dockerFailureReason(error)}`,
      }),
  });

// Provider errors can contain credentials. Only the typed, deliberately public refusal escapes.
const purgeProvider = (call: () => Promise<void>) =>
  Effect.tryPromise({
    try: call,
    catch: (error) =>
      error instanceof ResourceInstancePurgeRefusedError
        ? error
        : new ResourceDomainInternalServerError({
            message:
              "The runtime could not finish the instance purge. Retry purge to finish cleanup.",
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
    return domain;
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

export const toInstanceWire = (
  instance: ResourceInstanceRecord,
  runtime?: ResourceRuntime,
): ResourceInstanceWire => ({
  ...(instance.spec.reach === undefined
    ? {}
    : {
        endpoint: runtime?.endpoint?.(instance) ?? {
          host: callerInstanceName(instance.id),
          port: instance.spec.reach.port,
          callbackHost: instance.spec.reach.caller,
        },
      }),
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
    (volume) => ({
      name: volume.name,
      dockerName:
        instance.spec.reach?.kind === "caller"
          ? `${callerInstanceName(instance.id)}-${volume.name}`
          : instanceVolumeName(instance.id, volume.name),
    }),
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
    const budgets = yield* ResourceDomainRepo;
    const accounting = makeResourceAccounting(repo, budgets);
    const admitted = yield* accounting.admit(instance).pipe(
      Effect.mapError((error) =>
        error instanceof ResourceInstanceBudgetError
          ? error
          : new ResourceDomainInternalServerError({
              message: "Failed to reserve the instance budget.",
            }),
      ),
    );
    const started = yield* docker("start the instance", () =>
      runtime.up(admitted, desiredAttachments(executors, [admitted])),
    );
    if (started.state.kind === "running")
      yield* accounting
        .created(admitted)
        .pipe(Effect.mapError(internal("Failed to confirm the instance budget.")));
    yield* repo
      .recordObserved(instance.id, started.state, {
        ...(started.startedAt === undefined ? {} : { startedAt: started.startedAt }),
        ...(started.volumes === undefined ? {} : { volumes: started.volumes }),
      })
      .pipe(Effect.mapError(internal("Failed to record the instance's state.")));
    return yield* reread(instance);
  });

const upResourceInstanceUnlocked = (
  resourceDomainId: string,
  key: ResourceInstanceKey,
  input: {
    readonly spec: unknown;
    readonly cause: ResourceInstanceUpCause;
    readonly secretEnv?: Readonly<Record<string, string>> | undefined;
  },
) =>
  Effect.gen(function* () {
    const domain = yield* requireDomain(resourceDomainId);
    const runtime = yield* requireDockerRuntime;
    const decoded = decodeResourceInstanceSpec(input.spec);
    if (decoded.kind === "refused") {
      return yield* new ResourceInstanceSpecRefusedError({
        message: decoded.refusals.map((refusal) => refusal.reason).join("; "),
        refusals: decoded.refusals,
      });
    }
    const spec = decoded.spec;
    if (((domain.ownerKind ?? "project") === "project") !== (spec.reach === undefined))
      return yield* new ResourceInstanceSpecRefusedError({
        message:
          "Caller reach requires an organization or instance scope; project scopes use workspace reach.",
        refusals: [{ field: "reach", reason: "scope owner and reach differ" }],
      });
    const host = yield* ResourceRuntimeHost;
    if (host.kind === "kubernetes" && spec.reach === undefined)
      return yield* new ResourceRuntimeUnsupportedError({
        message: "Kubernetes supports caller-only instances; workspace instances require Docker.",
        runtime: "kubernetes-workspace-reach",
      });
    if (spec.reach !== undefined)
      yield* Effect.try({
        try: () => runtime.validateCaller?.(spec),
        catch: () =>
          new ResourceInstanceSpecRefusedError({
            message:
              "The requested caller and callback port are not configured on this deployment.",
            refusals: [{ field: "reach", reason: "caller is not configured" }],
          }),
      });
    if (
      input.secretEnv !== undefined &&
      host.kind !== "unsupported" &&
      host.secretEnvAvailable === false
    )
      return yield* new ResourceInstanceSpecRefusedError({
        message: "Configure SEALANT_CREDENTIALS_KEY before supplying secret env.",
        refusals: [{ field: "secretEnv", reason: "credential encryption is not configured" }],
      });
    if (input.secretEnv !== undefined && spec.reach === undefined)
      return yield* new ResourceInstanceSpecRefusedError({
        message: "Secret env requires a caller-only instance.",
        refusals: [{ field: "secretEnv", reason: "caller reach required" }],
      });
    const repo = yield* ResourceInstanceRepo;
    const previous = yield* repo
      .get(resourceDomainId, key)
      .pipe(Effect.mapError(internal("Failed to load the previous instance.")));
    if (
      previous?.spec.reach !== undefined &&
      spec.reach !== undefined &&
      (previous.spec.reach.caller !== spec.reach.caller ||
        previous.spec.reach.port !== spec.reach.port ||
        previous.spec.reach.callbackPort !== spec.reach.callbackPort)
    )
      return yield* new ResourceInstanceSpecRefusedError({
        message:
          "An instance's caller, service port and callback port are immutable. Create another instance to change its network binding.",
        refusals: [{ field: "reach", reason: "retained network binding changed" }],
      });
    if (
      spec.reach !== undefined &&
      previous !== undefined &&
      previous.spec.volumes.some(
        (volume) =>
          !spec.volumes.some(
            (next) =>
              next.name === volume.name &&
              next.mountPath === volume.mountPath &&
              next.storageBytes === volume.storageBytes,
          ),
      )
    )
      return yield* new ResourceInstanceSpecRefusedError({
        message: "Retained volumes cannot be removed, renamed, resized or remounted by up.",
        refusals: [{ field: "volumes", reason: "retained volume mapping changed" }],
      });
    let secrets: { readonly sealed: string; readonly revision: string } | undefined;
    if (input.secretEnv !== undefined || previous?.secretEnvSealed != null) {
      const cipher = yield* CredentialCipher;
      const old =
        previous?.secretEnvSealed == null
          ? undefined
          : yield* cipher
              .decrypt(previous.secretEnvSealed)
              .pipe(Effect.mapError(internal("Failed to open retained secret env.")));
      const parsed = yield* (
        input.secretEnv === undefined
          ? Schema.decodeUnknownEffect(Schema.fromJsonString(resourceInstanceSecretEnvSchema))(old)
          : Schema.decodeUnknownEffect(resourceInstanceSecretEnvSchema)(input.secretEnv)
      ).pipe(Effect.mapError(internal("Secret env was refused.")));
      if (Object.keys(parsed).some((name) => Object.hasOwn(spec.env, name)))
        return yield* new ResourceInstanceSpecRefusedError({
          message: "Plain and secret env names must be distinct.",
          refusals: [{ field: "secretEnv", reason: "duplicate env name" }],
        });
      const plaintext = canonicalEnv(parsed);
      if (input.secretEnv !== undefined && old !== plaintext) {
        const sealed = yield* cipher
          .encrypt(plaintext)
          .pipe(Effect.mapError(internal("Failed to seal secret env.")));
        secrets = { sealed: sealed.sealed, revision: randomUUID() };
      }
    }
    const budgets = yield* ResourceDomainRepo;
    const outcome = yield* repo
      .transaction(
        Effect.gen(function* () {
          const written = yield* repo
            .up({
              resourceDomainId,
              key,
              spec: decoded.spec,
              cause: input.cause,
              ...(secrets === undefined ? {} : { secrets }),
            })
            .pipe(Effect.mapError(internal("Failed to write the resource instance.")));
          if (written.kind === "upserted" && written.instance.desired === "running") {
            const admitted = yield* makeResourceAccounting(repo, budgets).admit(written.instance);
            return { ...written, instance: admitted };
          }
          return written;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof ResourceInstanceBudgetError
            ? error
            : new ResourceDomainInternalServerError({
                message: "Failed to commit the instance and its budget.",
              }),
        ),
      );
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
        return toInstanceWire(yield* startInstance(runtime, outcome.instance), runtime);
    }
  });

export const listResourceInstances = (resourceDomainId: string, archived: boolean) =>
  Effect.gen(function* () {
    yield* requireDomain(resourceDomainId);
    const repo = yield* ResourceInstanceRepo;
    const instances = yield* repo
      .list(resourceDomainId, { archived })
      .pipe(Effect.mapError(internal("Failed to list the resource instances.")));
    const host = yield* ResourceRuntimeHost;
    return {
      items: instances.map((instance) =>
        toInstanceWire(instance, host.kind === "unsupported" ? undefined : host.runtime),
      ),
    };
  });

const getResourceInstanceUnlocked = (resourceDomainId: string, key: ResourceInstanceKey) =>
  Effect.gen(function* () {
    const instance = yield* requireInstance(resourceDomainId, key);
    if (instance.spec.reach === undefined) return toInstanceWire(instance);
    const runtime = yield* requireDockerRuntime;
    const repo = yield* ResourceInstanceRepo;
    if (instance.desired === "running" && runtime.health !== undefined) {
      const state = yield* docker(
        "observe instance health",
        () => runtime.health?.(instance) ?? Promise.resolve(instance.observed),
      );
      yield* repo
        .recordObserved(
          instance.id,
          state.kind === "exited" && instance.observed.kind === "failed"
            ? instance.observed
            : state,
        )
        .pipe(Effect.mapError(internal("Failed to record health.")));
    }
    const current = yield* reread(instance);
    return {
      ...toInstanceWire(current),
      ...(runtime.endpoint === undefined ? {} : { endpoint: runtime.endpoint(current) }),
    };
  });

const stopResourceInstanceUnlocked = (
  resourceDomainId: string,
  key: ResourceInstanceKey,
  by: string,
) =>
  Effect.gen(function* () {
    const instance = yield* requireInstance(resourceDomainId, key);
    if (instance.desired === "archived") {
      return yield* new ResourceInstanceArchivedError({ message: "This instance is archived." });
    }
    const runtime = yield* requireInstanceRuntime(instance);
    const repo = yield* ResourceInstanceRepo;
    const reason = { kind: "person", by } as const;
    yield* repo
      .setDesired(instance.id, { kind: "stop", reason })
      .pipe(Effect.mapError(internal("Failed to record the stop.")));
    yield* docker("stop the instance", () => runtime.stop(instance));
    const budgets = yield* ResourceDomainRepo;
    yield* makeResourceAccounting(repo, budgets)
      .stopped(instance)
      .pipe(Effect.mapError(internal("Failed to release stopped compute.")));
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
    const budgets = yield* ResourceDomainRepo;
    yield* makeResourceAccounting(repo, budgets)
      .stopped(instance, true)
      .pipe(Effect.mapError(internal("Failed to archive instance allocations.")));
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

const archiveResourceInstanceUnlocked = (resourceDomainId: string, key: ResourceInstanceKey) =>
  Effect.gen(function* () {
    const instance = yield* requireInstance(resourceDomainId, key);
    const runtime = yield* requireInstanceRuntime(instance);
    const archived = yield* archiveInstance(runtime, instance);
    return { instance: toInstanceWire(archived.instance), volumes: archived.volumes };
  });

const purgeResourceInstanceUnlocked = (
  resourceDomainId: string,
  key: ResourceInstanceKey,
  expectedInstanceId: ResourceInstanceId,
) =>
  Effect.gen(function* () {
    const domain = yield* requireDomain(resourceDomainId);
    if (domain.ownerKind === "project")
      return yield* new ResourceInstancePurgeRefusedError({
        message: "Purge is available only for organization and instance scopes.",
      });
    const repo = yield* ResourceInstanceRepo;
    const instance = yield* repo
      .get(resourceDomainId, key)
      .pipe(Effect.mapError(internal("Failed to load the instance for purge.")));
    if (instance === undefined)
      return { kind: "already-purged" } satisfies ResourceInstancePurgeResult;
    if (instance.id !== expectedInstanceId)
      return yield* new ResourceInstancePurgeRefusedError({
        message: "The instance identity changed. Observe the current instance before purging it.",
      });
    if (instance.desired === "running" || instance.spec.reach?.kind !== "caller")
      return yield* new ResourceInstancePurgeRefusedError({
        message: "Stop or archive the caller instance before purging it.",
      });
    const runtime = yield* requireDockerRuntime;
    if (runtime.checkPurge === undefined || runtime.purge === undefined)
      return yield* new ResourceRuntimeUnsupportedError({
        message: "This runtime does not support caller-instance purge.",
        runtime: "caller-purge",
      });
    const { checkPurge, purge } = runtime;
    yield* purgeProvider(() => checkPurge.call(runtime, instance));
    const prepared = yield* repo
      .preparePurge(instance.id)
      .pipe(Effect.mapError(internal("Failed to fence the instance and clear its sealed env.")));
    if (prepared === undefined)
      return yield* new ResourceInstancePurgeRefusedError({
        message: "The instance is no longer stopped.",
      });
    yield* purgeProvider(() => purge.call(runtime, prepared));
    const budgets = yield* ResourceDomainRepo;
    yield* repo
      .transaction(
        Effect.gen(function* () {
          yield* makeResourceAccounting(repo, budgets).purged(prepared);
          yield* repo.delete(prepared.id);
        }),
      )
      .pipe(
        Effect.mapError(
          internal(
            "The provider data was removed, but purge accounting could not commit. Retry purge.",
          ),
        ),
      );
    return { kind: "purged" } satisfies ResourceInstancePurgeResult;
  });

export const linkResourceWorkspace = (
  resourceDomainId: string,
  workspaceId: string,
  worktreeKey: ResourceWorktreeKey,
  aliases: ResourceReachAliases | null,
) =>
  Effect.gen(function* () {
    yield* requireDomain(resourceDomainId);
    const runtime = yield* requireWorkspaceRuntime;
    const repo = yield* ResourceInstanceRepo;
    const outcome = yield* repo
      .link({ workspaceId, resourceDomainId, worktreeKey, aliases })
      .pipe(Effect.mapError(internal("Failed to link the workspace.")));
    switch (outcome.kind) {
      case "no-such-domain":
        return yield* new ResourceDomainNotFoundError({ message: "No such resource domain." });
      case "domain-not-active":
        return yield* new ResourceDomainNotActiveError({
          message: `This resource domain is ${outcome.state} and links no workspace.`,
          state: outcome.state,
        });
      case "caller-only":
        return yield* new ResourceInstanceSpecRefusedError({
          message: "Organization and instance scopes admit no workspace links.",
          refusals: [{ field: "scope", reason: "caller-only scope" }],
        });
      case "no-such-workspace":
        return yield* new ResourceWorkspaceNotFoundError({ message: "No such workspace." });
      case "workspace-without-resources":
        return yield* new ResourceWorkspaceWithoutResourcesError({
          message:
            'This workspace was created without resources (runtime.resources "none") and runs on Boat, which gives a workspace its way to reach resources at launch or never. Nothing was linked. Create the workspace again without the option and link that one: it reaches the resources from its next start.',
          code: "workspace-without-resources",
        });
      case "other-domain":
        return yield* new ResourceWorkspaceLinkedElsewhereError({
          message: "This workspace is linked to another resource domain.",
          resourceDomainId: outcome.resourceDomainId,
        });
      case "linked": {
        // Converge the executors it runs now, so a narrower map detaches at once; a later launch
        // attaches its own (the worker's hook).
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
          aliases: outcome.link.aliases,
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
    const domain = yield* requireDomain(resourceDomainId);
    const runtime = yield* (domain.ownerKind ?? "project") === "project"
      ? requireWorkspaceRuntime
      : requireDockerRuntime;
    const repo = yield* ResourceInstanceRepo;
    const failed = internal("Failed to archive the resource domain.");
    yield* repo.setDomainState(resourceDomainId, "fenced").pipe(Effect.mapError(failed));
    const volumes: Array<ResourceInstanceArchivedVolumeWire> = [];
    for (const instance of yield* repo
      .list(resourceDomainId, { archived: false })
      .pipe(Effect.mapError(failed))) {
      volumes.push(
        ...(yield* locked(resourceDomainId, instance.key, archiveInstance(runtime, instance)))
          .volumes,
      );
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

/** API and reconciler operations use the same installation-wide instance lock. */
const locked = <A, E, R>(
  domain: string,
  key: ResourceInstanceKey,
  operation: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const repo = yield* ResourceInstanceRepo;
    return yield* repo.withLock(`${domain}:${key}`, operation).pipe(
      Effect.mapError((error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        error["_tag"] === "ResourceInstanceRepoError"
          ? new ResourceDomainInternalServerError({
              message: "Failed to coordinate the instance operation.",
            })
          : error,
      ),
    );
  });
export const upResourceInstance = (...args: Parameters<typeof upResourceInstanceUnlocked>) =>
  locked(args[0], args[1], upResourceInstanceUnlocked(...args));
export const stopResourceInstance = (...args: Parameters<typeof stopResourceInstanceUnlocked>) =>
  locked(args[0], args[1], stopResourceInstanceUnlocked(...args));
export const archiveResourceInstance = (
  ...args: Parameters<typeof archiveResourceInstanceUnlocked>
) => locked(args[0], args[1], archiveResourceInstanceUnlocked(...args));

export const purgeResourceInstance = (...args: Parameters<typeof purgeResourceInstanceUnlocked>) =>
  locked(args[0], args[1], purgeResourceInstanceUnlocked(...args));

export const getResourceInstance = (...args: Parameters<typeof getResourceInstanceUnlocked>) =>
  locked(args[0], args[1], getResourceInstanceUnlocked(...args));
