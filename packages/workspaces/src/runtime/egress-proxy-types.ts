/**
 * The types an egress proxy launch shares across modules, with no runtime dependency: the wire of
 * the proxy's admin socket (`sealant-egress-proxy` `admin.rs`, `policy.rs`, `state.rs`, camelCase),
 * the host facts a launch measures, and the hook a worker hands a runtime adapter
 * (`RuntimeAdapterLaunchInput.egressProxy`). Kept apart so the adapter seam can name them without
 * pulling Node-only modules into every program that reads it (the Cloudflare bridge's Worker).
 */

/** `allowHosts[]` of a policy (`AllowHostDocument`). */
export interface ProxyAllowHost {
  readonly host: string;
  readonly ports?: readonly number[];
  readonly inspectTls: boolean;
  readonly methods?: readonly string[];
  readonly pathPrefixes?: readonly string[];
}

/** `brokeredSecrets[]` of a policy (`BrokeredSecretDocument`): `value` is the real secret. */
export interface ProxyBrokeredSecret {
  readonly secretId: string;
  readonly name?: string;
  readonly placeholder: string;
  readonly value: string;
  readonly headerName: string;
  readonly bindHosts: readonly string[];
  readonly methods?: readonly string[];
  readonly pathPrefixes?: readonly string[];
}

/** The body of `PUT /v1/policy` (`PolicyDocument`). */
export interface ProxyPolicyDocument {
  readonly mode: "standard" | "restricted";
  readonly policyHash: string;
  readonly revocationWatermark: number;
  readonly leaseTtlSecs: number;
  readonly operatorAllowedPrivateCidrs: readonly string[];
  readonly hostPublicIps: readonly string[];
  readonly blockedCidrs: readonly string[];
  readonly allowHosts: readonly ProxyAllowHost[];
  readonly allowMirrors: readonly {
    readonly name: string;
    readonly host: string;
    readonly port: number;
  }[];
  readonly allowResources: readonly {
    readonly name: string;
    readonly host: string;
    readonly port: number;
    readonly guestIp: string;
  }[];
  readonly brokeredSecrets: readonly ProxyBrokeredSecret[];
  readonly executorCaCertPem?: string;
  readonly executorCaKeyPem?: string;
  readonly revokedHosts: readonly string[];
  readonly revokedSecretIds: readonly string[];
}

/** The body of `POST /v1/revoke` (`RevokeRequest`). */
export interface ProxyRevokeRequest {
  readonly revocationWatermark: number;
  readonly revokeSecretIds: readonly string[];
  readonly revokeHosts: readonly string[];
  readonly revokeAll: boolean;
}

/** `GET /v1/health` (`Health`). */
export interface ProxyHealth {
  readonly initialized: boolean;
  readonly mode?: "standard" | "restricted";
  readonly policyHash?: string;
  readonly revocationWatermark: number;
  readonly activeConnections: number;
  readonly leaseRemainingMs: number;
  readonly leaseExpired: boolean;
  readonly resyncRequired: boolean;
}

/** `PUT /v1/policy` answered 200 (`Applied`). */
export interface ProxyPolicyApplied {
  readonly policyHash: string;
  readonly revocationWatermark: number;
  readonly closed: number;
}

/** `POST /v1/revoke` answered 200 (`Revoked`): every matching stream is closed. */
export interface ProxyRevoked {
  readonly revocationWatermark: number;
  readonly closed: number;
}

/** `POST /v1/heartbeat` answered 200 (`Renewed`). */
export interface ProxyHeartbeat {
  readonly resyncRequired: boolean;
  readonly leaseRemainingMs: number;
  readonly revocationWatermark: number;
}

/** What the launch measured of the host, kept with the run's proxy. */
export interface EgressProxyHostFacts {
  readonly operatorAllowedPrivateCidrs: readonly string[];
  readonly hostPublicIps: readonly string[];
  /** Docker bridge gateways and the workspace's own networks, refused by the proxy too. */
  readonly blockedCidrs: readonly string[];
}

/**
 * What a launch behind an egress proxy gets from the worker (`RuntimeAdapterLaunchInput.egressProxy`).
 * The CA's private key and the secrets' values stay behind `policyFor`, built only once the
 * launch has measured the host, so neither ever sits in the parsed launch input.
 */
export interface EgressProxyLaunch {
  /**
   * Called once the launch has measured the host, before the proxy takes any policy: the worker
   * records the run's proxy (its name, socket and these facts, so every later push rebuilds the
   * same document), mints the run's executor CA or finds the one a first delivery of this launch
   * minted, and answers the CA's public certificate with the proxy's first `PUT /v1/policy`.
   */
  readonly prepare: (input: {
    readonly proxyContainer: string;
    readonly adminSocketPath: string;
    readonly proxyIp: string;
    readonly host: EgressProxyHostFacts;
  }) => Promise<{ readonly caCertPem: string; readonly document: ProxyPolicyDocument }>;
  /** What the proxy confirmed taking. */
  readonly confirmed?: (applied: ProxyPolicyApplied) => Promise<void>;
}
