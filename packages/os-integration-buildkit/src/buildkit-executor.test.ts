import { readFile } from "node:fs/promises";

import { normalizeUserWorkspaceSpec } from "@sealant/workspace-composition";
import { describe, expect, it, vi } from "vitest";

import { BuildkitDistroOsExecutor, mapBlueprintToBuildkitImagePlan } from "./buildkit-executor.js";

describe("BuildkitDistroOsExecutor", () => {
  it("maps a blueprint into a resolved BuildKit image plan", () => {
    const blueprint = normalizeUserWorkspaceSpec({
      source: {
        url: "https://github.com/example/repo.git",
        authRef: "/workspace/.secrets/workspace_repo_key",
      },
      inputs: [
        {
          purpose: "dotfiles",
          url: "https://github.com/example/dotfiles.git",
          authRef: "/workspace/.secrets/dotfiles_key",
        },
      ],
      harness: "opencode",
      packages: ["nodejs", "pnpm", "tmux"],
      customization: {
        defaultShell: "zsh",
        dotfilesManager: "chezmoi",
      },
      os: "fedora",
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "fedora");

    expect(plan.osFamily).toBe("fedora");
    expect(plan.packageManager).toBe("dnf");
    expect(plan.runtimeSecrets).toEqual([
      {
        id: "workspace_git_key",
        kind: "ssh-key",
        phase: "runtime",
        sourceRef: "/workspace/.secrets/workspace_repo_key",
      },
    ]);
    expect(plan.dotfiles).toMatchObject({
      manager: "chezmoi",
      authSecretId: "dotfiles_git_key",
    });
  });

  it("renders a build context and invokes docker build plus docker save", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const executor = new BuildkitDistroOsExecutor({
      osFamily: "fedora",
      commandRunner,
    });

    const result = await executor.compile({
      blueprint: normalizeUserWorkspaceSpec({
        source: "https://github.com/example/repo.git",
        harness: "opencode",
        packages: ["git", "ripgrep"],
        startup: "pnpm dev",
        os: "fedora",
      }),
    });

    const buildCommandArgs = (commandRunner.mock.calls[0]?.[1] ?? []) as string[];
    const saveCommandArgs = (commandRunner.mock.calls[1]?.[1] ?? []) as string[];
    expect(commandRunner).toHaveBeenCalledTimes(2);
    expect(buildCommandArgs.slice(0, 4)).toEqual(["build", "--file", expect.any(String), "--tag"]);
    expect(saveCommandArgs.slice(0, 2)).toEqual(["save", "--output"]);
    expect(saveCommandArgs[2]).toMatch(/workspace-image\.tar$/);
    expect(result.executor).toEqual({
      id: "fedora",
      osFamily: "fedora",
    });
    expect(result.buildkit.imagePlan.packageManager).toBe("dnf");

    const containerfilePath = result.buildkit.spec.containerfilePath;
    const entrypointPath = containerfilePath.replace(/Containerfile$/, "entrypoint.sh");
    const containerfile = await readFile(containerfilePath, "utf8");
    const entrypoint = await readFile(entrypointPath, "utf8");

    expect(containerfile).toContain("FROM fedora:41");
    expect(containerfile).toContain('ENTRYPOINT ["/usr/local/bin/workspace-entrypoint"]');
    expect(entrypoint).toContain('git clone --branch "$WORKSPACE_REPO_REF"');
    expect(entrypoint).toContain("exec /bin/bash -lc 'pnpm dev'");
  });

  it("supports distro package passthrough for unmapped package ids", () => {
    const blueprint = normalizeUserWorkspaceSpec({
      source: "https://github.com/example/repo.git",
      harness: "opencode",
      packages: ["htop"],
      os: "arch",
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "arch");

    expect(plan.packages).toEqual([
      {
        requestId: "htop",
        installPackages: ["htop"],
      },
    ]);
  });
});
