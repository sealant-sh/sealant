import { describe, expect, it } from "vitest";

import { normalizeUserWorkspaceSpec } from "@zweit/workspace-composition";

import { getNixExecutorSupport, mapBlueprintToNixExecutorSpec } from "./map-blueprint-to-nix-executor-spec.js";

describe("getNixExecutorSupport", () => {
  it("supports the minimal nix path", () => {
    const blueprint = normalizeUserWorkspaceSpec({
      source: "https://github.com/example/project.git",
      harness: "opencode",
      packages: ["nodejs", "pnpm", "ripgrep"],
      env: {
        NODE_ENV: "development",
      },
      os: "nix",
    });

    expect(getNixExecutorSupport(blueprint)).toEqual({ supported: true });
  });

  it("rejects unsupported target OS families", () => {
    const blueprint = normalizeUserWorkspaceSpec({
      source: "https://github.com/example/project.git",
      harness: "opencode",
      os: {
        family: "fedora",
        mode: "require",
      },
    });

    expect(getNixExecutorSupport(blueprint)).toEqual({
      supported: false,
      reason: "unsupported-os",
      message: "The Nix executor only supports target.os.family of auto or nix, received fedora.",
    });
  });

  it("rejects blueprint features the minimal wrapper cannot honor yet", () => {
    const blueprint = normalizeUserWorkspaceSpec({
      source: "https://github.com/example/project.git",
      harness: "opencode",
      setup: ["pnpm install"],
    });

    expect(getNixExecutorSupport(blueprint)).toEqual({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The minimal Nix executor path does not support lifecycle.setup yet.",
    });
  });
});

describe("mapBlueprintToNixExecutorSpec", () => {
  it("maps a normalized blueprint into the current Nix executor spec", () => {
    const blueprint = normalizeUserWorkspaceSpec({
      source: "https://github.com/example/project.git",
      harness: "opencode",
      packages: ["nodejs", "pnpm"],
      startup: "pnpm dev",
      env: {
        NODE_ENV: "development",
      },
      os: "nix",
    });

    expect(mapBlueprintToNixExecutorSpec(blueprint)).toEqual({
      harness: "opencode",
      imageName: "zweit-workspace-opencode",
      repoUrl: "https://github.com/example/project.git",
      repoRef: "main",
      extraPackages: ["nodejs", "pnpm"],
      env: {
        NODE_ENV: "development",
        ZWEIT_FOREGROUND_COMMAND: "pnpm dev",
      },
    });
  });
});
