import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { normalizeSecret, toConnectedAccountSummary } from "./connected-accounts.module.js";

const run = (provider: "claude" | "codex" | "github", secret: string) =>
  Effect.runSyncExit(normalizeSecret(provider, secret));

describe("normalizeSecret, claude", () => {
  const document = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-access",
      refreshToken: "sk-ant-ort01-refresh",
      expiresAt: 1_789_000_000_000,
      subscriptionType: "max",
    },
    mcpOAuth: { "figma:https://figma.com": { refreshToken: "figma-refresh" } },
  });

  /**
   * A .credentials.json carries `mcpOAuth` beside the grant: refresh tokens for the MCP servers
   * the person authorized on their own machine. A client that narrows before sending sees no
   * change here; one that does not is still stored narrow (Mend's ADR 0005).
   */
  it("seals the grant alone, and records what it left out", () => {
    const outcome = run("claude", document);
    if (!Exit.isSuccess(outcome)) throw new Error("expected a normalized credential");
    const normalized = outcome.value;
    expect(normalized.kind).toBe("credentials-json");
    expect(normalized.payloadJson).not.toContain("figma-refresh");
    // The grant is intact: the workspace's Claude Code needs the refresh token to rotate it.
    expect(normalized.payloadJson).toContain("sk-ant-ort01-refresh");
    expect(normalized.metadata).toMatchObject({
      droppedSections: ["mcpOAuth"],
      connectedVia: "paste",
      subscriptionType: "max",
      expiresAt: 1_789_000_000_000,
    });
  });

  it("stores a document with nothing to drop exactly as it arrived", () => {
    const already = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-access" } });
    const outcome = run("claude", already);
    if (!Exit.isSuccess(outcome)) throw new Error("expected a normalized credential");
    expect(JSON.parse(outcome.value.payloadJson)).toEqual({ credentialsJson: already });
    expect(outcome.value.metadata).not.toHaveProperty("droppedSections");
  });

  it("leaves a setup token alone, and refuses anything else", () => {
    const token = run("claude", "sk-ant-oat01-a-setup-token");
    if (!Exit.isSuccess(token)) throw new Error("expected a normalized credential");
    expect(token.value.kind).toBe("oauth-token");
    expect(Exit.isFailure(run("claude", "neither one nor the other"))).toBe(true);
    expect(Exit.isFailure(run("claude", '{"mcpOAuth":{}}'))).toBe(true);
  });
});

const account = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "cacc_claude",
    ownerUserId: "user_1",
    provider: "claude",
    name: "default",
    kind: "credentials-json",
    status: "active",
    metadata: {},
    encryptedPayload: "sealed:…",
    encryptionKeyId: "k-test",
    payloadSha256: "sha",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    lastUsedAt: null,
    lastSyncedAt: null,
    invalidAt: null,
    archivedAt: null,
    ...overrides,
  }) as Parameters<typeof toConnectedAccountSummary>[0];

describe("toConnectedAccountSummary, credential freshness", () => {
  /**
   * Reported from the metadata mirror and the columns, never by opening the payload: a consumer
   * gets an observation, and the secret stays sealed (Mend's ADR 0005).
   */
  it("reports the two expiries and what the last sweep did", () => {
    const summary = toConnectedAccountSummary(
      account({
        metadata: {
          expiresAt: Date.parse("2026-09-18T18:20:18.245Z"),
          refreshTokenExpiresAt: Date.parse("2026-10-15T22:21:28.245Z"),
          lastRefreshOutcome: "refreshed",
        },
        lastSyncedAt: new Date("2026-09-18T12:00:00.000Z"),
      }),
    );
    expect(summary.credential).toEqual({
      accessExpiresAt: "2026-09-18T18:20:18.245Z",
      refreshExpiresAt: "2026-10-15T22:21:28.245Z",
      lastRefreshAt: "2026-09-18T12:00:00.000Z",
      lastRefreshOutcome: "refreshed",
    });
    expect(JSON.stringify(summary)).not.toContain("sealed:");
  });

  /** A setup token, or a row connected before this shipped, simply has nothing to report. */
  it("answers null for everything it did not observe", () => {
    expect(toConnectedAccountSummary(account()).credential).toEqual({
      accessExpiresAt: null,
      refreshExpiresAt: null,
      lastRefreshAt: null,
      lastRefreshOutcome: null,
    });
  });

  it("ignores a stored outcome it does not recognise, and a nonsense expiry", () => {
    const summary = toConnectedAccountSummary(
      account({ metadata: { lastRefreshOutcome: "something-else", expiresAt: 0 } }),
    );
    expect(summary.credential.lastRefreshOutcome).toBeNull();
    expect(summary.credential.accessExpiresAt).toBeNull();
  });
});
