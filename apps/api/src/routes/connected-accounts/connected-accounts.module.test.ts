import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { normalizeSecret } from "./connected-accounts.module.js";

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
