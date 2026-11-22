import { existsSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_TOKEN_PATH,
  antigravityTokenCanRefresh,
  antigravityTokenCopy,
  CredentialCopyError,
  credentialKindOf,
  extractAntigravitySecrets,
  isNewerAntigravityToken,
  isPlausibleAntigravityExpiry,
  loginClassOf,
  MAX_PLAUSIBLE_ANTIGRAVITY_EXPIRY_AHEAD_MS,
  parseAntigravityTokenJson,
  parseStoredCredential,
  placedLoginOf,
  planCredentialInjections,
  provisionAntigravityHome,
  readAntigravityHomeToken,
  removeAntigravityHome,
} from "./index.js";

const SAMPLE_TOKEN = JSON.stringify({
  token: {
    access_token: "ya29.test-access-token-1234",
    token_type: "Bearer",
    refresh_token: "1//test-refresh-token-5678",
    expiry: "2026-11-22T05:51:27.933735258+02:00",
    expires_in: 3599,
  },
  auth_method: "oauth",
  id_token_email: "dev@example.com",
});

describe("antigravity credentials", () => {
  it("parses non-secret metadata including nanosecond RFC3339 expiry", () => {
    const parsed = parseAntigravityTokenJson(SAMPLE_TOKEN);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) return;
    expect(parsed.metadata).toEqual({
      tokenSuffix: "1234",
      email: "dev@example.com",
      authMethod: "oauth",
      expiresAt: Date.parse("2026-11-22T05:51:27.933735258+02:00"),
    });
  });

  it("rejects non-JSON or missing access_token payloads", () => {
    expect(parseAntigravityTokenJson("not json").valid).toBe(false);
    expect(parseAntigravityTokenJson(JSON.stringify({ token: {} })).valid).toBe(false);
    expect(parseAntigravityTokenJson(JSON.stringify({})).valid).toBe(false);
  });

  it("strips refresh_token in workspace copies and preserves access_token and metadata", () => {
    expect(antigravityTokenCanRefresh(SAMPLE_TOKEN)).toBe(true);
    const copy = antigravityTokenCopy(SAMPLE_TOKEN);
    expect(antigravityTokenCanRefresh(copy)).toBe(false);
    const parsed: unknown = JSON.parse(copy);
    expect(parsed).toEqual({
      token: {
        access_token: "ya29.test-access-token-1234",
        token_type: "Bearer",
        expiry: "2026-11-22T05:51:27.933735258+02:00",
        expires_in: 3599,
      },
      auth_method: "oauth",
      id_token_email: "dev@example.com",
    });
    expect(() => antigravityTokenCopy("{}")).toThrow(CredentialCopyError);
  });

  it("plans a mode 600 file injection with the stripped copy", () => {
    const stored = parseStoredCredential(
      "antigravity",
      JSON.stringify({ tokenJson: SAMPLE_TOKEN }),
    );
    expect(credentialKindOf(...stored)).toBe("antigravity-token");
    expect(loginClassOf(...stored)).toBe("subscription");
    expect(placedLoginOf(...stored)).toEqual({ kind: "subscription" });

    const injections = planCredentialInjections("antigravity", { tokenJson: SAMPLE_TOKEN });
    expect(injections).toHaveLength(1);
    const injection = injections[0];
    expect(injection?.kind).toBe("file");
    if (injection?.kind !== "file") return;
    expect(injection.path).toBe(ANTIGRAVITY_TOKEN_PATH);
    expect(injection.mode).toBe("600");
    const decoded = Buffer.from(injection.contentBase64, "base64").toString("utf8");
    expect(antigravityTokenCanRefresh(decoded)).toBe(false);
    expect(decoded).toContain("ya29.test-access-token-1234");
  });

  it("extracts both access and refresh tokens for redaction", () => {
    expect(extractAntigravitySecrets(SAMPLE_TOKEN)).toEqual([
      "ya29.test-access-token-1234",
      "1//test-refresh-token-5678",
    ]);
  });

  it("enforces newest-wins and plausibility guards", () => {
    const now = 1_800_000_000_000;
    expect(isPlausibleAntigravityExpiry(now + 3_600_000, now)).toBe(true);
    expect(
      isPlausibleAntigravityExpiry(now + MAX_PLAUSIBLE_ANTIGRAVITY_EXPIRY_AHEAD_MS + 1, now),
    ).toBe(false);
    expect(isNewerAntigravityToken({ observedExpiresAt: 200, storedExpiresAt: 100 })).toBe(true);
    expect(isNewerAntigravityToken({ observedExpiresAt: 100, storedExpiresAt: 100 })).toBe(false);
    expect(isNewerAntigravityToken({ observedExpiresAt: undefined, storedExpiresAt: 100 })).toBe(
      false,
    );
    expect(isNewerAntigravityToken({ observedExpiresAt: 200, storedExpiresAt: undefined })).toBe(
      true,
    );
  });

  it("provisions and cleans up a 0700/0600 private home", () => {
    const provisioned = provisionAntigravityHome({ tokenJson: SAMPLE_TOKEN });
    try {
      expect(statSync(provisioned.home).mode & 0o777).toBe(0o700);
      expect(statSync(provisioned.tokenPath).mode & 0o777).toBe(0o600);
      expect(readAntigravityHomeToken(provisioned.home)).toBe(SAMPLE_TOKEN);
    } finally {
      removeAntigravityHome(provisioned.home);
    }
    expect(existsSync(provisioned.home)).toBe(false);
  });
});
