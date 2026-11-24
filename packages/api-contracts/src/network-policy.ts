/**
 * A workspace's network policy and its brokered secrets (workspace isolation architecture §7,
 * §8.4): the ONE definition of their shape and of the rules a value must meet, shared by the SDK
 * (client-side refusal with the server's wording), the control-plane validators (every parse:
 * create, worker, restart, policy update) and the runtime that hands them to the workspace's
 * egress proxy (`<name>-proxy`).
 *
 * The rules mirror what the proxy itself refuses (`sealant-egress-proxy` `policy.rs`), so a
 * policy sealant accepts is one the proxy loads: exact host names (never a wildcard), one HTTP
 * header name per secret that neither frames nor routes a request, and bind hosts that are names,
 * not addresses or URLs.
 *
 * Deliberately dependency-free, like `workspace-environment.ts`: data plus pure functions.
 */

/** `standard`: public internet less the blocked ranges. `restricted`: only what the policy lists. */
export type NetworkPolicyMode = "standard" | "restricted";

export interface NetworkPolicyAllowHost {
  /** An exact host name or IP literal. Never a wildcard. */
  readonly host: string;
  /** The ports allowed on the host; default `[443]`. */
  readonly ports?: readonly number[] | undefined;
  /** Terminate and inspect TLS to this host (always so for a brokered secret's bind host). */
  readonly inspectTls?: boolean | undefined;
  /** HTTP methods allowed; inspected hosts only. */
  readonly methods?: readonly string[] | undefined;
  /** Path prefixes allowed, each starting with `/`; inspected hosts only. */
  readonly pathPrefixes?: readonly string[] | undefined;
}

export interface NetworkPolicyMirror {
  readonly name: "npm" | "docker";
  readonly host: string;
  readonly port: number;
}

export interface NetworkPolicyResource {
  /** The name the workspace resolves (`db`, `cache`). */
  readonly name: string;
  /** Where the proxy relays it, on the worktree's reach network. */
  readonly host: string;
  readonly port: number;
  /** The synthetic address the workspace sees, in `10.201.0.0/16`. */
  readonly guestIp: string;
}

export interface NetworkPolicy {
  readonly mode: NetworkPolicyMode;
  /** The caller's canonical hash of the policy snapshot this workspace is pinned to. */
  readonly policyHash: string;
  readonly sourcePolicyId?: string | undefined;
  readonly sourcePolicyRevision?: number | undefined;
  /** The workspace must run in its own VM: a container runtime refuses it. */
  readonly requireVmIsolation?: boolean | undefined;
  readonly allowHosts?: readonly NetworkPolicyAllowHost[] | undefined;
  readonly allowMirrors?: readonly NetworkPolicyMirror[] | undefined;
  readonly allowResources?: readonly NetworkPolicyResource[] | undefined;
}

/**
 * A project secret the workspace never holds: it gets `placeholder` in `name`, and the proxy puts
 * the real value in `headerName` only on HTTPS requests to one of `bindHosts`.
 */
export interface BrokeredSecret {
  readonly secretId: string;
  /** The environment variable the workspace reads the placeholder from. */
  readonly name: string;
  /** Opaque, at least 8 visible ASCII characters. */
  readonly placeholder: string;
  /** The key of the secret's value in the request's `brokeredSecretValues`. */
  readonly secretRef: string;
  readonly headerName: string;
  readonly bindHosts: readonly string[];
  readonly methods?: readonly string[] | undefined;
  readonly pathPrefixes?: readonly string[] | undefined;
}

/** The lease the proxy holds traffic open for without hearing from sealant (§7.3). */
export const EGRESS_PROXY_LEASE_TTL_SECONDS = 120;

/** Synthetic addresses worktree resources are answered from. */
export const SYNTHETIC_RESOURCE_CIDR = "10.201.0.0/16";

export const NETWORK_POLICY_MAX_ALLOW_HOSTS = 256;
export const NETWORK_POLICY_MAX_RESOURCES = 64;
export const BROKERED_SECRETS_MAX = 64;
/** A brokered secret's value is one header value: bounded like one. */
export const BROKERED_SECRET_VALUE_MAX_LENGTH = 16 * 1024;

/**
 * Header names that frame, route or authenticate the request to the proxy itself. A secret in
 * one could change where the request goes or how it is read, so none may carry one. The same list
 * as the proxy's `FORBIDDEN_SECRET_HEADERS`.
 */
export const FORBIDDEN_BROKERED_HEADER_NAMES: readonly string[] = [
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
];

const HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL = /^[a-z0-9_-]{1,63}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const ipv4Octets = (value: string): readonly number[] | undefined => {
  const match = IPV4.exec(value);
  if (match === null) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
};

const isIpLiteral = (value: string): boolean =>
  ipv4Octets(value) !== undefined || (value.includes(":") && /^[0-9a-fA-F:.]+$/.test(value));

