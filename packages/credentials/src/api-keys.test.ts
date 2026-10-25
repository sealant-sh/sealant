import { describe, expect, it } from "vitest";

import { codexLoginFile } from "./copies.js";
import {
  codexAuthJsonLogin,
  connectedAccountKinds,
  credentialKindOf,
  loginClassOf,
  loginClassOfKind,
  parseApiKey,
  parseClaudeCredentialPayload,
  parseCodexCredentialPayload,
} from "./payloads.js";

const claudeKey = "sk-ant-api03-FAKEclaudekeyforthetests000000wxyz";
const codexKey = "sk-proj-FAKEcodexkeyforthetests0000wxyz";
const chatgptTokens = { access_token: "at-fake", refresh_token: "rt-fake", account_id: "acct" };

describe("parseApiKey", () => {
  it("takes a trimmed key of its provider's shape", () => {
    expect(parseApiKey("claude", `  ${claudeKey}\n`)).toEqual({ valid: true, apiKey: claudeKey });
    expect(parseApiKey("codex", codexKey)).toEqual({ valid: true, apiKey: codexKey });
    expect(parseApiKey("codex", "sk-FAKElegacyopenaikey000000000000")).toMatchObject({
      valid: true,
    });
  });

  it("refuses an Admin key, another provider's key, a broken or truncated one", () => {
    expect(parseApiKey("claude", "sk-ant-admin01-FAKEadminkeyforthetests0000000")).toEqual({
      valid: false,
      reason: "An Admin API key cannot run a model.",
    });
    expect(parseApiKey("codex", "sk-admin-FAKEadminkeyforthetests00000")).toMatchObject({
      reason: "An Admin API key cannot run a model.",
    });
    expect(parseApiKey("codex", claudeKey)).toMatchObject({ valid: false });
    expect(parseApiKey("claude", codexKey)).toMatchObject({ valid: false });
    expect(parseApiKey("claude", `${claudeKey.slice(0, 20)} ${claudeKey.slice(20)}`)).toMatchObject(
      { valid: false },
    );
    expect(parseApiKey("claude", "sk-ant-api03-short")).toMatchObject({ valid: false });
    expect(parseApiKey("codex", `sk-${"a".repeat(600)}`)).toMatchObject({ valid: false });
  });
});

describe("a stored Codex payload", () => {
  it("reads a key, and an auth.json that holds only a key, as the key", () => {
    expect(parseCodexCredentialPayload({ apiKey: codexKey })).toEqual({ apiKey: codexKey });
    for (const authJson of [
      { OPENAI_API_KEY: codexKey, tokens: null, last_refresh: null },
      { auth_mode: "apikey", OPENAI_API_KEY: codexKey },
      { OPENAI_API_KEY: codexKey, tokens: { access_token: "at-fake" } },
    ]) {
      expect(parseCodexCredentialPayload({ authJson: JSON.stringify(authJson) })).toEqual({
        apiKey: codexKey,
      });
    }
  });

  it("follows auth_mode first, and keeps an ambiguous or unreadable file as it is", () => {
    const both = (authMode: string | undefined) =>
      JSON.stringify({
        ...(authMode === undefined ? {} : { auth_mode: authMode }),
        OPENAI_API_KEY: codexKey,
        tokens: chatgptTokens,
      });
    expect(parseCodexCredentialPayload({ authJson: both("apikey") })).toEqual({
      apiKey: codexKey,
    });
    const chatgptMode = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: codexKey });
    for (const authJson of [both("chatgpt"), chatgptMode, both(undefined), "not json"]) {
      expect(parseCodexCredentialPayload({ authJson })).toEqual({ authJson });
    }
    expect(codexAuthJsonLogin(chatgptMode)).toEqual({ login: "subscription" });
    expect(codexAuthJsonLogin(both(undefined))).toMatchObject({
      login: "api-key",
      key: { valid: false, reason: expect.stringContaining("auth_mode") },
    });
  });

  it("takes a key in an auth.json only as a bare key would be taken", () => {
    const refused = [
      ["sk-admin-FAKEadminkeyforthetests00000", "An Admin API key cannot run a model."],
      [claudeKey, "That is an Anthropic key; connect it as a Claude account."],
      ["   ", 'A Codex API key starts with "sk-".'],
      ["sk-short", "That is not a whole Codex API key"],
      [`${codexKey.slice(0, 12)} ${codexKey.slice(12)}`, "no spaces or line breaks"],
    ] as const;
    for (const [key, reason] of refused) {
      for (const file of [{ OPENAI_API_KEY: key }, { auth_mode: "apikey", OPENAI_API_KEY: key }]) {
        const authJson = JSON.stringify(file);
        expect(codexAuthJsonLogin(authJson)).toEqual({
          login: "api-key",
          key: { valid: false, reason: expect.stringContaining(reason) },
        });
        expect(parseCodexCredentialPayload({ authJson })).toEqual({ authJson });
        expect(loginClassOf("codex", { authJson })).toBe("api-key");
      }
    }
    expect(codexAuthJsonLogin(JSON.stringify({ auth_mode: "apikey" }))).toMatchObject({
      login: "api-key",
      key: { valid: false },
    });
  });

  it("is written as Codex's own key file when it is a key", () => {
    expect(JSON.parse(codexLoginFile({ apiKey: codexKey }))).toEqual({
      auth_mode: "apikey",
      OPENAI_API_KEY: codexKey,
    });
  });
});

describe("kinds", () => {
  it("derives every kind from its payload, and the login class from the kind", () => {
    expect(credentialKindOf("claude", { apiKey: claudeKey })).toBe("api-key");
    expect(credentialKindOf("claude", { token: "sk-ant-oat01-fake" })).toBe("oauth-token");
    expect(credentialKindOf("claude", { credentialsJson: "{}" })).toBe("credentials-json");
    expect(credentialKindOf("codex", { apiKey: codexKey })).toBe("api-key");
    expect(credentialKindOf("codex", { authJson: "{}" })).toBe("auth-json");
    expect(credentialKindOf("github", { token: "gho_fake" })).toBe("gh-cli-token");
    expect(connectedAccountKinds.map(loginClassOfKind)).toEqual([
      "subscription",
      "subscription",
      "subscription",
      undefined,
      "api-key",
    ]);
    expect(loginClassOf("github", { token: "gho_fake" })).toBeUndefined();
    expect(loginClassOf("claude", { apiKey: claudeKey })).toBe("api-key");
    expect(loginClassOf("claude", { token: "sk-ant-oat01-fake" })).toBe("subscription");
    expect(loginClassOf("codex", { authJson: JSON.stringify({ tokens: chatgptTokens }) })).toBe(
      "subscription",
    );
  });

  it("decodes a stored Claude key", () => {
    expect(parseClaudeCredentialPayload({ apiKey: claudeKey })).toEqual({ apiKey: claudeKey });
    expect(() => parseClaudeCredentialPayload({ apiKey: codexKey })).toThrow();
  });
});
