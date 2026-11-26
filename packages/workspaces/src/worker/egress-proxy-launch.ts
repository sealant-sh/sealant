/**
 * The worker's half of a launch behind an egress proxy (`EgressProxyLaunch`): it records the
 * run's proxy, mints the run's executor CA (or finds the one a first delivery of this launch
 * minted, so a redelivered launch's proxy presents the certificate the workspace already
 * trusts), seals the CA's key with the credential key, and builds the proxy's first policy from
 * storage, exactly as every later push does.
 */
import type { BrokeredSecret } from "@sealant/api-contracts";
import { needsEgressProxy } from "@sealant/api-contracts/network-policy";
import type { CredentialCipherService } from "@sealant/credentials";
import type { WorkspaceEgressPolicy, WorkspaceEgressRepoService } from "@sealant/db";
import {
  workspaceBrokeredSecretsSchema,
  workspaceNetworkPolicySchema,
  type WorkspaceBlueprint,
} from "@sealant/validators";
import { Effect, Redacted } from "effect";

import type { EgressProxyLaunch } from "../runtime/egress-proxy-orchestrator.js";
import { brokeredPlaceholderEnv } from "../runtime/egress-proxy-policy.js";
import { EgressProxyStoreError, storedProxyPolicyDocument } from "../runtime/egress-proxy-store.js";
import { generateExecutorCa } from "../runtime/executor-ca.js";

/**
 * A blueprint with the workspace's pinned policy in place of the one it was created with: "Apply
 * updated policy" replaces the stored policy, and every later launch (a restart) runs under it.
 */
export const withPinnedEgressPolicy = (
  blueprint: WorkspaceBlueprint,
  pinned: WorkspaceEgressPolicy | undefined,
): WorkspaceBlueprint => {
  if (pinned === undefined) return blueprint;
  const { networkPolicy: _created, brokeredSecrets: _createdSecrets, ...rest } = blueprint;
  return {
    ...rest,
    // Parsed like any spec: a stored row that no longer meets the rules fails the launch.
    ...(pinned.networkPolicy === null
      ? {}
      : { networkPolicy: workspaceNetworkPolicySchema.parse(pinned.networkPolicy) }),
    ...(pinned.brokeredSecrets.length === 0
      ? {}
      : { brokeredSecrets: workspaceBrokeredSecretsSchema.parse(pinned.brokeredSecrets) }),
  };
};

/**
 * The secret env a proxy-backed workspace boots with: each brokered secret's placeholder under its
 * name, through the secret channel (so a secret-shaped name such as `VERCEL_TOKEN` arrives), over
 * whatever the create sent; never a value.
 */
export const withBrokeredPlaceholders = (
  secretEnv: Readonly<Record<string, string>> | undefined,
  brokeredSecrets: readonly BrokeredSecret[] | undefined,
): Readonly<Record<string, string>> | undefined => {
  const placeholders = brokeredPlaceholderEnv(brokeredSecrets ?? []);
  if (placeholders.length === 0) return secretEnv;
  return { ...secretEnv, ...Object.fromEntries(placeholders) };
};

export { needsEgressProxy };

export const egressProxyLaunch = (input: {
  readonly runId: string;
  readonly workspaceId: string;
  readonly repo: WorkspaceEgressRepoService;
  readonly cipher: CredentialCipherService;
  /**
   * What a workspace with no stored policy row gets. `refuse` (the default): its proxy is not
   * loaded, since the row holds the secrets' values and a restricted mode the proxy must not
   * lose. `standard`: a workspace whose spec asks for no policy but runs behind a proxy anyway
   * (every host-vm workspace) gets the standard policy and its CA.
   */
  readonly whenUnstored?: "refuse" | "standard";
}): EgressProxyLaunch => {
  const { runId, workspaceId, repo, cipher } = input;
  const whenUnstored = input.whenUnstored ?? "refuse";
  /** The stored policy revision the first policy was built from, for its confirmation. */
  let preparedRevision: number | undefined;
  return {
    prepare: (measured) =>
      Effect.runPromise(
        Effect.gen(function* () {
          let proxy = yield* repo.getProxy(runId);
          if (proxy === undefined) {
            const ca = generateExecutorCa({
              executor: measured.proxyContainer.replace(/-proxy$/, ""),
            });
            const sealed = yield* cipher.encrypt(Redacted.value(ca.keyPem));
            proxy = (yield* repo.ensureProxy({
              runId,
              workspaceId,
              proxyContainer: measured.proxyContainer,
              adminSocketPath: measured.adminSocketPath,
              caCertPem: ca.certPem,
              caKeySealed: sealed.sealed,
              encryptionKeyId: sealed.keyId,
              caNotAfter: ca.notAfter,
            })).proxy;
          }
          const network = {
            proxyIp: measured.proxyIp,
            operatorAllowedPrivateCidrs: [...measured.host.operatorAllowedPrivateCidrs],
            hostPublicIps: [...measured.host.hostPublicIps],
            blockedCidrs: [...measured.host.blockedCidrs],
            // Kept with the run, so every later push (the sweep's, the API's) grants the same
            // operator mirrors and authorized resources the first one did.
            mirrorHosts: [...(measured.host.mirrorHosts ?? [])],
            resourceHosts: [...(measured.host.resourceHosts ?? [])],
            ...(measured.host.telemetryHosts === undefined
              ? {}
              : { telemetryHosts: [...measured.host.telemetryHosts] }),
          };
          yield* repo.recordProxyNetwork(runId, network);
          // The proxy's policy comes from storage only: without the stored row (its secrets'
          // sealed values among it) the proxy would load less than the workspace asked for.
          const policy = yield* repo.getPolicy(workspaceId);
          if (policy === undefined && whenUnstored === "refuse") {
            return yield* new EgressProxyStoreError({
              message: `Workspace ${workspaceId} has no stored network policy for its egress proxy.`,
            });
          }
          preparedRevision = policy?.policyRevision;
          const document = yield* storedProxyPolicyDocument({
            cipher,
            proxy: { ...proxy, network },
            policy,
            revocations: yield* repo.listRevocations(workspaceId),
          });
          if (document === undefined) {
            return yield* new EgressProxyStoreError({
              message: "The proxy's policy could not be built from storage.",
            });
          }
          return { caCertPem: proxy.caCertPem, document };
        }),
      ),
    confirmed: (applied) =>
      Effect.runPromise(
        repo.confirmProxy({
          runId,
          policyHash: applied.policyHash,
          revocationWatermark: applied.revocationWatermark,
          // No stored policy (a standard host-vm run) is revision 0, as the sweep reads it.
          policyRevision: preparedRevision ?? 0,
        }),
      ),
  };
};
