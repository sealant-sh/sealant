/**
 * What sealant hands a workspace's egress proxy: the `PUT /v1/policy` document built from the
 * workspace's pinned policy, its brokered secrets with their real values, the run's executor CA,
 * the host facts the launch measured, and every durable revocation (§7.1–7.3). Pure: every caller
 * that pushes a policy (the launch, the heartbeat sweep, the API's "Apply updated policy") builds
 * it here, so they cannot disagree.
 */
import { createHash } from "node:crypto";

import {
  EGRESS_PROXY_LEASE_TTL_SECONDS,
  type BrokeredSecret,
  type NetworkPolicy,
} from "@sealant/api-contracts";
import { Redacted } from "effect";

import type {
  EgressProxyHostFacts,
  ProxyPolicyDocument,
  ProxyRevokeRequest,
} from "./egress-proxy-types.js";

/** The revocations a policy must carry, as of `revocationWatermark`. */
export interface EgressTombstones {
  readonly revocationWatermark: number;
  readonly revokedSecretIds: readonly string[];
  readonly revokedHosts: readonly string[];
}

export type { EgressProxyHostFacts } from "./egress-proxy-types.js";

export interface EgressProxyPolicyInput {
  readonly networkPolicy: NetworkPolicy | undefined;
  readonly brokeredSecrets: readonly BrokeredSecret[];
  /** Each secret's real value by `secretRef`. Never logged. */
  readonly brokeredValues: Redacted.Redacted<Readonly<Record<string, string>>>;
  readonly ca: { readonly certPem: string; readonly keyPem: Redacted.Redacted };
  readonly tombstones: EgressTombstones;
  readonly host: EgressProxyHostFacts;
}

/** A brokered secret whose value the request did not carry: the proxy cannot be given it. */
export class BrokeredSecretValueMissingError extends Error {
  public override readonly name = "BrokeredSecretValueMissingError";
  public constructor(public readonly secretRef: string) {
    super(`No value is held for the brokered secret ref '${secretRef}'.`);
  }
}

/**
 * The policy's hash: the caller's own `policyHash`, or, for a workspace with brokered secrets
 * and no policy, a hash of the secrets' rules (never their values).
 */
export const egressPolicyHash = (
  networkPolicy: NetworkPolicy | undefined,
  brokeredSecrets: readonly BrokeredSecret[],
): string =>
  networkPolicy?.policyHash ??
  `sealant:${createHash("sha256")
    .update(
      JSON.stringify(
        brokeredSecrets.map(({ secretId, headerName, bindHosts, methods, pathPrefixes }) => ({
          secretId,
          headerName,
          bindHosts,
          methods,
          pathPrefixes,
        })),
      ),
    )
    .digest("hex")}`;

/**
 * The `PUT /v1/policy` document. A revoked secret is left out altogether (its value never leaves
 * sealant again), and every tombstone rides along, so the proxy refuses what was revoked whatever
 * the policy lists. Throws `BrokeredSecretValueMissingError` for a live secret with no value.
 */
export const buildProxyPolicyDocument = (input: EgressProxyPolicyInput): ProxyPolicyDocument => {
  const revokedSecrets = new Set(input.tombstones.revokedSecretIds);
  const values = Redacted.value(input.brokeredValues);
  const policy = input.networkPolicy;
  const mirrorHosts = new Set(input.host.mirrorHosts ?? []);
  const resourceHosts = new Set(input.host.resourceHosts ?? []);
  return {
    mode: policy?.mode ?? "standard",
    policyHash: egressPolicyHash(policy, input.brokeredSecrets),
    revocationWatermark: input.tombstones.revocationWatermark,
    leaseTtlSecs: EGRESS_PROXY_LEASE_TTL_SECONDS,
    operatorAllowedPrivateCidrs: [...input.host.operatorAllowedPrivateCidrs],
    hostPublicIps: [...input.host.hostPublicIps],
    blockedCidrs: [...input.host.blockedCidrs],
    allowHosts: (policy?.allowHosts ?? []).map((entry) => ({
      host: entry.host,
      ...(entry.ports === undefined ? {} : { ports: [...entry.ports] }),
      inspectTls: entry.inspectTls ?? false,
      ...(entry.methods === undefined ? {} : { methods: [...entry.methods] }),
      ...(entry.pathPrefixes === undefined ? {} : { pathPrefixes: [...entry.pathPrefixes] }),
    })),
    // A mirror or resource is reached at a private address, which the proxy allows only for the
    // targets granted here: so only the operator's own mirror hosts and the resource hosts the
    // workspace is authorized to reach are granted, never a target the caller named.
    allowMirrors: (policy?.allowMirrors ?? [])
      .filter(({ host }) => mirrorHosts.has(host))
      .map(({ name, host, port }) => ({ name, host, port })),
    allowResources: (policy?.allowResources ?? [])
      .filter(({ host }) => resourceHosts.has(host))
      .map(({ name, host, port, guestIp }) => ({ name, host, port, guestIp })),
    brokeredSecrets: input.brokeredSecrets
      .filter((secret) => !revokedSecrets.has(secret.secretId))
      .map((secret) => {
        const value = values[secret.secretRef];
        if (value === undefined) throw new BrokeredSecretValueMissingError(secret.secretRef);
        return {
          secretId: secret.secretId,
          name: secret.name,
          placeholder: secret.placeholder,
          value,
          headerName: secret.headerName,
          bindHosts: [...secret.bindHosts],
          ...(secret.methods === undefined ? {} : { methods: [...secret.methods] }),
          ...(secret.pathPrefixes === undefined ? {} : { pathPrefixes: [...secret.pathPrefixes] }),
        };
      }),
    executorCaCertPem: input.ca.certPem,
    executorCaKeyPem: Redacted.value(input.ca.keyPem),
    revokedHosts: [...input.tombstones.revokedHosts],
    revokedSecretIds: [...input.tombstones.revokedSecretIds],
  };
};

/**
 * Every host and secret id a policy grants: what a revocation of `all` stores, one tombstone
 * each, so a later "Apply updated policy" grants only what it names anew.
 */
export const grantsOf = (
  networkPolicy: NetworkPolicy | undefined,
  brokeredSecrets: readonly BrokeredSecret[],
): { readonly secretIds: readonly string[]; readonly hosts: readonly string[] } => ({
  secretIds: brokeredSecrets.map((secret) => secret.secretId),
  hosts: [
    ...new Set([
      ...(networkPolicy?.allowHosts ?? []).map((entry) => entry.host),
      ...(networkPolicy?.allowMirrors ?? []).map((mirror) => mirror.host),
      ...(networkPolicy?.allowResources ?? []).map((resource) => resource.name),
      ...brokeredSecrets.flatMap((secret) => secret.bindHosts),
    ]),
  ],
});

/** The `POST /v1/revoke` of one stored revocation. */
export const proxyRevokeRequest = (input: {
  readonly revocationWatermark: number;
  readonly secretIds: readonly string[];
  readonly hosts: readonly string[];
  readonly all: boolean;
}): ProxyRevokeRequest => ({
  revocationWatermark: input.revocationWatermark,
  revokeSecretIds: [...input.secretIds],
  revokeHosts: [...input.hosts],
  revokeAll: input.all,
});

/** The variables a workspace gets for its brokered secrets: each name, its placeholder only. */
export const brokeredPlaceholderEnv = (
  brokeredSecrets: readonly BrokeredSecret[],
): ReadonlyArray<readonly [string, string]> =>
  brokeredSecrets.map((secret) => [secret.name, secret.placeholder] as const);
