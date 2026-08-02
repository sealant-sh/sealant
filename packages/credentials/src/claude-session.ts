import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
Claude session-credential freshness + control-plane config dirs (design doc §2 claude / §6).

Freshness: the official Claude Code CLI rotates a session's access token and rewrites
.credentials.json wherever it runs — inside a workspace ($HOME/.claude/.credentials.json) or
against a control-plane-provisioned CLAUDE_CONFIG_DIR. Every consumer that observes a rotated file
persists it through the same two guards:

- Newest-wins: only a `claudeAiOauth.expiresAt` strictly later than the stored copy's may be
  written back (an equal-or-older copy could clobber a fresher rotation persisted elsewhere).
- Plausibility belt: an observed expiresAt more than 30 days ahead of now is a sentinel (real
  session tokens live hours) and is rejected outright — persisting one would make the
  strictly-greater guard freeze out every real rotation afterward.

Config dirs: when the control plane itself needs the CLI to consume (and refresh) a session file —
inference at point of use, the worker's keep-fresh sweeper — the decrypted file is materialized
into a private per-invocation directory (0700 dir, 0600 file) and the official CLI is pointed at it
via CLAUDE_CONFIG_DIR. The control plane NEVER calls Anthropic's token endpoint; the CLI performs
the refresh, and the mutated file is read back and persisted newest-wins.
*/

// ---------------------------------------------------------------------------
// Freshness guards (shared by workspace sync-backs, inference, and the sweeper)
// ---------------------------------------------------------------------------

/** Upper bound on how far ahead an observed claudeAiOauth.expiresAt may plausibly sit. */
export const MAX_PLAUSIBLE_CLAUDE_EXPIRY_AHEAD_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Rejects sentinel expiries (see the plausibility belt above). `now` is injectable for tests.
 */
export const isPlausibleClaudeExpiry = (expiresAt: number, now: number = Date.now()): boolean => {
  return expiresAt <= now + MAX_PLAUSIBLE_CLAUDE_EXPIRY_AHEAD_MS;
};

/**
 * Newest-wins guard on `claudeAiOauth.expiresAt` (epoch millis): persist the observed file only
 * when its expiry is strictly later than the stored one (or the stored copy has none). A missing
 * observed expiry never wins — when in doubt, keep the stored copy.
 */
export const isNewerClaudeCredentials = (input: {
  readonly observedExpiresAt: number | undefined;
  readonly storedExpiresAt: number | undefined;
}): boolean => {
  if (input.observedExpiresAt === undefined) {
    return false;
  }

  if (input.storedExpiresAt === undefined) {
    return true;
  }

  return input.observedExpiresAt > input.storedExpiresAt;
};

/** Read `metadata.expiresAt` defensively — metadata is a free-form Record<string, unknown>. */
export const readStoredClaudeExpiresAt = (
  metadata: Record<string, unknown> | null | undefined,
): number | undefined => {
  const expiresAt = metadata?.expiresAt;

  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined;
};

// ---------------------------------------------------------------------------
// Control-plane CLAUDE_CONFIG_DIR provisioning
// ---------------------------------------------------------------------------

/** Env var the official CLI honors for relocating its config (and .credentials.json). */
export const CLAUDE_CONFIG_DIR_ENV_KEY = "CLAUDE_CONFIG_DIR";

/** File name the official CLI reads/rewrites inside its config dir. */
export const CLAUDE_CREDENTIALS_FILE_NAME = ".credentials.json";

export interface ProvisionedClaudeConfigDir {
  readonly configDir: string;
  readonly credentialsPath: string;
}

/**
 * Materialize a decrypted session credentials file into a fresh private config dir the official
 * CLI can be pointed at (via {@link CLAUDE_CONFIG_DIR_ENV_KEY}): 0700 directory, 0600 file —
 * the same exposure as the CLI's own `~/.claude`. Callers own the lifetime and MUST remove the
 * dir with {@link removeClaudeConfigDir} when the invocation ends (success or failure).
 */
export const provisionClaudeConfigDir = (input: {
  readonly credentialsJson: string;
  /** Parent for the per-invocation dir; defaults to the OS tmp dir. */
  readonly baseDir?: string;
}): ProvisionedClaudeConfigDir => {
  // mkdtemp creates the directory 0700 already; the explicit mode on the file is the part that
  // matters (writeFileSync defaults to 0666 & umask).
  const configDir = mkdtempSync(join(input.baseDir ?? tmpdir(), "sealant-claude-session-"));
  const credentialsPath = join(configDir, CLAUDE_CREDENTIALS_FILE_NAME);
  writeFileSync(credentialsPath, input.credentialsJson, { mode: 0o600 });

  return { configDir, credentialsPath };
};

/**
 * Read the (possibly CLI-rotated) credentials file back out of a provisioned config dir.
 * Returns undefined when the file is missing or unreadable — the caller keeps the stored copy.
 */
export const readClaudeConfigDirCredentials = (configDir: string): string | undefined => {
  try {
    return readFileSync(join(configDir, CLAUDE_CREDENTIALS_FILE_NAME), "utf8");
  } catch {
    return undefined;
  }
};

/** Best-effort removal of a provisioned config dir (secret material must not linger in tmp). */
export const removeClaudeConfigDir = (configDir: string): void => {
  try {
    rmSync(configDir, { recursive: true, force: true });
  } catch {
    // Best-effort: a leaked tmp dir is preferable to failing the invocation that owned it.
  }
};
