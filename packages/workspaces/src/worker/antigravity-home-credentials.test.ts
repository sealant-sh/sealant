import { describe, expect, it } from "vitest";

import {
  HOME_CREDENTIAL_FILES,
  HOME_SCRIPT_EXIT,
  buildHomeCredentialScript,
  homeCredentialProviderOf,
  homeLoginOfRefusal,
  homeScriptRefusal,
} from "../runtime/home-credentials.js";

describe("antigravity home credentials", () => {
  it("registers the antigravity token path as a whole-file home credential provider", () => {
    expect(HOME_CREDENTIAL_FILES.antigravity).toBe(
      ".gemini/antigravity-cli/antigravity-oauth-token",
    );
    expect(homeCredentialProviderOf(HOME_CREDENTIAL_FILES.antigravity)).toBe("antigravity");
    expect(homeLoginOfRefusal(HOME_SCRIPT_EXIT.antigravityLoginUnusable)).toBe("antigravity");
    expect(homeScriptRefusal("/home/alice", HOME_SCRIPT_EXIT.antigravityLoginUnusable)).toContain(
      "/home/alice/.gemini/antigravity-cli/antigravity-oauth-token",
    );

    const script = buildHomeCredentialScript({
      home: "/home/alice",
      fence: { kind: "take", generation: "gen_12345678" },
      token: "1",
      writes: ["antigravity"],
      removes: [],
    });
    expect(script).toContain(".gemini/antigravity-cli/antigravity-oauth-token");
    expect(script).toContain(`refuse ${HOME_SCRIPT_EXIT.antigravityLoginUnusable}`);
  });
});
