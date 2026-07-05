import { describe, expect, it } from "vitest";

import {
  CLAUDE_TOKEN_PREFIX,
  hasKnownGitHubTokenPrefix,
  parseClaudeCredentialPayload,
  parseCodexAuthJson,
  parseGitHubCredentialPayload,
} from "./payloads.js";

const base64Url = (value: string): string => {
  return Buffer.from(value, "utf8").toString("base64url");
};

const makeIdToken = (claims: Record<string, unknown>): string => {
  return `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify(claims),
  )}.signature`;
};

describe("claude payload", () => {
  it("accepts tokens with the setup-token prefix", () => {
    const token = `${CLAUDE_TOKEN_PREFIX}abc123`;

    expect(parseClaudeCredentialPayload({ token })).toEqual({ token });
  });

  it("rejects tokens without the prefix", () => {
    expect(() => parseClaudeCredentialPayload({ token: "sk-ant-api03-nope" })).toThrow();
  });
});

describe("github payload", () => {
  it("accepts any non-empty token; prefix knowledge is caller-level", () => {
    expect(parseGitHubCredentialPayload({ token: "gho_abc" })).toEqual({ token: "gho_abc" });
    expect(parseGitHubCredentialPayload({ token: "weird-token" })).toEqual({
      token: "weird-token",
    });
    expect(() => parseGitHubCredentialPayload({ token: "" })).toThrow();
  });

  it("recognizes the known gh token prefixes", () => {
    expect(hasKnownGitHubTokenPrefix("gho_abc")).toBe(true);
    expect(hasKnownGitHubTokenPrefix("ghp_abc")).toBe(true);
    expect(hasKnownGitHubTokenPrefix("github_pat_abc")).toBe(true);
    expect(hasKnownGitHubTokenPrefix("sk-ant-oat01-abc")).toBe(false);
  });
});

describe("parseCodexAuthJson", () => {
  it("rejects non-JSON input", () => {
    expect(parseCodexAuthJson("not json {")).toEqual({
      valid: false,
      reason: "auth.json is not valid JSON.",
    });
  });

  it("rejects non-object JSON", () => {
    const result = parseCodexAuthJson('["array"]');

    expect(result.valid).toBe(false);
  });

  it("rejects auth.json with neither tokens.refresh_token nor OPENAI_API_KEY", () => {
    const result = parseCodexAuthJson(
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: "at" } }),
    );

    expect(result).toEqual({
      valid: false,
      reason: "auth.json must contain tokens.refresh_token or OPENAI_API_KEY.",
    });
  });

  it("accepts an API-key-only auth.json", () => {
    const result = parseCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: "sk-proj-123" }));

    expect(result).toEqual({ valid: true, metadata: {} });
  });

  it("extracts metadata from tokens.account_id and top-level fields", () => {
    const result = parseCodexAuthJson(
      JSON.stringify({
        tokens: { refresh_token: "rt", account_id: "acct_123" },
        auth_mode: "chatgpt",
        last_refresh: "2026-07-01T00:00:00Z",
        extra_field: { ignored: true },
      }),
    );

    expect(result).toEqual({
      valid: true,
      metadata: {
        accountId: "acct_123",
        authMode: "chatgpt",
        lastRefresh: "2026-07-01T00:00:00Z",
      },
    });
  });

  it("falls back to id_token claims for account id and email", () => {
    const idToken = makeIdToken({
      chatgpt_account_id: "acct_from_jwt",
      email: "user@example.com",
    });
    const result = parseCodexAuthJson(
      JSON.stringify({ tokens: { refresh_token: "rt", id_token: idToken } }),
    );

    expect(result).toEqual({
      valid: true,
      metadata: { accountId: "acct_from_jwt", email: "user@example.com" },
    });
  });

  it("reads the nested https://api.openai.com/auth claim", () => {
    const idToken = makeIdToken({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_nested" },
    });
    const result = parseCodexAuthJson(
      JSON.stringify({ tokens: { refresh_token: "rt", id_token: idToken } }),
    );

    expect(result).toEqual({ valid: true, metadata: { accountId: "acct_nested" } });
  });

  it("falls back to organizations[0].id", () => {
    const idToken = makeIdToken({ organizations: [{ id: "org_1" }, { id: "org_2" }] });
    const result = parseCodexAuthJson(
      JSON.stringify({ tokens: { refresh_token: "rt", id_token: idToken } }),
    );

    expect(result).toEqual({ valid: true, metadata: { accountId: "org_1" } });
  });

  it("prefers tokens.account_id over id_token claims", () => {
    const idToken = makeIdToken({ chatgpt_account_id: "acct_from_jwt" });
    const result = parseCodexAuthJson(
      JSON.stringify({
        tokens: { refresh_token: "rt", account_id: "acct_direct", id_token: idToken },
      }),
    );

    expect(result).toEqual({ valid: true, metadata: { accountId: "acct_direct" } });
  });

  it.each([
    ["no dots", "garbage"],
    ["non-base64 payload", "header.!!!not-base64!!!.sig"],
    ["non-JSON payload", `header.${Buffer.from("not json").toString("base64url")}.sig`],
    ["non-object payload", `header.${Buffer.from('"a string"').toString("base64url")}.sig`],
    ["empty payload segment", "header..sig"],
  ])("tolerates malformed id_token JWTs (%s)", (_label, idToken) => {
    const result = parseCodexAuthJson(
      JSON.stringify({ tokens: { refresh_token: "rt", id_token: idToken } }),
    );

    expect(result).toEqual({ valid: true, metadata: {} });
  });
});