/** Whether `name` is one HTTP header name (an RFC 9110 token). */
export const isHttpHeaderName = (name: string): boolean => HEADER_TOKEN.test(name);

/** Whether a secret in header `name` is refused: not one name, or one that frames or routes. */
export const brokeredHeaderNameProblem = (name: string): string | undefined => {
  if (name.trim().length === 0) return "headerName is required";
  if (!isHttpHeaderName(name)) return `headerName \`${name}\` must be one HTTP header name`;
  if (FORBIDDEN_BROKERED_HEADER_NAMES.includes(name.toLowerCase())) {
    return `headerName \`${name}\` frames or routes the request and cannot carry a secret`;
  }
  return undefined;
};

/**
 * Why `host` is not an exact policy host name, or `undefined` when it is one: lowercase DNS labels
 * (letters, digits, `-`, `_`), or an IP literal when `allowIp`. Never a wildcard, a port, a path or
 * a query: a policy names hosts, not URLs.
 */
export const policyHostProblem = (
  host: string,
  options: { readonly allowIp: boolean },
): string | undefined => {
  if (host.includes("*")) return `\`${host}\` is a wildcard; name exact hosts`;
  if (/[/?#@:\s]/.test(host) && !(options.allowIp && isIpLiteral(host))) {
    return `\`${host}\` is not a host name (no scheme, port, path or query)`;
  }
  if (isIpLiteral(host)) {
    return options.allowIp ? undefined : `\`${host}\` is an IP address; name a host`;
  }
  if (host !== host.toLowerCase()) return `\`${host}\` must be lowercase`;
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name.length === 0 || name.length > 253 || !name.split(".").every((l) => LABEL.test(l))) {
    return `\`${host}\` is not a host name`;
  }
  return undefined;
};

const portProblem = (port: number): string | undefined =>
  Number.isInteger(port) && port >= 1 && port <= 65_535
    ? undefined
    : `port ${String(port)} must be 1-65535`;

const methodsProblems = (field: string, methods: readonly string[] | undefined): string[] =>
  (methods ?? []).flatMap((method) =>
    isHttpHeaderName(method) && method === method.toUpperCase()
      ? []
      : [`${field}: \`${method}\` is not an uppercase HTTP method`],
  );

const pathPrefixProblems = (field: string, prefixes: readonly string[] | undefined): string[] =>
  (prefixes ?? []).flatMap((prefix) =>
    prefix.startsWith("/") && !prefix.includes("?") && !prefix.includes("#")
      ? []
      : [`${field}: path prefix \`${prefix}\` must start with \`/\` and hold no query`],
  );

const repeated = <T>(values: readonly T[]): T | undefined =>
  values.find((value, index) => values.indexOf(value) !== index);

/** Every rule `policy` breaks, in the words a create's refusal uses; empty when it breaks none. */
export const networkPolicyProblems = (policy: NetworkPolicy): readonly string[] => {
  const problems: string[] = [];
  if (policy.policyHash.trim().length === 0) problems.push("networkPolicy.policyHash is required");
  if (
    policy.sourcePolicyRevision !== undefined &&
    (!Number.isInteger(policy.sourcePolicyRevision) || policy.sourcePolicyRevision < 0)
  ) {
    problems.push("networkPolicy.sourcePolicyRevision must be a non-negative integer");
  }
  const hosts = policy.allowHosts ?? [];
  if (hosts.length > NETWORK_POLICY_MAX_ALLOW_HOSTS) {
    problems.push(`networkPolicy.allowHosts holds at most ${NETWORK_POLICY_MAX_ALLOW_HOSTS} hosts`);
  }
  for (const entry of hosts) {
    const field = `networkPolicy.allowHosts \`${entry.host}\``;
    const host = policyHostProblem(entry.host, { allowIp: true });
    if (host !== undefined) problems.push(`networkPolicy.allowHosts: ${host}`);
    if (entry.ports !== undefined && entry.ports.length === 0) {
      problems.push(`${field}: ports, when given, must name at least one port`);
    }
    for (const port of entry.ports ?? []) {
      const problem = portProblem(port);
      if (problem !== undefined) problems.push(`${field}: ${problem}`);
    }
    problems.push(...methodsProblems(field, entry.methods));
    problems.push(...pathPrefixProblems(field, entry.pathPrefixes));
  }
  for (const mirror of policy.allowMirrors ?? []) {
    const host = policyHostProblem(mirror.host, { allowIp: false });
    if (host !== undefined) problems.push(`networkPolicy.allowMirrors: ${host}`);
    const port = portProblem(mirror.port);
    if (port !== undefined) problems.push(`networkPolicy.allowMirrors \`${mirror.host}\`: ${port}`);
  }
  const resources = policy.allowResources ?? [];
  if (resources.length > NETWORK_POLICY_MAX_RESOURCES) {
    problems.push(
      `networkPolicy.allowResources holds at most ${NETWORK_POLICY_MAX_RESOURCES} resources`,
    );
  }
  for (const resource of resources) {
    const field = `networkPolicy.allowResources \`${resource.name}\``;
    const name = policyHostProblem(resource.name, { allowIp: false });
    if (name !== undefined) problems.push(`networkPolicy.allowResources: ${name}`);
    const host = policyHostProblem(resource.host, { allowIp: false });
    if (host !== undefined) problems.push(`${field}: ${host}`);
    const port = portProblem(resource.port);
    if (port !== undefined) problems.push(`${field}: ${port}`);
    const octets = ipv4Octets(resource.guestIp);
    if (octets === undefined || octets[0] !== 10 || octets[1] !== 201) {
      problems.push(`${field}: guestIp ${resource.guestIp} is outside ${SYNTHETIC_RESOURCE_CIDR}`);
    }
  }
  const slot = repeated(resources.map((resource) => `${resource.guestIp}:${resource.port}`));
  if (slot !== undefined) problems.push(`networkPolicy.allowResources: ${slot} is assigned twice`);
  return problems;
};

