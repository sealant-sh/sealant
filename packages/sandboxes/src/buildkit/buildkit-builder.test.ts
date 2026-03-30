import { readFile } from "node:fs/promises";

import type { NewSandbox } from "@sealant/validators";
import { describe, expect, it, vi } from "vitest";

import {
  compileSandboxBuildSpec,
  mapBlueprintToBuildkitImagePlan,
  selectBuildkitOsFamily,
} from "./buildkit-builder.js";

const createSandboxBuildSpec = (overrides: Partial<NewSandbox> = {}): NewSandbox => {
  const base: NewSandbox = {
    version: "1",
    sources: {
      sandbox: {
        kind: "git",
        provider: "generic",
        url: "https://github.com/example/repo.git",
        ref: "main",
      },
      inputs: [],
    },
    harness: {
      id: "opencode",
    },
    access: {
      ssh: {
        enabled: false,
        listenPort: 2222,
      },
    },
    tooling: {
      packages: [],
    },
    customization: {
      defaultShell: "bash",
      dotfilesManager: "auto",
      dotfilesTarget: "home",
      applyDotfiles: true,
      dotfilesBootstrap: true,
    },
    lifecycle: {
      setup: [],
      startup: {
        steps: [],
        foreground: {
          kind: "harness",
        },
      },
    },
    runtime: {
      env: {},
      sandboxRoot: "/sandbox",
      workingDirectory: "/sandbox/repo",
      persistence: "ephemeral",
      ociRuntime: "runc",
      network: {
        outbound: true,
      },
    },
    target: {
      os: {
        family: "fedora",
        mode: "prefer",
      },
      runtime: {
        family: "auto",
        mode: "prefer",
      },
    },
  };

  return {
    ...base,
    ...overrides,
    sources: {
      ...base.sources,
      ...overrides.sources,
      sandbox: {
        ...base.sources.sandbox,
        ...overrides.sources?.sandbox,
      },
      inputs: overrides.sources?.inputs ?? base.sources.inputs,
    },
    harness: {
      ...base.harness,
      ...overrides.harness,
    },
    access: {
      ...base.access,
      ...overrides.access,
      ssh: {
        ...base.access.ssh,
        ...overrides.access?.ssh,
      },
    },
    tooling: {
      ...base.tooling,
      ...overrides.tooling,
      packages: overrides.tooling?.packages ?? base.tooling.packages,
    },
    customization: {
      ...base.customization,
      ...overrides.customization,
    },
    lifecycle: {
      ...base.lifecycle,
      ...overrides.lifecycle,
      setup: overrides.lifecycle?.setup ?? base.lifecycle.setup,
      startup: {
        ...base.lifecycle.startup,
        ...overrides.lifecycle?.startup,
        steps: overrides.lifecycle?.startup?.steps ?? base.lifecycle.startup.steps,
        foreground: overrides.lifecycle?.startup?.foreground ?? base.lifecycle.startup.foreground,
      },
    },
    runtime: {
      ...base.runtime,
      ...overrides.runtime,
      env: {
        ...base.runtime.env,
        ...overrides.runtime?.env,
      },
      network: {
        ...base.runtime.network,
        ...overrides.runtime?.network,
      },
    },
    target: {
      ...base.target,
      ...overrides.target,
      os: {
        ...base.target.os,
        ...overrides.target?.os,
      },
      runtime: {
        ...base.target.runtime,
        ...overrides.target?.runtime,
      },
    },
  };
};

