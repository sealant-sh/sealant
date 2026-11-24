/**
 * A workspace's network policy after create (§7.3): "Apply updated policy", durable revocations,
 * and the read of both. Each change is stored first, then pushed straight to the running egress
 * proxy's admin socket (this process mounts the control directory; it has no Docker), and answers
 * what became of it there: `enforced` once the proxy confirmed it, `pending` when it could not be
 * reached (the worker's sweep keeps pushing, and kills a proxy that misses a revocation), and
 * `next-start` when no proxy runs for the workspace now.
 */
import {
  WorkspaceBadRequestError,
  WorkspaceInternalServerError,
  WorkspaceRuntimeRequirementUnsupportedError,
  type ApplyWorkspaceNetworkPolicyRequest,
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
    const runtime =
      instance?.adapter ?? (family === "auto" ? env.DEFAULT_RUNTIME_ADAPTER : family);
    return { runtime, spec };
  });

const outcomeFields = (outcome: EgressPushOutcome) =>
  outcome.enforcement === "enforced"
    ? { enforcement: "enforced" as const, closed: outcome.closed }
    : { enforcement: "pending" as const };

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
    const document = yield* withInternalError(
      Effect.gen(function* () {
        return yield* storedProxyPolicyDocument({
          cipher: yield* CredentialCipher,
          proxy,
          policy: stored,
          revocations: yield* egress.listRevocations(workspace.id),
        });
      }),
      "Failed to build the egress proxy's policy.",
    );
    // The launch has not measured the host yet: it pushes the stored policy as the proxy's first.
    if (document === undefined) {
      return { ...stays, enforcement: "pending" } satisfies ApplyWorkspaceNetworkPolicyResponse;
    }
    const outcome = yield* pushToProxy(proxy, document);
    if (outcome.enforcement === "enforced") {
      yield* withInternalError(
        egress.confirmProxy({
          runId: proxy.runId,
          policyHash: document.policyHash,
          revocationWatermark: document.revocationWatermark,
        }),
        "Failed to record what the egress proxy confirmed.",
      );
    } else {
      yield* Effect.logWarning(
        `Workspace ${workspace.id}: its updated network policy is stored, and run ${proxy.runId}'s egress proxy did not take it (${outcome.reason}); the worker keeps pushing it.`,
      );
    }
    return {
      ...stays,
      policyHash: document.policyHash,
      ...outcomeFields(outcome),
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
    const outcome = yield* revokeOnProxy(proxy, { revocationWatermark, ...revocation });
    if (outcome.enforcement === "enforced") {
      yield* withInternalError(
        egress.confirmProxy({ runId: proxy.runId, policyHash: undefined, revocationWatermark }),
        "Failed to record what the egress proxy confirmed.",
      );
    } else {
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
