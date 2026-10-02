import { describe, expect, it } from "vitest";

import {
  getHarnessIntegration,
  isBakedHarnessId,
  isHarnessId,
  listHarnessIntegrations,
} from "./integrations.js";

describe("harness integrations", () => {
  it("returns install and launch details for known harness ids", () => {
    const opencode = getHarnessIntegration("opencode");
    const codex = getHarnessIntegration("codex");
    const claudeCode = getHarnessIntegration("claude-code");

    expect(opencode).toMatchObject({
      id: "opencode",
      installPackages: ["nodejs"],
      installCommand: "npm install -g --allow-scripts=opencode-ai opencode-ai@latest",
      launchCommand: "opencode",
    });
    expect(codex).toMatchObject({
      id: "codex",
      // bubblewrap rides with the CLI: Codex's sandbox prerequisite, on every family.
      installPackages: ["nodejs", "bubblewrap"],
      installCommand: "npm install -g @openai/codex@latest",
      launchCommand: "codex",
    });
    expect(claudeCode).toMatchObject({
      id: "claude-code",
      installPackages: ["nodejs"],
      installCommand:
        "npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest",
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

    expect(ids).toEqual(["claude-code", "codex", "opencode", "pi"]);
  });

  it("bakes every harness into one image, and installs pi from its checked release binary", () => {
    expect(isBakedHarnessId("opencode")).toBe(true);
    expect(isBakedHarnessId("pi")).toBe(true);
    const pi = getHarnessIntegration("pi");
    expect(pi?.installPackages).toEqual(["curl", "tar", "ca-certificates"]);
    // No node: the binary, verified against the release's SHA256SUMS before it is unpacked.
    expect(pi?.installCommand).toContain("pi-linux-$arch.tar.gz");
    expect(pi?.installCommand).toContain("sha256sum -c -");
    expect(pi?.installCommand).not.toContain("npm");
    expect(pi?.buildRunCommand("hello")).toEqual({ executable: "pi", args: ["-p", "hello"] });
  });
});
