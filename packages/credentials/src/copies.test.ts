import { describe, expect, it } from "vitest";

import {
  chatgptLoginEntry,
  claudeCredentialsCanRefresh,
  claudeCredentialsCopy,
  CODEX_COPY_REFRESH_TOKEN,
  codexAuthJsonCanRefresh,
  codexAuthJsonCopy,
  CredentialCopyError,
} from "./copies.js";

describe("claudeCredentialsCopy", () => {
  it("drops only the refresh token", () => {
    const stored = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-a",
        refreshToken: "sk-ant-ort01-r",
        expiresAt: 1790836883361,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    });
    const copy = claudeCredentialsCopy(stored);
    expect(JSON.parse(copy)).toEqual({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-a",
        expiresAt: 1790836883361,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    });
    expect(claudeCredentialsCanRefresh(stored)).toBe(true);
    expect(claudeCredentialsCanRefresh(copy)).toBe(false);
  });

  it("refuses a file with no grant rather than passing it through", () => {
    expect(() => claudeCredentialsCopy(JSON.stringify({ mcpOAuth: {} }))).toThrow(
      CredentialCopyError,
    );
    expect(() => claudeCredentialsCopy("not json")).toThrow(CredentialCopyError);
  });
});

describe("codexAuthJsonCopy", () => {
  it("replaces the refresh token with the placeholder and keeps everything else", () => {
    const stored = JSON.stringify({
      OPENAI_API_KEY: null,
      auth_mode: "chatgpt",
      last_refresh: "2026-10-01T00:00:00Z",
      tokens: { id_token: "id", access_token: "at", refresh_token: "rt", account_id: "acc" },
    });
    const copy = codexAuthJsonCopy(stored);
    expect(JSON.parse(copy)).toEqual({
      OPENAI_API_KEY: null,
      auth_mode: "chatgpt",
      last_refresh: "2026-10-01T00:00:00Z",
      tokens: {
        id_token: "id",
        access_token: "at",
        refresh_token: CODEX_COPY_REFRESH_TOKEN,
        account_id: "acc",
      },
    });
    expect(codexAuthJsonCanRefresh(stored)).toBe(true);
    expect(codexAuthJsonCanRefresh(copy)).toBe(false);
  });

  it("passes an API-key login through: it has nothing to refresh", () => {
    const apiKey = JSON.stringify({ OPENAI_API_KEY: "sk-x", tokens: null });
    expect(JSON.parse(codexAuthJsonCopy(apiKey))).toEqual({ OPENAI_API_KEY: "sk-x", tokens: null });
  });

  it("refuses malformed input", () => {
    expect(() => codexAuthJsonCopy("[]")).toThrow(CredentialCopyError);
    expect(() => codexAuthJsonCopy(JSON.stringify({ tokens: "x" }))).toThrow(CredentialCopyError);
  });
});

/** A token whose claims are readable, as a ChatGPT access token's are. */
const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("chatgptLoginEntry", () => {
  it("makes pi's and opencode's ChatGPT entry from a Codex login, unable to refresh", () => {
    const access = jwt({ exp: 1_900_000_000 });
    const entry = JSON.parse(
      chatgptLoginEntry(
        JSON.stringify({
          tokens: { access_token: access, refresh_token: "rt-real", account_id: "acc_1" },
        }),
      ),
    );
    expect(entry).toEqual({
      type: "oauth",
      access,
      refresh: CODEX_COPY_REFRESH_TOKEN,
      expires: 1_900_000_000_000,
      accountId: "acc_1",
    });
    expect(JSON.stringify(entry)).not.toContain("rt-real");
  });

  it("refuses an API-key login and a token with no expiry", () => {
    expect(() => chatgptLoginEntry(JSON.stringify({ OPENAI_API_KEY: "sk-x" }))).toThrow(
      CredentialCopyError,
    );
    expect(() =>
      chatgptLoginEntry(JSON.stringify({ tokens: { access_token: jwt({}), account_id: "acc_1" } })),
    ).toThrow(/expiry/);
    expect(() => chatgptLoginEntry(JSON.stringify({ tokens: { access_token: "opaque" } }))).toThrow(
      CredentialCopyError,
    );
  });
});
