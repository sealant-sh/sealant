import { describe, expect, it } from "vitest";

import { parseBuildkitOsExecutorCompileResult, parseResolvedImagePlan } from "./buildkit.js";

describe("parseResolvedImagePlan", () => {
  it("accepts a resolved image plan for a BuildKit-backed distro", () => {
    const plan = parseResolvedImagePlan({
      blueprint: {
        version: "1",
        sources: {
          workspace: {
            url: "https://github.com/example/project.git",
          },
        },
        harness: {
          id: "opencode",
        },
      },
      osFamily: "fedora",
      baseImage: "fedora:41",
      packageManager: "dnf",
      packages: [
        {
          requestId: "pnpm",
          installPackages: ["nodejs", "pnpm"],
        },
      ],
      customization: {
        defaultShell: "zsh",
        dotfilesManager: "chezmoi",
        applyDotfiles: true,
      },
      dotfiles: {
        sourceId: "dotfiles-1",
        manager: "chezmoi",
        url: "https://github.com/example/dotfiles.git",
        ref: "main",
        authSecretId: "dotfiles_git_key",
      },
      buildSecrets: [
        {
          id: "dotfiles_git_key",
          kind: "ssh-key",
          phase: "build",
          sourceRef: "secret://git/dotfiles-key",
        },
      ],
      runtimeSecrets: [
        {
          id: "workspace_git_key",
          kind: "ssh-key",
          phase: "runtime",
          sourceRef: "secret://git/workspace-key",
        },
      ],
      imageEnv: {},
      runtimeEnv: {
        NODE_ENV: "development",
      },
    });

    expect(plan.packageManager).toBe("dnf");
    expect(plan.customization.defaultShell).toBe("zsh");
    expect(plan.runtimeSecrets[0]?.phase).toBe("runtime");
  });

  it("accepts a resolved image plan for nix buildkit targets", () => {
    const plan = parseResolvedImagePlan({
      blueprint: {
        version: "1",
        sources: {
          workspace: {
            url: "https://github.com/example/project.git",
          },
        },
        harness: {
          id: "opencode",
        },
      },
      osFamily: "nix",
      baseImage: "nixos/nix:latest",
      packageManager: "nix",
      packages: [
        {
          requestId: "ripgrep",
          installPackages: ["ripgrep"],
        },
      ],
      customization: {
        defaultShell: "bash",
        applyDotfiles: true,
      },
      buildSecrets: [],
      runtimeSecrets: [],
      imageEnv: {},
      runtimeEnv: {},
    });

    expect(plan.osFamily).toBe("nix");
    expect(plan.packageManager).toBe("nix");
  });
});

describe("parseBuildkitOsExecutorCompileResult", () => {
  it("accepts a compile result with an embedded BuildKit spec", () => {
    const result = parseBuildkitOsExecutorCompileResult({
      executor: {
        id: "fedora",
        osFamily: "fedora",
      },
      artifacts: [
        {
          kind: "oci-image",
          name: "workspace-image",
          reference: "127.0.0.1:5000/sealant/workspace:fedora",
          loader: "registry",
        },
      ],
      buildkit: {
        imagePlan: {
          blueprint: {
            version: "1",
            sources: {
              workspace: {
                url: "https://github.com/example/project.git",
              },
            },
            harness: {
              id: "opencode",
            },
          },
          osFamily: "fedora",
          baseImage: "fedora:41",
          packageManager: "dnf",
          packages: [],
          customization: {
            defaultShell: "bash",
            applyDotfiles: true,
          },
          buildSecrets: [],
          runtimeSecrets: [],
          imageEnv: {},
          runtimeEnv: {},
        },
        spec: {
          contextDirectory: "/tmp/sealant-build/sbx-123",
          containerfilePath: "/tmp/sealant-build/sbx-123/Containerfile",
          imageReference: "127.0.0.1:5000/sealant/workspace:fedora",
          push: true,
          secrets: [
            {
              id: "dotfiles_git_key",
              sourceRef: "secret://git/dotfiles-key",
            },
          ],
          buildArgs: {},
        },
      },
    });

    expect(result.buildkit.spec.push).toBe(true);
    expect(result.buildkit.imagePlan.osFamily).toBe("fedora");
  });
});
