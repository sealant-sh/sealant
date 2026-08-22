/**
 * Deterministic, DNS-safe Kubernetes names derived from the run (attempt) id.
 *
 * One run id must always map to the same names so a redelivered launch adopts instead of
 * duplicating, and so stop/reconcile can address everything without a lookup table. The run id
 * may contain characters a DNS label cannot; it is lowercased and sanitized, then a short hash of
 * the ORIGINAL id is appended so two ids that sanitize identically still get distinct names.
 */
import { createHash } from "node:crypto";

/** Longest name we emit. Service names are DNS-1035 labels (63); leave room for suffixes. */
const MAX_BASE_LENGTH = 40;
const HASH_LENGTH = 6;
const PREFIX = "ws";

const hashOf = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH);

/** `ws-<sanitized>-<hash>`: the Pod and Service name (and the prefix of every related object). */
export const workspaceResourceName = (runId: string): string => {
  const trimmed = runId.trim();
  if (trimmed.length === 0) {
    throw new Error("runId must not be empty");
  }
  const sanitized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_BASE_LENGTH)
    .replace(/-+$/g, "");
  const base = sanitized.length === 0 ? "run" : sanitized;
  return `${PREFIX}-${base}-${hashOf(trimmed)}`;
};

/** Every object created for one workspace attempt. */
export interface WorkspaceResourceNames {
  readonly pod: string;
  readonly service: string;
  /** Secret holding env.json + credential files (+ small dotfiles). Projected at /run/sealant/launch. */
  readonly launchSecret: string;
  /** Secret whose keys become container env (credential + platform env). */
  readonly envSecret: string;
  /** cert-manager Certificate resource. */
  readonly certificate: string;
  /** The Secret cert-manager writes (tls.crt / tls.key / ca.crt). */
  readonly tlsSecret: string;
}

export const workspaceResourceNames = (runId: string): WorkspaceResourceNames => {
  const base = workspaceResourceName(runId);
  return {
    pod: base,
    service: base,
    launchSecret: `${base}-launch`,
    envSecret: `${base}-env`,
    certificate: base,
    tlsSecret: `${base}-tls`,
  };
};

/** The in-cluster DNS name the Service answers on and the server certificate must carry. */
export const workspaceServiceDnsName = (serviceName: string, namespace: string): string =>
  `${serviceName}.${namespace}.svc`;

/** The endpoint persisted on the runtime instance and consumed by `sealantTargetForRuntimeInstance`. */
export const workspaceControlEndpoint = (
  serviceName: string,
  namespace: string,
  port: number,
): string => `wss://${workspaceServiceDnsName(serviceName, namespace)}:${port}/control`;

/** DNS-1123 label check used by tests and by the manifest builders as a last guard. */
export const isDnsLabel = (value: string): boolean =>
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) && value.length <= 63;
