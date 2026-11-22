import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { makePrivateDir } from "./private-dir.js";

/*
Antigravity session-credential freshness + control-plane HOME provisioning (sibling of
claude-session.ts and codex-session.ts).

The store holds the only Google OAuth refresh token for an Antigravity login; workspaces receive a
stripped access-token-only copy (§6a "One refresher"). When the keep-fresh worker refreshes a login,
the decrypted file is materialized into a private per-invocation HOME (0700 dir, 0600 file) and the
official `agy` CLI (`agy models`, zero LLM tokens) is run against it. The refreshed file is read
back and persisted through the newest-wins and plausibility guards below.
*/

/** Relative path under `$HOME` where `agy` reads and writes its OAuth token file. */
export const ANTIGRAVITY_TOKEN_REL_PATH = ".gemini/antigravity-cli/antigravity-oauth-token";

/** Upper bound on how far ahead an observed `token.expiry` may plausibly sit. */
export const MAX_PLAUSIBLE_ANTIGRAVITY_EXPIRY_AHEAD_MS = 30 * 24 * 60 * 60 * 1_000;

/** Rejects sentinel expiries (real Google access tokens live ~1 hour). */
export const isPlausibleAntigravityExpiry = (
  expiresAt: number,
  now: number = Date.now(),
): boolean => {
  return expiresAt <= now + MAX_PLAUSIBLE_ANTIGRAVITY_EXPIRY_AHEAD_MS;
};

/**
 * Newest-wins guard on `token.expiry` (epoch millis): persist an observed file only when its expiry
 * is strictly later than the stored one (or the stored copy has none).
 */
export const isNewerAntigravityToken = (input: {
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
export const readStoredAntigravityExpiresAt = (
  metadata: Record<string, unknown> | null | undefined,
): number | undefined => {
  const expiresAt = metadata?.expiresAt;

  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined;
};

export interface ProvisionedAntigravityHome {
  readonly home: string;
  readonly tokenPath: string;
}

/**
 * Materialize a decrypted `antigravity-oauth-token` into a fresh private HOME (0700 dirs, 0600
 * file) that `agy` can be pointed at via `HOME`. Callers MUST remove the dir with
 * {@link removeAntigravityHome} when the invocation ends.
 */
export const provisionAntigravityHome = (input: {
  readonly tokenJson: string;
  /** Parent for the per-invocation dir; defaults to the OS tmp dir. */
  readonly baseDir?: string;
}): ProvisionedAntigravityHome =>
  makePrivateDir("sealant-antigravity-session-", input.baseDir, (home) => {
    const tokenPath = join(home, ANTIGRAVITY_TOKEN_REL_PATH);
    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, input.tokenJson, { mode: 0o600 });
    return { home, tokenPath };
  });

/**
 * Read the (possibly CLI-refreshed) `antigravity-oauth-token` back out of a provisioned HOME.
 * Returns undefined when missing or unreadable.
 */
export const readAntigravityHomeToken = (home: string): string | undefined => {
  try {
    return readFileSync(join(home, ANTIGRAVITY_TOKEN_REL_PATH), "utf8");
  } catch {
    return undefined;
  }
};

/** Best-effort removal of a provisioned HOME (secret material must not linger in tmp). */
export const removeAntigravityHome = (home: string): void => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Best-effort: a leaked tmp dir is preferable to failing the invocation that owned it.
  }
};
