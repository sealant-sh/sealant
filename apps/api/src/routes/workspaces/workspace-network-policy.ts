/**
 * A workspace's network policy after create (§7.3): "Apply updated policy", durable revocations,
 * and the read of both. Each change is stored first, then pushed straight to the running egress
 * proxy's admin socket (this process mounts the control directory; it has no Docker), and answers
 * what became of it there: `enforced` once the proxy confirmed it, `pending` when it could not be
 * reached (the worker's sweep keeps pushing, and kills a proxy that misses a revocation), and
 * `next-start` when no proxy runs for the workspace now, or when the change reaches the workspace
 * itself (a brokered secret's placeholder), which only a boot delivers.
 */
import {
  WorkspaceBadRequestError,
  WorkspaceInternalServerError,
  WorkspaceRuntimeRequirementUnsupportedError,
  type ApplyWorkspaceNetworkPolicyRequest,
  type BrokeredSecret,
  type ApplyWorkspaceNetworkPolicyResponse,
  type GetWorkspaceNetworkPolicyQuery,
  type RevokeWorkspaceAccessRequest,
  type RevokeWorkspaceAccessResponse,
  type WorkspaceNetworkPolicy,
} from "@sealant/api-contracts";
import { CredentialCipher } from "@sealant/credentials";
import {
  WorkspaceEgressRepo,
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceEgressPolicy,
  type WorkspaceEgressProxy,
} from "@sealant/db";
import { networkPolicyRefusal, type NewWorkspace } from "@sealant/validators";
import {
  grantsOf,
  pushToProxy,
  revokeOnProxy,
  storedProxyPolicyDocument,
  type EgressPushOutcome,
} from "@sealant/workspaces";
import { Effect } from "effect";

import { env } from "../../runtime-env.js";
import {
  loadRecordedSpec,
  requireOwnedWorkspace,
  runsEgressProxy,
  sealBrokeredSecretValues,
  withInternalError,
} from "./workspaces.module.js";

/** The runtime statuses whose executor may be running, so its proxy may take a push. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "ready"]);

/**
 * The latest run's proxy, when that run's executor is up: the one a change is pushed to. A run
 * launched without a proxy, or one no longer running, has none, and the change applies at the
 * next start.
 */