describe("compileSandboxBuildSpec", () => {
  it("maps a blueprint into a resolved BuildKit image plan", () => {
    const blueprint = createSandboxBuildSpec({
      sources: {
        sandbox: {
          kind: "git",
          provider: "generic",
          url: "https://github.com/example/repo.git",
          ref: "main",
          authRef: "/sandbox/.secrets/sandbox_repo_key",
        },
        inputs: [
          {
            id: "dotfiles",
            kind: "git",
            purpose: "dotfiles",
            provider: "generic",
            url: "https://github.com/example/dotfiles.git",
            ref: "main",
            authRef: "/sandbox/.secrets/dotfiles_key",
          },
        ],
      },
      tooling: {
        packages: [{ id: "nodejs" }, { id: "pnpm" }, { id: "tmux" }],
      },
      customization: {
        defaultShell: "zsh",
        dotfilesManager: "chezmoi",
        dotfilesTarget: "home",
        applyDotfiles: true,
        dotfilesBootstrap: true,
      },
      target: {
        os: {
          family: "fedora",
          mode: "prefer",
        },
        runtime: {
          family: "auto",
          mode: "prefer",
        },
      },
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "fedora");

    expect(plan.osFamily).toBe("fedora");
    expect(plan.packageManager).toBe("dnf");
    expect(plan.runtimeSecrets).toEqual([
      {
        id: "sandbox_git_key",
        kind: "ssh-key",
        phase: "runtime",
        sourceRef: "/sandbox/.secrets/sandbox_repo_key",
      },
    ]);
    expect(plan.dotfiles).toMatchObject({
      manager: "chezmoi",
      applyAt: "build",
      authSecretId: "dotfiles_git_key",
    });
  });

  it("defers GitHub-authenticated dotfiles to runtime apply", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const blueprint = createSandboxBuildSpec({
      sources: {
        sandbox: {
          kind: "git",
          provider: "generic",
          url: "https://github.com/example/repo.git",
          ref: "main",
        },
        inputs: [
          {
            id: "dotfiles",
            kind: "git",
            purpose: "dotfiles",
            provider: "github",
            url: "https://github.com/example/dotfiles.git",
            ref: "main",
            authRef: "github-installation-repository:gh_installation_repo_1",
          },
        ],
      },
      target: {
        os: {
          family: "fedora",
          mode: "prefer",
        },
        runtime: {
          family: "auto",
          mode: "prefer",
        },
      },
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "fedora");
    expect(plan.dotfiles).toMatchObject({
      applyAt: "runtime",
      githubInstallationRepositoryId: "gh_installation_repo_1",
    });
    expect(plan.buildSecrets).toEqual([]);

    const result = await compileSandboxBuildSpec({
      blueprint,
      options: {
        commandRunner,
      },
    });
    const entrypointPath = result.buildkit.spec.containerfilePath.replace(
      /Containerfile$/,
      "entrypoint.sh",
    );
    const entrypoint = await readFile(entrypointPath, "utf8");

    expect(entrypoint).toContain("SEALANT_DOTFILES_HTTP_TOKEN");
    expect(entrypoint).toContain("DOTFILES_GITHUB_INSTALLATION_REPOSITORY_ID");
    expect(entrypoint).toContain('DOTFILES_SOURCE_DIR="/root/.local/share/chezmoi"');
    expect(entrypoint).toContain('HOME=/root chezmoi init --source="$DOTFILES_SOURCE_DIR"');
    expect(entrypoint).toContain('case "$DOTFILES_MANAGER" in');
  });

  it("installs stow when the dotfiles manager is stow", () => {
    const blueprint = createSandboxBuildSpec({
      sources: {
        sandbox: {
          kind: "git",
          provider: "generic",
          url: "https://github.com/example/repo.git",
          ref: "main",
        },
        inputs: [
          {
            id: "dotfiles",
            kind: "git",
            purpose: "dotfiles",
            provider: "generic",
            url: "https://github.com/example/dotfiles.git",
            ref: "main",
          },
        ],
      },
      customization: {
        defaultShell: "bash",
        dotfilesManager: "stow",
        dotfilesTarget: "home",
        applyDotfiles: true,
        dotfilesBootstrap: true,
      },
      target: {
        os: {
          family: "fedora",
          mode: "prefer",
        },
        runtime: {
          family: "auto",
          mode: "prefer",
        },
      },
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "fedora");
    expect(plan.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installPackages: expect.arrayContaining(["stow"]),
        }),
      ]),
    );
  });

  it("includes npm when Node.js-backed harness tooling is requested on Linux distros", () => {
    const fedoraPlan = mapBlueprintToBuildkitImagePlan(
      createSandboxBuildSpec({
        harness: {
          id: "opencode",
        },
        target: {
          os: {
            family: "fedora",
            mode: "prefer",
          },
          runtime: {
            family: "auto",
            mode: "prefer",
          },
        },
      }),
      "fedora",
    );
    const archPlan = mapBlueprintToBuildkitImagePlan(
      createSandboxBuildSpec({
        harness: {
          id: "codex",
        },
        target: {
          os: {
            family: "arch",
            mode: "prefer",
          },
          runtime: {
            family: "auto",
            mode: "prefer",
          },
        },
      }),
      "arch",
    );

    expect(fedoraPlan.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "nodejs",
          installPackages: ["nodejs", "npm"],
        }),
      ]),
    );
    expect(archPlan.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "nodejs",
          installPackages: ["nodejs", "npm"],
        }),
      ]),
    );
  });

  it("prefers fedora when target.os.family is auto", () => {
    const osFamily = selectBuildkitOsFamily({
      blueprint: createSandboxBuildSpec({
        target: {
          os: {
            family: "auto",
            mode: "prefer",
          },
          runtime: {
            family: "auto",
            mode: "prefer",
          },
        },
      }),
    });

    expect(osFamily).toBe("fedora");
  });

  it("renders a build context and invokes docker build plus docker save", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const result = await compileSandboxBuildSpec({
      blueprint: createSandboxBuildSpec({
        tooling: {
          packages: [{ id: "git" }, { id: "ripgrep" }],
        },
        lifecycle: {
          setup: [],
          startup: {
            steps: [],
            foreground: {
              kind: "command",
              run: "pnpm dev",
              shell: "bash",
            },
          },
        },
        target: {
          os: {
            family: "fedora",
            mode: "prefer",
          },
          runtime: {
            family: "auto",
            mode: "prefer",
          },
        },
      }),
      options: {
        commandRunner,
      },
    });

    const buildCommandArgs = (commandRunner.mock.calls[0]?.[1] ?? []) as string[];
    const saveCommandArgs = (commandRunner.mock.calls[1]?.[1] ?? []) as string[];
    expect(commandRunner).toHaveBeenCalledTimes(2);
    expect(buildCommandArgs.slice(0, 4)).toEqual(["build", "--file", expect.any(String), "--tag"]);
    expect(saveCommandArgs.slice(0, 2)).toEqual(["save", "--output"]);
    expect(saveCommandArgs[2]).toMatch(/sandbox-image\.tar$/);
    expect(result.builder).toEqual({
      id: "fedora",
      osFamily: "fedora",
    });
    expect(result.buildkit.imagePlan.packageManager).toBe("dnf");

    const containerfilePath = result.buildkit.spec.containerfilePath;
    const entrypointPath = containerfilePath.replace(/Containerfile$/, "entrypoint.sh");
    const containerfile = await readFile(containerfilePath, "utf8");
    const entrypoint = await readFile(entrypointPath, "utf8");

    expect(containerfile).toContain("FROM fedora:41");
    expect(containerfile).toContain("RUN npm install -g opencode-ai@latest");
    expect(containerfile).toContain('ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]');
    expect(entrypoint).toContain('mkdir -p "$SANDBOX_ROOT" "$WORKING_DIRECTORY"');
    expect(entrypoint).toContain("cat > /usr/local/bin/sandbox-ssh-shell <<'EOF'");
    expect(entrypoint).toContain("ForceCommand /usr/local/bin/sandbox-ssh-shell");
    expect(entrypoint).toContain("BASH_SHELL='/bin/bash'");
    expect(entrypoint).toContain('if [ "${SEALANT_OCI_RUNTIME:-runc}" = "runsc" ]; then');
    expect(entrypoint).toContain('exec "$BASH_SHELL" -i');
    expect(entrypoint).toContain('exec "$LOGIN_SHELL" -i');
    expect(entrypoint).toContain("cat > \"$REPO_GIT_ASKPASS_PATH\" <<'EOF'");
    expect(entrypoint).toContain('export GIT_ASKPASS="$REPO_GIT_ASKPASS_PATH"');
    expect(entrypoint).toContain("cleanup_sandbox_clone_auth");
    expect(entrypoint).toContain('git clone --branch "$SANDBOX_REPO_REF"');
    expect(entrypoint).toContain("exec /bin/bash -lc 'pnpm dev'");
  });

  it("starts the selected harness when startup foreground is harness", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const result = await compileSandboxBuildSpec({
      blueprint: createSandboxBuildSpec({
        harness: {
          id: "codex",
        },
        customization: {
          defaultShell: "zsh",
          dotfilesManager: "auto",
          dotfilesTarget: "home",
          applyDotfiles: true,
          dotfilesBootstrap: true,
        },
        target: {
          os: {
            family: "arch",
            mode: "prefer",
          },
          runtime: {
            family: "auto",
            mode: "prefer",
          },
        },
      }),
      options: {
        commandRunner,
      },
    });

    const containerfilePath = result.buildkit.spec.containerfilePath;
    const entrypointPath = containerfilePath.replace(/Containerfile$/, "entrypoint.sh");
    const containerfile = await readFile(containerfilePath, "utf8");
    const entrypoint = await readFile(entrypointPath, "utf8");
    const buildCommandArgs = (commandRunner.mock.calls[0]?.[1] ?? []) as string[];

    expect(containerfile).toContain("RUN npm install -g @openai/codex@latest");
    expect(entrypoint).toContain("exec /usr/bin/zsh -lc 'codex'");
    expect(buildCommandArgs).toContain("--platform");
    expect(buildCommandArgs).toContain("linux/amd64");
  });

  it("renders nix build contexts with nix package installs", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const result = await compileSandboxBuildSpec({
      blueprint: createSandboxBuildSpec({
        harness: {
          id: "codex",
        },
        customization: {
          defaultShell: "zsh",
          dotfilesManager: "auto",
          dotfilesTarget: "home",
          applyDotfiles: true,
          dotfilesBootstrap: true,
        },
        target: {
          os: {
            family: "nix",
            mode: "prefer",
          },
          runtime: {
            family: "auto",
            mode: "prefer",
          },
        },
      }),
      options: {
        commandRunner,
      },
    });

    const containerfilePath = result.buildkit.spec.containerfilePath;
    const entrypointPath = containerfilePath.replace(/Containerfile$/, "entrypoint.sh");
    const containerfile = await readFile(containerfilePath, "utf8");
    const entrypoint = await readFile(entrypointPath, "utf8");

    expect(result.builder).toEqual({
      id: "nix",
      osFamily: "nix",
    });
    expect(result.buildkit.imagePlan.packageManager).toBe("nix");
    expect(containerfile).toContain("FROM nixos/nix:latest");
    expect(containerfile).toContain("nix profile add --priority 6 --accept-flake-config");
    expect(containerfile).toContain(
      "nix --extra-experimental-features 'nix-command flakes' profile list > /dev/null",
    );
    expect(containerfile).toContain("nixpkgs#openssh");
    expect(containerfile).toContain("nixpkgs#gitMinimal");
    expect(containerfile).not.toContain("nixpkgs#git'");
    expect(containerfile).toContain("RUN npm install -g --prefix /usr/local @openai/codex@latest");
    expect(containerfile).toContain("ENV SHELL='/root/.nix-profile/bin/zsh'");
    expect(containerfile).not.toContain("RUN usermod -s");
    expect(entrypoint.startsWith("#!/root/.nix-profile/bin/bash")).toBe(true);
    expect(entrypoint).toContain('export PATH="/usr/local/bin:$PATH"');
    expect(entrypoint).toContain("if [ ! -e /lib64/ld-linux-x86-64.so.2 ]; then");
    expect(entrypoint).toContain('ln -sf "$GLIBC_LOADER" /lib64/ld-linux-x86-64.so.2');
    expect(entrypoint).toContain(
      'export PATH="/usr/local/bin:/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin:$PATH"',
    );
    expect(entrypoint).toContain(
      "if [ ! -w /etc/passwd ] || [ ! -w /etc/group ] || [ ! -w /etc/shadow ]; then",
    );
    expect(entrypoint).toContain("SHADOW_UPDATED=0");
    expect(entrypoint).toContain(': > "$SSH_RUNTIME_DIR/shadow.updated"');
    expect(entrypoint).toContain('printf "root::%s\\n" "${line#root:!:}"');
    expect(entrypoint).toContain("if ! id -u sshd >/dev/null 2>&1; then");
    expect(entrypoint).toContain("sshd:x:74:74:Privilege-separated SSH:/var/empty:/bin/sh");
    expect(entrypoint).toContain("/root/.nix-profile/bin/sshd -f");
    expect(entrypoint).toContain("BASH_SHELL='/root/.nix-profile/bin/bash'");
    expect(entrypoint).toContain('if [ "${SEALANT_OCI_RUNTIME:-runc}" = "runsc" ]; then');
    expect(entrypoint).toContain('exec "$BASH_SHELL" -i');
    expect(entrypoint).toContain("exec /root/.nix-profile/bin/zsh -lc 'codex'");
  });

  it("supports distro package passthrough for unmapped package ids", () => {
    const blueprint = createSandboxBuildSpec({
      tooling: {
        packages: [{ id: "htop" }],
      },
      target: {
        os: {
          family: "arch",
          mode: "prefer",
        },
        runtime: {
          family: "auto",
          mode: "prefer",
        },
      },
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "arch");

    expect(plan.packages).toEqual(
      expect.arrayContaining([
        {
          requestId: "htop",
          installPackages: ["htop"],
        },
        {
          requestId: "nodejs",
          installPackages: ["nodejs", "npm"],
        },
      ]),
    );
  });
});
