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
      applyAt: "build",
      authSecretId: "dotfiles_git_key",
    });
  });

  it("defers GitHub-authenticated dotfiles to runtime apply", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const executor = new BuildkitDistroOsExecutor({
      osFamily: "fedora",
      commandRunner,
    });
    const blueprint = normalizeUserWorkspaceSpec({
      source: "https://github.com/example/repo.git",
      inputs: [
        {
          purpose: "dotfiles",
          provider: "github",
          url: "https://github.com/example/dotfiles.git",
          ref: "main",
          authRef: "github-installation-repository:gh_installation_repo_1",
        },
      ],
      harness: "opencode",
      os: "fedora",
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "fedora");
    expect(plan.dotfiles).toMatchObject({
      applyAt: "runtime",
      githubInstallationRepositoryId: "gh_installation_repo_1",
    });
    expect(plan.buildSecrets).toEqual([]);

    const result = await executor.compile({ blueprint });
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
    const blueprint = normalizeUserWorkspaceSpec({
      source: "https://github.com/example/repo.git",
      inputs: [
        {
          purpose: "dotfiles",
          url: "https://github.com/example/dotfiles.git",
        },
      ],
      harness: "opencode",
      customization: {
        dotfilesManager: "stow",
      },
      os: "fedora",
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
      normalizeUserWorkspaceSpec({
        source: "https://github.com/example/repo.git",
        harness: "opencode",
        os: "fedora",
      }),
      "fedora",
    );
    const archPlan = mapBlueprintToBuildkitImagePlan(
      normalizeUserWorkspaceSpec({
        source: "https://github.com/example/repo.git",
        harness: "codex",
        os: "arch",
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
    expect(containerfile).toContain("RUN npm install -g opencode-ai@latest");
    expect(containerfile).toContain('ENTRYPOINT ["/usr/local/bin/workspace-entrypoint"]');
    expect(entrypoint).toContain('mkdir -p "$WORKSPACE_ROOT" "$WORKING_DIRECTORY"');
    expect(entrypoint).toContain("cat > /usr/local/bin/workspace-ssh-shell <<'EOF'");
    expect(entrypoint).toContain("ForceCommand /usr/local/bin/workspace-ssh-shell");
    expect(entrypoint).toContain('exec "$LOGIN_SHELL" -i');
    expect(entrypoint).toContain("cat > \"$REPO_GIT_ASKPASS_PATH\" <<'EOF'");
    expect(entrypoint).toContain('export GIT_ASKPASS="$REPO_GIT_ASKPASS_PATH"');
    expect(entrypoint).toContain("cleanup_workspace_clone_auth");
    expect(entrypoint).toContain('git clone --branch "$WORKSPACE_REPO_REF"');
    expect(entrypoint).toContain("exec /bin/bash -lc 'pnpm dev'");
  });

  it("starts the selected harness when startup foreground is harness", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const executor = new BuildkitDistroOsExecutor({
      osFamily: "arch",
      commandRunner,
    });

    const result = await executor.compile({
      blueprint: normalizeUserWorkspaceSpec({
        source: "https://github.com/example/repo.git",
        harness: "codex",
        customization: {
          defaultShell: "zsh",
        },
        os: "arch",
      }),
    });

    const containerfilePath = result.buildkit.spec.containerfilePath;
    const entrypointPath = containerfilePath.replace(/Containerfile$/, "entrypoint.sh");
    const containerfile = await readFile(containerfilePath, "utf8");
    const entrypoint = await readFile(entrypointPath, "utf8");

    expect(containerfile).toContain("RUN npm install -g @openai/codex@latest");
    expect(entrypoint).toContain("exec /usr/bin/zsh -lc 'codex'");
  });

  it("renders nix build contexts with nix package installs", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const executor = new BuildkitDistroOsExecutor({
      osFamily: "nix",
      commandRunner,
    });

    const result = await executor.compile({
      blueprint: normalizeUserWorkspaceSpec({
        source: "https://github.com/example/repo.git",
        harness: "codex",
        customization: {
          defaultShell: "zsh",
        },
        os: "nix",
      }),
    });

    const containerfilePath = result.buildkit.spec.containerfilePath;
    const entrypointPath = containerfilePath.replace(/Containerfile$/, "entrypoint.sh");
    const containerfile = await readFile(containerfilePath, "utf8");
    const entrypoint = await readFile(entrypointPath, "utf8");

    expect(result.executor).toEqual({
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
    expect(entrypoint).toContain("exec /root/.nix-profile/bin/zsh -lc 'codex'");
  });

  it("supports distro package passthrough for unmapped package ids", () => {
    const blueprint = normalizeUserWorkspaceSpec({
      source: "https://github.com/example/repo.git",
      harness: "opencode",
      packages: ["htop"],
      os: "arch",
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