const liveProxyOf = (latestRunId: string | null) =>
  Effect.gen(function* () {
    if (latestRunId === null) return undefined;
    const proxy = yield* withInternalError(
      (yield* WorkspaceEgressRepo).getProxy(latestRunId),
      "Failed to load the workspace's egress proxy.",
    );
    if (proxy === undefined) return undefined;
    const instance = yield* withInternalError(
      (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(latestRunId),
      "Failed to load the workspace runtime.",
    );
    return instance !== undefined && LIVE_STATUSES.has(instance.status) ? proxy : undefined;
  });

/**
 * What the workspace runs on, and the spec it last launched from: the latest run's runtime
 * when it recorded one, else the runtime its spec asks for.
 */
const workspaceRuntimeOf = (workspaceId: string, latestRunId: string | null) =>
  Effect.gen(function* () {
    const spec: NewWorkspace | undefined =
      latestRunId === null
        ? undefined
        : yield* loadRecordedSpec(workspaceId, latestRunId).pipe(
            Effect.catchTag("WorkspaceConflictError", (error) =>
              Effect.fail(new WorkspaceInternalServerError({ message: error.message })),
            ),
          );
    const instance =
      latestRunId === null
        ? undefined
        : yield* withInternalError(
            (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(latestRunId),
            "Failed to load the workspace runtime.",
          );
    const family = spec?.target.runtime.family ?? "auto";
    const runtime = instance?.adapter ?? (family === "auto" ? env.DEFAULT_RUNTIME_ADAPTER : family);
    return { runtime, spec };
  });

const outcomeFields = (outcome: EgressPushOutcome) =>
  outcome.enforcement === "enforced"
    ? { enforcement: "enforced" as const, closed: outcome.closed }
    : { enforcement: "pending" as const };

/**
 * Push the workspace's whole stored policy, every revocation included, to its live proxy, and
 * record what the proxy confirmed: the policy's hash, the watermark and the policy revision the
 * document was built from. `pending`, with no document, while the launch has not measured the
 * host yet: it pushes the stored policy as the proxy's first.
 */
const pushStoredPolicy = (input: {
  readonly workspaceId: string;
  readonly proxy: WorkspaceEgressProxy;
  readonly policy: WorkspaceEgressPolicy | undefined;
}) =>
  Effect.gen(function* () {
    const egress = yield* WorkspaceEgressRepo;
    const document = yield* withInternalError(
      Effect.gen(function* () {
        return yield* storedProxyPolicyDocument({
          cipher: yield* CredentialCipher,
          proxy: input.proxy,
          policy: input.policy,
          revocations: yield* egress.listRevocations(input.workspaceId),
        });
      }),
      "Failed to build the egress proxy's policy.",
    );
    if (document === undefined) {
      const outcome: EgressPushOutcome = {
        enforcement: "pending",
        reason: "the launch has not measured the host yet",
      };
      return { policyHash: undefined, outcome };
    }
    const outcome = yield* pushToProxy(input.proxy, document);
    if (outcome.enforcement === "enforced") {
      yield* withInternalError(
        egress.confirmProxy({
          runId: input.proxy.runId,
          policyHash: document.policyHash,
          revocationWatermark: document.revocationWatermark,
          policyRevision: input.policy?.policyRevision,
        }),
        "Failed to record what the egress proxy confirmed.",
      );
    }
    return { policyHash: document.policyHash, outcome };
  });

/**
 * Whether an update hands the workspace something new: a brokered secret it did not hold, or one
 * whose variable name or placeholder changed. The placeholder is in the workspace's environment,
 * which only a boot sets, so such an update holds from the next start whatever the proxy took.
 */
const reachesWorkspace = (
  previous: readonly BrokeredSecret[],
  next: readonly BrokeredSecret[],
): boolean => {
  const held = new Map(previous.map((secret) => [secret.secretId, secret]));
  return next.some((secret) => {
    const before = held.get(secret.secretId);
    return (
      before === undefined ||
      before.name !== secret.name ||
      before.placeholder !== secret.placeholder
    );
  });
};

export const applyWorkspaceNetworkPolicy = (input: {
  readonly workspaceId: string;
  readonly payload: ApplyWorkspaceNetworkPolicyRequest;
}) =>
  Effect.gen(function* () {
    const { payload } = input;
    const workspace = yield* requireOwnedWorkspace(input.workspaceId, payload.ownerUserId);
    const brokeredSecrets = payload.brokeredSecrets ?? [];
    const { runtime, spec } = yield* workspaceRuntimeOf(workspace.id, workspace.latestRunId);
    const refusal = networkPolicyRefusal(runtime, {
      networkPolicy: payload.networkPolicy,
      brokeredSecrets,
      tooling: spec?.tooling ?? {},
    });
    if (refusal !== undefined) {
      return yield* new WorkspaceRuntimeRequirementUnsupportedError({
        message: refusal.message,
        code: "runtime-requirement-unsupported",
      });
    }
    // The blueprint's own rule, against the spec the workspace runs: a variable the spec sets
    // cannot also carry a placeholder.
    const setBySpec = new Set([
      ...Object.keys(spec?.runtime.env ?? {}),
      ...Object.keys(spec?.runtime.userEnv ?? {}),
    ]);
    const collisions = brokeredSecrets.flatMap((secret) =>
      setBySpec.has(secret.name)
        ? [
            `brokeredSecrets \`${secret.secretId}\`: ${secret.name} is also set in runtime.env or runtime.userEnv`,
          ]
        : [],
    );
    if (collisions.length > 0) {
      return yield* new WorkspaceBadRequestError({ message: collisions.join("; ") });
    }
    const sealed = yield* sealBrokeredSecretValues(
      brokeredSecrets,
      payload.brokeredSecretValues ?? {},
    );
    const egress = yield* WorkspaceEgressRepo;
    const previous = yield* withInternalError(
      egress.getPolicy(workspace.id),
      "Failed to load the workspace's network policy.",
    );
    const nextStartOnly = reachesWorkspace(previous?.brokeredSecrets ?? [], brokeredSecrets);
    const stored = yield* withInternalError(
      egress.putPolicy({
        workspaceId: workspace.id,
        networkPolicy: payload.networkPolicy,
        brokeredSecrets,
        brokeredValuesSealed: sealed?.sealed,
        encryptionKeyId: sealed?.keyId,
      }),
      "Failed to store the workspace's network policy.",
    );
    const stays = {
      workspaceId: workspace.id,
      policyHash: payload.networkPolicy.policyHash,
      revocationWatermark: stored.revocationWatermark,
    };

    const proxy = yield* liveProxyOf(workspace.latestRunId);
    if (proxy === undefined) {
      return {
        ...stays,
        enforcement: "next-start",
      } satisfies ApplyWorkspaceNetworkPolicyResponse;
    }
    // Pushed even when the update holds only from the next start: the proxy takes the policy's
    // allow list and the secrets' values now, and the workspace gets the placeholders at boot.
    const pushed = yield* pushStoredPolicy({ workspaceId: workspace.id, proxy, policy: stored });
    if (pushed.outcome.enforcement === "pending") {
      yield* Effect.logWarning(
        `Workspace ${workspace.id}: its updated network policy is stored, and run ${proxy.runId}'s egress proxy did not take it (${pushed.outcome.reason}); the worker keeps pushing it.`,
      );
    }
    return {
      ...stays,
      policyHash: pushed.policyHash ?? stays.policyHash,
      ...(nextStartOnly ? { enforcement: "next-start" as const } : outcomeFields(pushed.outcome)),
    } satisfies ApplyWorkspaceNetworkPolicyResponse;
  });

export const revokeWorkspaceAccess = (input: {
  readonly workspaceId: string;
  readonly payload: RevokeWorkspaceAccessRequest;
}) =>
  Effect.gen(function* () {
    const { payload } = input;
    const workspace = yield* requireOwnedWorkspace(input.workspaceId, payload.ownerUserId);
    const egress = yield* WorkspaceEgressRepo;
    const all = payload.all === true;
    // `all` stores a tombstone for every grant the policy holds now, so a later policy grants
    // only what it names anew.
    const grants = all
      ? yield* withInternalError(
          egress.getPolicy(workspace.id),
          "Failed to load the workspace's network policy.",
        ).pipe(
          Effect.map((policy) =>
            grantsOf(policy?.networkPolicy ?? undefined, policy?.brokeredSecrets ?? []),
          ),
        )
      : { secretIds: [], hosts: [] };
    const revocation = {
      secretIds: [...grants.secretIds, ...(payload.secretIds ?? [])],
      hosts: [...grants.hosts, ...(payload.hosts ?? [])],
      all,
    };
    // Only an egress proxy refuses a host: a host revocation on a runtime that runs none could
    // never be enforced, so it is refused before anything is stored. A secret revocation stays
    // allowed everywhere (with no proxy it holds from the next start).
    if (revocation.hosts.length > 0) {
      const { runtime } = yield* workspaceRuntimeOf(workspace.id, workspace.latestRunId);
      if (!runsEgressProxy(runtime)) {
        return yield* new WorkspaceRuntimeRequirementUnsupportedError({
          message: `The ${runtime} runtime runs no egress proxy, so it cannot refuse a host: revoke brokered secrets by id instead, or move the workspace to Docker or Host VM (host-vm).`,
          code: "runtime-requirement-unsupported",
        });
      }
    }
    // Durable before anything is told: it holds for the workspace's life whatever happens next.
    const tombstones = yield* withInternalError(
      egress.revoke({ workspaceId: workspace.id, ...revocation }),
      "Failed to store the revocation.",
    );
    const revocationWatermark = tombstones.revocationWatermark;

    const proxy = yield* liveProxyOf(workspace.latestRunId);
    if (proxy === undefined) {
      return {
        workspaceId: workspace.id,
        revocationWatermark,
        enforcement: "next-start",
      } satisfies RevokeWorkspaceAccessResponse;
    }
    // Every tombstone through this watermark, so one an earlier push missed goes now.
    const revoked = yield* revokeOnProxy(proxy, { tombstones, all });
    if (revoked.enforcement === "enforced") {
      yield* withInternalError(
        egress.confirmProxy({ runId: proxy.runId, policyHash: undefined, revocationWatermark }),
        "Failed to record what the egress proxy confirmed.",
      );
    }
    // A proxy holding a later watermark than this one may lack some revocation storage holds: it
    // takes the whole stored policy instead, every tombstone in it.
    const outcome: EgressPushOutcome =
      revoked.enforcement === "resync"
        ? (yield* pushStoredPolicy({
            workspaceId: workspace.id,
            proxy,
            policy: yield* withInternalError(
              egress.getPolicy(workspace.id),
              "Failed to load the workspace's network policy.",
            ),
          })).outcome
        : revoked;
    if (outcome.enforcement === "pending") {
      yield* Effect.logWarning(
        `Workspace ${workspace.id}: revocation ${String(revocationWatermark)} is stored, and run ${proxy.runId}'s egress proxy did not confirm it (${outcome.reason}); the worker's sweep kills the proxy if it stays unreachable.`,
      );
    }
    return {
      workspaceId: workspace.id,
      revocationWatermark,
      ...outcomeFields(outcome),
    } satisfies RevokeWorkspaceAccessResponse;
  });

const proxyView = (proxy: WorkspaceEgressProxy): NonNullable<WorkspaceNetworkPolicy["proxy"]> => ({
  runId: proxy.runId,
  ...(proxy.confirmedPolicyHash === null ? {} : { confirmedPolicyHash: proxy.confirmedPolicyHash }),
  ...(proxy.confirmedRevocationWatermark === null
    ? {}
    : { confirmedRevocationWatermark: proxy.confirmedRevocationWatermark }),
});

export const getWorkspaceNetworkPolicy = (input: {
  readonly workspaceId: string;
  readonly query: GetWorkspaceNetworkPolicyQuery;
}) =>
  Effect.gen(function* () {
    const workspace = yield* requireOwnedWorkspace(input.workspaceId, input.query.ownerUserId);
    const egress = yield* WorkspaceEgressRepo;
    const policy = yield* withInternalError(
      egress.getPolicy(workspace.id),
      "Failed to load the workspace's network policy.",
    );
    const revocations = yield* withInternalError(
      egress.listRevocations(workspace.id),
      "Failed to load the workspace's revocations.",
    );
    const proxy =
      workspace.latestRunId === null
        ? undefined
        : yield* withInternalError(
            egress.getProxy(workspace.latestRunId),
            "Failed to load the workspace's egress proxy.",
          );
    return {
      workspaceId: workspace.id,
      ...(policy?.networkPolicy == null ? {} : { networkPolicy: policy.networkPolicy }),
      brokeredSecrets: policy?.brokeredSecrets ?? [],
      revocationWatermark: policy?.revocationWatermark ?? 0,
      revocations: revocations.map((revocation) => ({
        revocationWatermark: revocation.revocationWatermark,
        kind: revocation.kind,
        ...(revocation.target === null ? {} : { target: revocation.target }),
        revokedAt: revocation.createdAt.toISOString(),
      })),
      ...(proxy === undefined ? {} : { proxy: proxyView(proxy) }),
    } satisfies WorkspaceNetworkPolicy;
  });
