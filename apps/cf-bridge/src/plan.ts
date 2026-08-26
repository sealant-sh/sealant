/**
 * Pure launch planning for the bridge Worker: sandbox naming, the sealantd boot environment, and
 * request authentication. Everything here is unit-testable with no Cloudflare runtime in sight.
 */
import type { BridgeLaunchRequest } from "@sealant/workspaces/cloudflare/bridge-contract";

/** In-sandbox loopback port the socat relay binds; `wsConnect` proxies control bytes to it. */
export const CONTROL_RELAY_PORT = 7078;

/** In-sandbox path sealantd binds its control socket on (matches the image contract). */
export const CONTROL_SOCKET_PATH = "/run/sealant/control.sock";

/** Where the secret env file is staged for `sealantd boot` (mirrors the Docker/K8s mount path). */
export const SECRET_ENV_FILE_PATH = "/run/sealant/secrets/env.json";

/** Where dotfiles archives are staged for `sealantd boot`. */
export const DOTFILES_ARCHIVE_DIR = "/run/sealant/dotfiles";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Tiny stable hash so any run id yields a valid, collision-resistant sandbox name suffix. */
const fnv1aHex = (value: string): string => {
  let hash = FNV_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * Deterministic sandbox name per run: a redelivered launch resolves to the SAME sandbox (adopt,
 * never duplicate), mirroring the docker/k8s deterministic-name discipline. Sanitized to a
 * DNS-label-ish alphabet with a stable hash suffix so distinct run ids can never collide after
 * sanitization.
 */
export const sandboxNameForRun = (runId: string): string => {
  const sanitized = runId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `ws-${sanitized}-${fnv1aHex(runId)}`;
};

/**
 * The env contract `sealantd boot` reads (crates/sealantd boot/config.rs), assembled the same way
 * the Docker adapter assembles its `-e` flags: workspace source facts first, then the request's
 * launch env (blueprint, platform, credential — precedence already resolved by the adapter).
 */
export const bootEnvForLaunch = (request: BridgeLaunchRequest): Record<string, string> => ({
  SEALANT_CONTROL_SOCKET: CONTROL_SOCKET_PATH,
  SEALANT_WORKSPACE_ROOT: "/workspace",
  SEALANT_WORKING_DIRECTORY: "/workspace/repo",
  SEALANT_WORKSPACE_SOURCE: "git",
  SEALANT_WORKSPACE_REPO_URL: request.source.url,
  ...(request.source.ref === undefined ? {} : { SEALANT_WORKSPACE_REPO_REF: request.source.ref }),
  ...(request.source.auth === undefined
    ? {}
    : {
        SEALANT_WORKSPACE_HTTP_USERNAME: request.source.auth.username,
        SEALANT_WORKSPACE_HTTP_TOKEN: request.source.auth.token,
      }),
  ...(request.secretEnv === undefined ? {} : { SEALANT_SECRET_ENV_FILE: SECRET_ENV_FILE_PATH }),
  ...(request.dotfiles === undefined ? {} : { SEALANT_DOTFILES_ARCHIVE_DIR: DOTFILES_ARCHIVE_DIR }),
  ...request.env,
});

/**
 * Constant-time-ish bearer comparison (no early exit on the first differing byte). Workers have
 * no `timingSafeEqual`; XOR-folding the whole string is the standard substitute.
 */
export const bearerMatches = (header: string | null, expected: string): boolean => {
  if (header === null || !header.startsWith("Bearer ") || expected.length === 0) {
    return false;
  }
  const presented = header.slice("Bearer ".length);
  let mismatch = presented.length ^ expected.length;
  const length = Math.max(presented.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (presented.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return mismatch === 0;
};
