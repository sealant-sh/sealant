import { describe, expect, it } from "vitest";

import {
  CODEX_SESSION_REFRESH_HORIZON_MS,
  codexAccessTokenExpiresAt,
  needsCodexSessionRefresh,
} from "./refresh-codex-sessions.js";

const jwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

describe("codexAccessTokenExpiresAt", () => {
  it("reads the access token's exp claim, in ms", () => {
    const authJson = JSON.stringify({ tokens: { access_token: jwt({ exp: 1_790_000_000 }) } });
    expect(codexAccessTokenExpiresAt(authJson)).toBe(1_790_000_000_000);
  });

  it("answers undefined for anything it cannot read", () => {
    expect(codexAccessTokenExpiresAt("not json")).toBeUndefined();
    expect(codexAccessTokenExpiresAt(JSON.stringify({ tokens: null }))).toBeUndefined();
    expect(
      codexAccessTokenExpiresAt(JSON.stringify({ tokens: { access_token: "opaque" } })),
    ).toBeUndefined();
  });
});

describe("needsCodexSessionRefresh", () => {
  const now = 1_790_000_000_000;

  it("refreshes an access token that expires within a day, and leaves a fresher one", () => {
    expect(
      needsCodexSessionRefresh({
        accessExpiresAt: now + CODEX_SESSION_REFRESH_HORIZON_MS - 1,
        lastRefresh: undefined,
        now,
      }),
    ).toBe(true);
    expect(
      needsCodexSessionRefresh({
        accessExpiresAt: now + CODEX_SESSION_REFRESH_HORIZON_MS + 60_000,
        lastRefresh: now - 30 * 24 * 60 * 60 * 1_000,
        now,
      }),
    ).toBe(false);
  });

  it("falls back to the login's age when the access token has no readable expiry", () => {
    const day = 24 * 60 * 60 * 1_000;
    expect(
      needsCodexSessionRefresh({ accessExpiresAt: undefined, lastRefresh: now - 8 * day, now }),
    ).toBe(true);
    expect(
      needsCodexSessionRefresh({ accessExpiresAt: undefined, lastRefresh: now - 2 * day, now }),
    ).toBe(false);
    expect(
      needsCodexSessionRefresh({ accessExpiresAt: undefined, lastRefresh: undefined, now }),
    ).toBe(false);
  });
});
