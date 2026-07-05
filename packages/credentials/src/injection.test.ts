import { describe, expect, it } from "vitest";

import {
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

  it("plans a codex auth.json file injection with base64 content and mode 600", () => {
    const authJson = JSON.stringify({ tokens: { refresh_token: "rt" } });
    const plan = planCredentialInjections("codex", { authJson });

    expect(plan).toMatchInlineSnapshot(`
      [
        {
          "contentBase64": "eyJ0b2tlbnMiOnsicmVmcmVzaF90b2tlbiI6InJ0In19",
          "kind": "file",
          "mode": "600",
          "path": "$HOME/.codex/auth.json",
        },
      ]
    `);

    const fileInjection = plan[0];

    if (fileInjection === undefined || fileInjection.kind !== "file") {
      throw new Error("Expected a file injection.");
    }

    expect(Buffer.from(fileInjection.contentBase64, "base64").toString("utf8")).toBe(authJson);
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
