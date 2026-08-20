import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
Codex control-plane CODEX_HOME provisioning (design doc §2 codex / §6), sibling of
claude-session.ts.

When the control plane itself needs the official Codex CLI to consume (and possibly refresh) a
stored auth.json — inference at point of use — the decrypted file is materialized into a private
per-invocation directory (0700 dir, 0600 file) and the official CLI is pointed at it via
CODEX_HOME. The control plane NEVER calls OpenAI's token endpoint; the CLI performs any refresh,
and the mutated file is read back and persisted newest-wins (`persistCodexAuthJsonIfNewer` in
@sealant/workspaces, guarded by `isNewerCodexAuthRefresh` — the refresh token ROTATES, so an
equal-or-older write-back could permanently brick the credential).

The freshness guard itself stays in @sealant/workspaces next to the workspace sync-back; this
module only owns the filesystem mechanics, mirroring claude-session.ts's config-dir section.
*/

/** Env var the official Codex CLI honors for relocating its home (auth.json, config, sessions). */
export const CODEX_HOME_ENV_KEY = "CODEX_HOME";

/** File name the official CLI reads/rewrites inside its home dir. */
export const CODEX_AUTH_FILE_NAME = "auth.json";

export interface ProvisionedCodexHome {
  readonly codexHome: string;
  readonly authJsonPath: string;
}

/**
 * Materialize a decrypted auth.json into a fresh private home dir the official CLI can be pointed
 * at (via {@link CODEX_HOME_ENV_KEY}): 0700 directory, 0600 file — the same exposure as the CLI's
 * own `~/.codex`. Callers own the lifetime and MUST remove the dir with {@link removeCodexHome}
 * when the invocation ends (success or failure).
 *
 * Note: a CODEX_HOME under the OS tmp dir makes the CLI log a "refusing to create PATH aliases"
 * warning to stderr; that is cosmetic — auth and config resolution work normally.
 */
export const provisionCodexHome = (input: {
  readonly authJson: string;
  /** Parent for the per-invocation dir; defaults to the OS tmp dir. */
  readonly baseDir?: string;
}): ProvisionedCodexHome => {
  // mkdtemp creates the directory 0700 already; the explicit mode on the file is the part that
  // matters (writeFileSync defaults to 0666 & umask).
  const codexHome = mkdtempSync(join(input.baseDir ?? tmpdir(), "sealant-codex-session-"));
  const authJsonPath = join(codexHome, CODEX_AUTH_FILE_NAME);
  writeFileSync(authJsonPath, input.authJson, { mode: 0o600 });

  return { codexHome, authJsonPath };
};

/**
 * Read the (possibly CLI-rotated) auth.json back out of a provisioned home dir. Returns undefined
 * when the file is missing or unreadable — the caller keeps the stored copy.
 */
export const readCodexHomeAuthJson = (codexHome: string): string | undefined => {
  try {
    return readFileSync(join(codexHome, CODEX_AUTH_FILE_NAME), "utf8");
  } catch {
    return undefined;
  }
};

/** Best-effort removal of a provisioned home dir (secret material must not linger in tmp). */
export const removeCodexHome = (codexHome: string): void => {
  try {
    rmSync(codexHome, { recursive: true, force: true });
  } catch {
    // Best-effort: a leaked tmp dir is preferable to failing the invocation that owned it.
  }
};
