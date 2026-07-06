import { describe, expect, it } from "vitest";

import { mapWorkspaceCredentials } from "./credentials.js";

describe("mapWorkspaceCredentials", () => {
  it("is undefined when no credentials were requested", () => {
    expect(mapWorkspaceCredentials(undefined)).toBeUndefined();
  });

  it("maps `true` to the default account name for each provider", () => {
    expect(mapWorkspaceCredentials({ claude: true, codex: true, github: true })).toEqual({
      claude: "default",
      codex: "default",
      github: "default",
    });
  });

  it("passes named accounts through as-is", () => {
    expect(mapWorkspaceCredentials({ claude: "work", codex: "personal", github: "bot" })).toEqual({
      claude: "work",
      codex: "personal",
      github: "bot",
    });
  });

  it("maps `profile` to `profileId`", () => {
    expect(mapWorkspaceCredentials({ profile: "prof_123" })).toEqual({ profileId: "prof_123" });
  });

  it("omits fields that were not requested", () => {
    expect(mapWorkspaceCredentials({ claude: true })).toEqual({ claude: "default" });
  });

  it("treats an explicit `false` as omitted", () => {
    expect(mapWorkspaceCredentials({ claude: false, codex: "personal" })).toEqual({
      codex: "personal",
    });
  });

  it("combines profile and explicit provider overrides", () => {
    expect(mapWorkspaceCredentials({ profile: "prof_123", claude: "work" })).toEqual({
      profileId: "prof_123",
      claude: "work",
    });
  });
});
