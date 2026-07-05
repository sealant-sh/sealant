import { describe, expect, it } from "vitest";

import { mapSandboxCredentials } from "./credentials.js";

describe("mapSandboxCredentials", () => {
  it("is undefined when no credentials were requested", () => {
    expect(mapSandboxCredentials(undefined)).toBeUndefined();
  });

  it("maps `true` to the default account name for each provider", () => {
    expect(mapSandboxCredentials({ claude: true, codex: true, github: true })).toEqual({
      claude: "default",
      codex: "default",
      github: "default",
    });
  });

  it("passes named accounts through as-is", () => {
    expect(mapSandboxCredentials({ claude: "work", codex: "personal", github: "bot" })).toEqual({
      claude: "work",
      codex: "personal",
      github: "bot",
    });
  });

  it("maps `profile` to `profileId`", () => {
    expect(mapSandboxCredentials({ profile: "prof_123" })).toEqual({ profileId: "prof_123" });
  });

  it("omits fields that were not requested", () => {
    expect(mapSandboxCredentials({ claude: true })).toEqual({ claude: "default" });
  });

  it("treats an explicit `false` as omitted", () => {
    expect(mapSandboxCredentials({ claude: false, codex: "personal" })).toEqual({
      codex: "personal",
    });
  });

  it("combines profile and explicit provider overrides", () => {
    expect(mapSandboxCredentials({ profile: "prof_123", claude: "work" })).toEqual({
      profileId: "prof_123",
      claude: "work",
    });
  });
});
