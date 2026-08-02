import { statSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "@effect/vitest";

import {
  isNewerClaudeCredentials,
  isPlausibleClaudeExpiry,
  MAX_PLAUSIBLE_CLAUDE_EXPIRY_AHEAD_MS,
  provisionClaudeConfigDir,
  readClaudeConfigDirCredentials,
  readStoredClaudeExpiresAt,
  removeClaudeConfigDir,
} from "./claude-session.js";

describe("isNewerClaudeCredentials", () => {
  it("never persists when the observed file has no expiresAt", () => {
    expect(
      isNewerClaudeCredentials({ observedExpiresAt: undefined, storedExpiresAt: undefined }),
    ).toBe(false);
    expect(isNewerClaudeCredentials({ observedExpiresAt: undefined, storedExpiresAt: 100 })).toBe(
      false,
    );
  });

  it("persists a first-ever expiry", () => {
    expect(isNewerClaudeCredentials({ observedExpiresAt: 100, storedExpiresAt: undefined })).toBe(
      true,
    );
  });

  it("persists only strictly newer expiries (rotated-session safety)", () => {
    expect(isNewerClaudeCredentials({ observedExpiresAt: 200, storedExpiresAt: 100 })).toBe(true);
    // Equal must NOT write.
    expect(isNewerClaudeCredentials({ observedExpiresAt: 100, storedExpiresAt: 100 })).toBe(false);
    // Older must NOT write.
    expect(isNewerClaudeCredentials({ observedExpiresAt: 50, storedExpiresAt: 100 })).toBe(false);
  });
});

describe("isPlausibleClaudeExpiry", () => {
  const now = Date.parse("2026-08-01T00:00:00.000Z");

  it("accepts past and near-future expiries (real sessions live hours)", () => {
    expect(isPlausibleClaudeExpiry(now - 60_000, now)).toBe(true);
    expect(isPlausibleClaudeExpiry(now + 8 * 60 * 60 * 1_000, now)).toBe(true);
    expect(isPlausibleClaudeExpiry(now + MAX_PLAUSIBLE_CLAUDE_EXPIRY_AHEAD_MS, now)).toBe(true);
  });

  it("rejects sentinel expiries more than 30 days ahead", () => {
    expect(isPlausibleClaudeExpiry(now + MAX_PLAUSIBLE_CLAUDE_EXPIRY_AHEAD_MS + 1, now)).toBe(
      false,
    );
    // The concrete poisoning case: a harness-seeded file stamped with a far-future sentinel.
    expect(isPlausibleClaudeExpiry(9_999_999_999_999, now)).toBe(false);
  });
});

describe("readStoredClaudeExpiresAt", () => {
  it("reads a numeric expiresAt and rejects everything else", () => {
    expect(readStoredClaudeExpiresAt({ expiresAt: 123 })).toBe(123);
    expect(readStoredClaudeExpiresAt({ expiresAt: "123" })).toBeUndefined();
    expect(readStoredClaudeExpiresAt({ expiresAt: Number.NaN })).toBeUndefined();
    expect(readStoredClaudeExpiresAt({})).toBeUndefined();
    expect(readStoredClaudeExpiresAt(null)).toBeUndefined();
  });
});

describe("claude config dir provisioning", () => {
  const credentialsJson = JSON.stringify({
    claudeAiOauth: { accessToken: "sk-ant-oat01-test", expiresAt: 1_750_000_000_000 },
  });

  it("materializes a private dir (0700) with a private file (0600) and reads it back", () => {
    const provisioned = provisionClaudeConfigDir({ credentialsJson });
    try {
      expect(provisioned.configDir.startsWith(tmpdir())).toBe(true);
      expect(statSync(provisioned.configDir).mode & 0o777).toBe(0o700);
      expect(statSync(provisioned.credentialsPath).mode & 0o777).toBe(0o600);
      expect(readClaudeConfigDirCredentials(provisioned.configDir)).toBe(credentialsJson);
    } finally {
      removeClaudeConfigDir(provisioned.configDir);
    }
  });

  it("returns undefined for a missing file and removal is idempotent", () => {
    const provisioned = provisionClaudeConfigDir({ credentialsJson });
    removeClaudeConfigDir(provisioned.configDir);
    expect(readClaudeConfigDirCredentials(provisioned.configDir)).toBeUndefined();
    // Removing an already-removed dir must not throw.
    removeClaudeConfigDir(provisioned.configDir);
  });
});
