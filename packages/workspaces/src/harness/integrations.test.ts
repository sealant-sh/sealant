import { describe, expect, it } from "vitest";

import { getHarnessIntegration, isHarnessId, listHarnessIntegrations } from "./integrations.js";

describe("harness integrations", () => {
  it("returns install and launch details for known harness ids", () => {
    const opencode = getHarnessIntegration("opencode");
    const codex = getHarnessIntegration("codex");
    const claudeCode = getHarnessIntegration("claude-code");

    expect(opencode).toMatchObject({
      id: "opencode",
      installPackages: ["nodejs"],
      installCommand: "npm install -g opencode-ai@latest",
      launchCommand: "opencode",
    });
    expect(codex).toMatchObject({
      id: "codex",
      installPackages: ["nodejs"],
      installCommand: "npm install -g @openai/codex@latest",
      launchCommand: "codex",
    });
    expect(claudeCode).toMatchObject({
      id: "claude-code",
      installPackages: ["nodejs"],
      installCommand: "npm install -g @anthropic-ai/claude-code@latest",
      launchCommand: "claude",
    });
  });

  it("rejects unknown harness ids", () => {
    expect(isHarnessId("something-else")).toBe(false);
    expect(getHarnessIntegration("something-else")).toBeUndefined();
  });

  it("lists all registered harnesses", () => {
    const ids = listHarnessIntegrations()
      .map((integration) => integration.id)
      .toSorted();

    expect(ids).toEqual(["claude-code", "codex", "opencode"]);
  });
});
