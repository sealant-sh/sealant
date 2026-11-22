import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_SESSION_REFRESH_HORIZON_MS,
  ANTIGRAVITY_SESSION_REFRESH_INTERVAL_MS,
  antigravityDueForRefresh,
  needsAntigravitySessionRefresh,
} from "./refresh-antigravity-sessions.js";

describe("antigravity keep-fresh sweeper", () => {
  const now = Date.parse("2026-11-22T03:00:00Z");

  it("refreshes when expiry is within the horizon or past, and skips fresh or missing expiry", () => {
    expect(needsAntigravitySessionRefresh(now + ANTIGRAVITY_SESSION_REFRESH_HORIZON_MS, now)).toBe(
      true,
    );
    expect(
      needsAntigravitySessionRefresh(now + ANTIGRAVITY_SESSION_REFRESH_HORIZON_MS - 1, now),
    ).toBe(true);
    expect(needsAntigravitySessionRefresh(now - 1, now)).toBe(true);
    expect(
      needsAntigravitySessionRefresh(now + ANTIGRAVITY_SESSION_REFRESH_HORIZON_MS + 1, now),
    ).toBe(false);
    expect(needsAntigravitySessionRefresh(undefined, now)).toBe(false);
    expect(ANTIGRAVITY_SESSION_REFRESH_INTERVAL_MS).toBeLessThan(
      ANTIGRAVITY_SESSION_REFRESH_HORIZON_MS,
    );
  });

  it("marks token.expiry in the past while preserving refresh_token so agy refreshes immediately", () => {
    const original = JSON.stringify({
      token: {
        access_token: "ya29.old",
        refresh_token: "1//keep-me",
        expiry: new Date(now + 15 * 60_000).toISOString(),
      },
      id_token_email: "dev@example.com",
    });
    const due: unknown = JSON.parse(antigravityDueForRefresh(original, now));
    expect(due).toEqual({
      token: {
        access_token: "ya29.old",
        refresh_token: "1//keep-me",
        expiry: new Date(now - 2 * 60_000).toISOString(),
      },
      id_token_email: "dev@example.com",
    });
  });
});