/** Every rule `secrets` break; empty when they break none. Values are never read here. */
export const brokeredSecretsProblems = (secrets: readonly BrokeredSecret[]): readonly string[] => {
  const problems: string[] = [];
  if (secrets.length > BROKERED_SECRETS_MAX) {
    problems.push(`brokeredSecrets holds at most ${BROKERED_SECRETS_MAX} secrets`);
  }
  for (const secret of secrets) {
    const field = `brokeredSecrets \`${secret.secretId}\``;
    if (secret.secretId.trim().length === 0) problems.push("brokeredSecrets: secretId is required");
    if (!ENV_NAME.test(secret.name)) {
      problems.push(`${field}: name must match [A-Za-z_][A-Za-z0-9_]*`);
    }
    if (secret.placeholder.length < 8 || !/^[\x21-\x7e]+$/.test(secret.placeholder)) {
      problems.push(`${field}: placeholder must be at least 8 visible ASCII characters`);
    }
    if (secret.secretRef.trim().length === 0) problems.push(`${field}: secretRef is required`);
    const header = brokeredHeaderNameProblem(secret.headerName);
    if (header !== undefined) problems.push(`${field}: ${header}`);
    if (secret.bindHosts.length === 0) {
      problems.push(`${field}: bindHosts must name at least one host`);
    }
    for (const bindHost of secret.bindHosts) {
      const host = policyHostProblem(bindHost, { allowIp: false });
      if (host !== undefined) problems.push(`${field}: bindHosts ${host}`);
    }
    problems.push(...methodsProblems(field, secret.methods));
    problems.push(...pathPrefixProblems(field, secret.pathPrefixes));
  }
  for (const [key, label] of [
    ["secretId", "secretId"],
    ["name", "name"],
    ["placeholder", "placeholder"],
  ] as const) {
    const twice = repeated(secrets.map((secret) => secret[key]));
    if (twice !== undefined) problems.push(`brokeredSecrets: ${label} \`${twice}\` appears twice`);
  }
  return problems;
};

/**
 * The problems with the values a request sends for its brokered secrets: each `secretRef` needs a
 * value, each value is one non-empty header value (no line breaks or control characters), and no
 * value goes unused. Never echoes a value.
 */
export const brokeredSecretValuesProblems = (
  secrets: readonly BrokeredSecret[],
  values: Readonly<Record<string, string>>,
): readonly string[] => {
  const problems: string[] = [];
  const refs = new Set(secrets.map((secret) => secret.secretRef));
  for (const ref of refs) {
    const value = values[ref];
    if (value === undefined) {
      problems.push(`brokeredSecretValues has no value for secretRef \`${ref}\``);
      continue;
    }
    if (
      value.length === 0 ||
      value.length > BROKERED_SECRET_VALUE_MAX_LENGTH ||
      // oxlint-disable-next-line no-control-regex -- a header value must hold no control character
      /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)
    ) {
      problems.push(
        `brokeredSecretValues \`${ref}\` must be one non-empty header value of at most ${BROKERED_SECRET_VALUE_MAX_LENGTH} characters`,
      );
    }
  }
  for (const ref of Object.keys(values)) {
    if (!refs.has(ref)) problems.push(`brokeredSecretValues \`${ref}\` names no brokered secret`);
  }
  return problems;
};

/** Whether a workspace with this policy and these secrets runs behind its own egress proxy. */
export const needsEgressProxy = (input: {
  readonly networkPolicy?: NetworkPolicy | undefined;
  readonly brokeredSecrets?: readonly BrokeredSecret[] | undefined;
}): boolean =>
  input.networkPolicy?.mode === "restricted" || (input.brokeredSecrets ?? []).length > 0;
