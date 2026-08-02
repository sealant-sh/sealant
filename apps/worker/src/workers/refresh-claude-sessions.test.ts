import { describe, expect, it } from "vitest";

import {
  CLAUDE_SESSION_REFRESH_HORIZON_MS,
  CLAUDE_SESSION_REFRESH_INTERVAL_MS,
  needsClaudeSessionRefresh,
} from "./refresh-claude-sessions.js";

describe("needsClaudeSessionRefresh", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");

  it("refreshes already-expired sessions", () => {
    expect(needsClaudeSessionRefresh(now - 1, now)).toBe(true);
    expect(needsClaudeSessionRefresh(now - 8 * 60 * 60 * 1_000, now)).toBe(true);
  });

  it("refreshes sessions expiring within the horizon (inclusive)", () => {
    expect(needsClaudeSessionRefresh(now + CLAUDE_SESSION_REFRESH_HORIZON_MS, now)).toBe(true);
    expect(needsClaudeSessionRefresh(now + CLAUDE_SESSION_REFRESH_HORIZON_MS - 1, now)).toBe(true);
  });

  it("leaves sessions alone that expire beyond the horizon", () => {
    expect(needsClaudeSessionRefresh(now + CLAUDE_SESSION_REFRESH_HORIZON_MS + 1, now)).toBe(false);
    expect(needsClaudeSessionRefresh(now + 8 * 60 * 60 * 1_000, now)).toBe(false);
  });

  it("leaves sessions alone whose staleness cannot be judged (no stored expiry)", () => {
    expect(needsClaudeSessionRefresh(undefined, now)).toBe(false);
  });

  it("sweeps more often than the horizon so no expiry can slip between ticks", () => {
    expect(CLAUDE_SESSION_REFRESH_INTERVAL_MS).toBeLessThan(CLAUDE_SESSION_REFRESH_HORIZON_MS);
  });
});
