/**
 * Pure launch planning for the bridge Worker: sandbox naming, the sealantd boot environment, and
 * request authentication. Everything here is unit-testable with no Cloudflare runtime in sight.
 */
import type { SandboxOptions } from "@cloudflare/sandbox";
import {
  bridgeStopModeSchema,
  type BridgeLaunchRequest,
  type BridgeStopMode,
} from "@sealant/workspaces/cloudflare/bridge-contract";

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
  ...sourceEnv(request.source),
  ...(request.secretEnv === undefined ? {} : { SEALANT_SECRET_ENV_FILE: SECRET_ENV_FILE_PATH }),
  ...(request.dotfiles === undefined ? {} : { SEALANT_DOTFILES_ARCHIVE_DIR: DOTFILES_ARCHIVE_DIR }),
  ...request.env,
  ...(request.source.kind === "capture" && request.source.harnessHome !== undefined
    ? { SEALANT_CAPTURE_HARNESS_HOME: request.source.harnessHome }
    : {}),
});

/**
 * The source's boot facts. A capture source (sealantd ADR-0015) mounts nothing: the daemon
 * materialises the worktree from the session channel onto the sandbox disk; its credential is in
 * the secret env file (as `SEALANT_CAPTURE_TOKEN`), never in the process environment.
 */
const sourceEnv = (source: BridgeLaunchRequest["source"]): Record<string, string> =>
  source.kind === "capture"
    ? {
        SEALANT_WORKSPACE_SOURCE: "capture",
        SEALANT_CAPTURE_ENDPOINT: source.endpoint,
        // A standby executor names no worktree yet; the daemon takes it from the plan answer.
        ...(source.worktreeId === undefined
          ? {}
          : { SEALANT_CAPTURE_WORKTREE_ID: source.worktreeId }),
        ...(source.harnessHome === undefined
          ? {}
          : { SEALANT_CAPTURE_HARNESS_HOME: source.harnessHome }),
      }
    : {
        SEALANT_WORKSPACE_SOURCE: "git",
        SEALANT_WORKSPACE_REPO_URL: source.url,
        ...(source.ref === undefined ? {} : { SEALANT_WORKSPACE_REPO_REF: source.ref }),
        ...(source.auth === undefined
          ? {}
          : {
              SEALANT_WORKSPACE_HTTP_USERNAME: source.auth.username,
              SEALANT_WORKSPACE_HTTP_TOKEN: source.auth.token,
            }),
      };

/**
 * Sandbox options for a launch. A capture executor must not be put to sleep by the platform's
 * idle timer: its liveness is a lease heartbeat the platform cannot see, and a sleeping sandbox
 * loses the lease. `keepAlive` persists in the Durable Object, so the option-less `getSandbox`
 * calls of the control and stop routes leave it in place; the ADR's planned stop (`stop()`) and
 * fence (`destroy()`) are the only ways such a sandbox ends. Git launches keep the SDK default.
 */
export const sandboxOptionsForLaunch = (request: BridgeLaunchRequest): SandboxOptions =>
  request.source.kind === "capture" ? { keepAlive: true } : {};

/**
 * The stop mode a DELETE names: `?mode=fence` destroys (SIGKILL, confirmed-termination fencing);
 * anything else is a planned stop (SIGTERM, the daemon's flush window). An unknown value is a
 * request error rather than a silent default, so a typo can never skip the flush.
 */
export const stopModeFromUrl = (url: URL): BridgeStopMode | undefined => {
  const raw = url.searchParams.get("mode");
  if (raw === null) {
    return "planned";
  }
  const parsed = bridgeStopModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

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

/**
 * Where a launch's files are staged before they are put in place: root's only (0700), outside the
 * workspace and every capture root. The bridge writes each file's bytes here through the sandbox's
 * file API, so no process ever carries them in its arguments or environment.
 */
export const STAGING_DIR = "/run/sealant/staging";

/** Makes the staging directory, root's only. */
export const PREPARE_STAGING_SCRIPT = `umask 077; mkdir -p ${STAGING_DIR} && chmod 700 ${STAGING_DIR}`;

/**
 * Puts one staged file in place and removes the staged copy, whatever happens. Its environment
 * carries only paths and a mode: `SEALANT_STAGED` (the staged file), `SEALANT_WRITE_PATH` (absolute,
 * or `$HOME/…`, expanded here to the sandbox user's home) and `SEALANT_WRITE_MODE`. Exits 64 for a
 * path that is neither.
 */
export const INSTALL_STAGED_SCRIPT = [
  "umask 077",
  `case "$SEALANT_WRITE_PATH" in '$HOME/'*) p="$HOME/\${SEALANT_WRITE_PATH#'$HOME/'}" ;; /*) p="$SEALANT_WRITE_PATH" ;; *) rm -f "$SEALANT_STAGED"; exit 64 ;; esac`,
  `mkdir -p "$(dirname "$p")" && cat "$SEALANT_STAGED" > "$p" && chmod "$SEALANT_WRITE_MODE" "$p" && s=0 || s=$?`,
  `rm -f "$SEALANT_STAGED"`,
  `exit "$s"`,
].join("\n");

/** One file a launch stages and puts in place. */
export interface StagedWrite {
  /** Where its bytes are staged, under `STAGING_DIR`. */
  readonly stagingPath: string;
  /** The bytes, as the sandbox's `writeFile` takes them. */
  readonly content: string;
  readonly encoding: "base64" | "utf-8";
  /** The environment of the exec that puts it in place: paths and a mode, never the bytes. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Every file a launch writes before `sealantd boot`, in order: the secret env file, the credential
 * files, then the dotfiles manifest and archives. A credential file that names a `credentialsHome`
 * is refused: Cloudflare does not support one (the adapter refuses it first).
 */
export const stagedWritesForLaunch = (request: BridgeLaunchRequest): readonly StagedWrite[] => {
  const files: Array<{
    readonly path: string;
    readonly content: string;
    readonly encoding: StagedWrite["encoding"];
    readonly mode: string;
  }> = [];
  if (request.secretEnv !== undefined) {
    files.push({
      path: SECRET_ENV_FILE_PATH,
      content: JSON.stringify(request.secretEnv),
      encoding: "utf-8",
      mode: "600",
    });
  }
  for (const file of request.credentialFiles ?? []) {
    if (file.home !== undefined) {
      throw new Error(
        `credential file '${file.path}' names a credentialsHome, which the Cloudflare runtime does not support`,
      );
    }
    files.push({
      path: file.path,
      content: file.contentBase64,
      encoding: "base64",
      mode: file.mode,
    });
  }
  if (request.dotfiles !== undefined) {
    files.push({
      path: `${DOTFILES_ARCHIVE_DIR}/manifest.json`,
      content: request.dotfiles.manifestJson,
      encoding: "utf-8",
      mode: "644",
    });
    for (const archive of request.dotfiles.archives) {
      files.push({
        path: `${DOTFILES_ARCHIVE_DIR}/${archive.name}`,
        content: archive.contentBase64,
        encoding: "base64",
        mode: "644",
      });
    }
  }
  return files.map((file, index) => {
    const stagingPath = `${STAGING_DIR}/${String(index)}`;
    return {
      stagingPath,
      content: file.content,
      encoding: file.encoding,
      env: {
        SEALANT_STAGED: stagingPath,
        SEALANT_WRITE_PATH: file.path,
        SEALANT_WRITE_MODE: file.mode,
      },
    };
  });
};
