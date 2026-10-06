import { describe, expect, it } from "vitest";

import { CODEX_COPY_REFRESH_TOKEN } from "./copies.js";
import {
  claudeCredentialsFile,
  CONNECTED_ACCOUNT_REF_PREFIX,
  createConnectedAccountRef,
  parseConnectedAccountRef,
  planCredentialInjections,
} from "./injection.js";

describe("planCredentialInjections", () => {
  it("plans a claude env injection", () => {
    expect(planCredentialInjections("claude", { token: "sk-ant-oat01-abc" }))
      .toMatchInlineSnapshot(`
        [
          {
            "key": "CLAUDE_CODE_OAUTH_TOKEN",
            "kind": "env",
            "value": "sk-ant-oat01-abc",
          },
        ]
      `);
  });

  it("plans a claude credentials.json file injection without the refresh token (a copy)", () => {
    const credentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-a",
        refreshToken: "sk-ant-ort01-r",
        expiresAt: 1,
      },
    });
    const plan = planCredentialInjections("claude", { credentialsJson });
    const fileInjection = plan[0];

    if (plan.length !== 1 || fileInjection === undefined || fileInjection.kind !== "file") {
      throw new Error("Expected one file injection.");
    }
    expect(fileInjection.path).toBe("$HOME/.claude/.credentials.json");
    expect(fileInjection.mode).toBe("600");
    expect(JSON.parse(Buffer.from(fileInjection.contentBase64, "base64").toString("utf8"))).toEqual(
      {
        claudeAiOauth: { accessToken: "sk-ant-oat01-a", expiresAt: 1 },
      },
    );
  });

  it("plans a codex auth.json file injection whose refresh token is the copy placeholder", () => {
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "at", refresh_token: "rt", account_id: "acc" },
    });
    const plan = planCredentialInjections("codex", { authJson });
    const fileInjection = plan[0];

    if (plan.length !== 1 || fileInjection === undefined || fileInjection.kind !== "file") {
      throw new Error("Expected one file injection.");
    }
    expect(fileInjection.path).toBe("$HOME/.codex/auth.json");
    expect(fileInjection.mode).toBe("600");
    expect(JSON.parse(Buffer.from(fileInjection.contentBase64, "base64").toString("utf8"))).toEqual(
      {
        auth_mode: "chatgpt",
        tokens: { access_token: "at", refresh_token: CODEX_COPY_REFRESH_TOKEN, account_id: "acc" },
      },
    );
  });

  it("plans github env injections for both GITHUB_TOKEN and GH_TOKEN", () => {
    expect(planCredentialInjections("github", { token: "gho_abc" })).toMatchInlineSnapshot(`
      [
        {
          "key": "GITHUB_TOKEN",
          "kind": "env",
          "value": "gho_abc",
        },
        {
          "key": "GH_TOKEN",
          "kind": "env",
          "value": "gho_abc",
        },
      ]
    `);
  });
});

describe("connected account refs", () => {
  it("round-trips ids through create/parse", () => {
    const ref = createConnectedAccountRef("cacc_123");

    expect(ref).toBe(`${CONNECTED_ACCOUNT_REF_PREFIX}cacc_123`);
    expect(parseConnectedAccountRef(ref)).toBe("cacc_123");
  });

  it("returns undefined for non-connected-account refs", () => {
    expect(parseConnectedAccountRef(undefined)).toBeUndefined();
    expect(parseConnectedAccountRef("github-installation-repository:123")).toBeUndefined();
    expect(parseConnectedAccountRef(CONNECTED_ACCOUNT_REF_PREFIX)).toBeUndefined();
  });
});

describe("claudeCredentialsFile", () => {
  it("writes a setup token as the file Claude Code builds from the variable", () => {
    expect(JSON.parse(claudeCredentialsFile({ token: "sk-ant-oat01-x" }))).toEqual({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-x",
        expiresAt: 9_999_999_999_999,
        scopes: ["user:inference"],
        subscriptionType: null,
      },
    });
  });

  it("writes a session file as the copy without its refresh token", () => {
    const file = claudeCredentialsFile({
      credentialsJson: JSON.stringify({
        claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 1 },
      }),
    });
    expect(file).toContain("at");
    expect(file).not.toContain("rt");
  });
});
