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
    const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");

    // Runtime dotfiles are no longer baked as entrypoint bash: `boot` performs the clone+apply,
    // driven by the build-static `SEALANT_DOTFILES_*` env contract emitted into the Containerfile.
    expect(containerfile).toContain("SEALANT_DOTFILES_RUNTIME_APPLY='1'");
    expect(containerfile).toContain(
      "SEALANT_DOTFILES_GITHUB_INSTALLATION_REPOSITORY_ID='gh_installation_repo_1'",
    );
    expect(containerfile).toContain(
      "SEALANT_DOTFILES_REPO_URL='https://github.com/example/dotfiles.git'",
    );
    expect(containerfile).toContain("SEALANT_DOTFILES_MANAGER='auto'");
    expect(containerfile).toContain("SEALANT_DOTFILES_BOOTSTRAP_COMMAND='./install.sh'");
    // The HTTP token stays run-dynamic (injected by the runtime adapter), never baked into ENV.
    expect(containerfile).not.toContain("SEALANT_DOTFILES_HTTP_TOKEN");
    // No generated entrypoint.sh exists anymore.
    expect(containerfile).toContain('ENTRYPOINT ["sealantd", "boot"]');
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
    const containerfile = await readFile(containerfilePath, "utf8");

    // Thin per-distro template: FROM + harness install + sealantd copy + boot ENV + boot entrypoint.
    expect(containerfile).toContain("FROM fedora:41");
    expect(containerfile).toContain("RUN npm install -g opencode-ai@latest");
    expect(containerfile).toContain(
      "COPY --from=ghcr.io/get-sealant/sealantd:0.3.0 /usr/local/bin/sealantd /usr/local/bin/sealantd",
    );
    expect(containerfile).toContain("RUN chmod 755 /usr/local/bin/sealantd");
    expect(containerfile).toContain('ENTRYPOINT ["sealantd", "boot"]');

    // Build-static orchestration is conveyed via the ENV SEALANT_* contract `boot` reads.
    expect(containerfile).toContain("SEALANT_OS_FAMILY='fedora'");
    expect(containerfile).toContain("SEALANT_SANDBOX_ROOT='/sandbox'");
    expect(containerfile).toContain("SEALANT_WORKING_DIRECTORY='/sandbox/repo'");
    expect(containerfile).toContain("SEALANT_BASH_SHELL_PATH='/bin/bash'");
    expect(containerfile).toContain("SEALANT_SSHD_PATH='/usr/sbin/sshd'");
    expect(containerfile).toContain("SEALANT_CONTROL_SOCKET='/run/sealant/control.sock'");
    expect(containerfile).toContain("SEALANT_HARNESS_BANNER='Starting opencode sandbox'");
    expect(containerfile).toContain("SEALANT_HARNESS_LAUNCH_COMMAND='opencode'");
    // The literal `command` foreground is carried as build-static JSON, not baked bash.
    expect(containerfile).toContain(
      `SEALANT_FOREGROUND_RUN_JSON='${JSON.stringify({ run: "pnpm dev", shell: "bash" })}'`,
    );

    // §4.1: the inner sshd is gone — no openssh-server in the install layer — but the ssh *client*
    // (git-over-ssh clone) and socat (control-socket relay) are retained.
    expect(containerfile).not.toContain("openssh-server");
    expect(containerfile).toContain("openssh-clients");
    expect(containerfile).toContain("socat");

    // The deleted bash entrypoint must be fully gone: no generated script, no inline supervision.
    expect(containerfile).not.toContain("entrypoint.sh");
    expect(containerfile).not.toContain("sandbox-entrypoint");
    expect(containerfile).not.toContain("sandbox-ssh-shell");
    expect(containerfile).not.toContain("set -euo pipefail");
    expect(containerfile).not.toContain("cleanup_sandbox_clone_auth");
    expect(containerfile).not.toContain('git clone --branch "$SANDBOX_REPO_REF"');
    expect(containerfile).not.toContain("exec /bin/bash -lc 'pnpm dev'");

    // The build context no longer materializes an entrypoint.sh next to the Containerfile.
    const entrypointPath = containerfilePath.replace(/Containerfile$/, "entrypoint.sh");
    await expect(readFile(entrypointPath, "utf8")).rejects.toThrow();
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
    const containerfile = await readFile(containerfilePath, "utf8");
    const buildCommandArgs = (commandRunner.mock.calls[0]?.[1] ?? []) as string[];

    expect(containerfile).toContain("RUN sed -i 's/^DownloadUser/#DownloadUser/' /etc/pacman.conf");
    expect(containerfile).toContain("RUN npm install -g @openai/codex@latest");
    // Harness foreground carries the launch command + login shell as build-static ENV; `boot`
    // resolves and supervises the harness child. No `SEALANT_FOREGROUND_RUN_JSON` for harness kind.
    expect(containerfile).toContain("SEALANT_HARNESS_LAUNCH_COMMAND='codex'");
    expect(containerfile).toContain("SEALANT_LOGIN_SHELL_PATH='/usr/bin/zsh'");
    expect(containerfile).not.toContain("SEALANT_FOREGROUND_RUN_JSON");
    expect(containerfile).not.toContain("exec /usr/bin/zsh -lc 'codex'");
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
    const containerfile = await readFile(containerfilePath, "utf8");

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
    expect(containerfile).toContain('ENTRYPOINT ["sealantd", "boot"]');

    // Nix-specific shell paths flow to `boot` via the build-static ENV contract so the supervisor
    // (E3 glibc shim, ssh bring-up, harness launch) resolves the right binaries per distro.
    expect(containerfile).toContain("SEALANT_OS_FAMILY='nix'");
    expect(containerfile).toContain("SEALANT_BASH_SHELL_PATH='/root/.nix-profile/bin/bash'");
    expect(containerfile).toContain("SEALANT_LOGIN_SHELL_PATH='/root/.nix-profile/bin/zsh'");
    expect(containerfile).toContain("SEALANT_SSHD_PATH='/root/.nix-profile/bin/sshd'");
    expect(containerfile).toContain("SEALANT_HARNESS_LAUNCH_COMMAND='codex'");

    // The deleted bash entrypoint (glibc shim, shadow rewrite, sshd config, harness exec) is gone.
    expect(containerfile).not.toContain("/lib64/ld-linux-x86-64.so.2");
    expect(containerfile).not.toContain("SHADOW_UPDATED");
    expect(containerfile).not.toContain("sshd -f");
    expect(containerfile).not.toContain("exec /root/.nix-profile/bin/zsh -lc 'codex'");
  });

  it("always bakes sealantd boot as the entrypoint (clean cut, no enableSealantd gate)", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const result = await compileSandboxBuildSpec({
      blueprint: createSandboxBuildSpec({
        // No enableSealantd flag at all: the clean-cut design boots every sandbox via `sealantd boot`.
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

    const containerfilePath = result.buildkit.spec.containerfilePath;
    const containerfile = await readFile(containerfilePath, "utf8");

    // sealantd binary + socat relay dependency are always present.
    expect(containerfile).toContain(
      "COPY --from=ghcr.io/get-sealant/sealantd:0.3.0 /usr/local/bin/sealantd /usr/local/bin/sealantd",
    );
    expect(containerfile).toContain("RUN chmod 755 /usr/local/bin/sealantd");
    expect(containerfile).toContain("socat");
    // The sealantd COPY follows the harness install (cache ordering).
    expect(containerfile.indexOf("COPY --from=ghcr.io/get-sealant/sealantd")).toBeGreaterThan(
      containerfile.indexOf("npm install -g"),
    );

    // PID 1 is `sealantd boot`; the control socket is conveyed via build-static ENV.
    expect(containerfile).toContain('ENTRYPOINT ["sealantd", "boot"]');
    expect(containerfile).toContain("SEALANT_CONTROL_SOCKET='/run/sealant/control.sock'");

    // No generated bash entrypoint, no opt-out flag, no inline `&`+trap supervision.
    expect(containerfile).not.toContain("entrypoint.sh");
    expect(containerfile).not.toContain("sandbox-entrypoint");
    expect(containerfile).not.toContain("SEALANT_ENABLE_SEALANTD");
    expect(containerfile).not.toContain("trap cleanup_sealantd");
    expect(containerfile).not.toContain("sealantd --socket");

    // The build context contains a Containerfile but no entrypoint.sh.
    const entrypointPath = containerfilePath.replace(/Containerfile$/, "entrypoint.sh");
    await expect(readFile(entrypointPath, "utf8")).rejects.toThrow();
  });

  it("always installs the socat relay and sealantd binary for every distro", async () => {
    for (const { osFamily, sealantdLayer } of [
      {
        osFamily: "fedora",
        sealantdLayer: "nixpkgs#socat",
      },
      {
        osFamily: "arch",
        sealantdLayer: "nixpkgs#socat",
      },
      {
        osFamily: "nix",
        sealantdLayer: "nixpkgs#socat",
      },
    ] as const) {
      const commandRunner = vi.fn<
        (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
      >(async () => ({ stdout: "", stderr: "" }));
      const result = await compileSandboxBuildSpec({
        blueprint: createSandboxBuildSpec({
          target: {
            os: { family: osFamily, mode: "prefer" },
            runtime: { family: "auto", mode: "prefer" },
          },
        }),
        options: { commandRunner },
      });

      const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");

      // socat (the host<->control-socket relay dependency) is always part of the install layer.
      expect(containerfile).toContain(osFamily === "nix" ? sealantdLayer : "socat");
      expect(containerfile).toContain(
        "COPY --from=ghcr.io/get-sealant/sealantd:0.3.0 /usr/local/bin/sealantd /usr/local/bin/sealantd",
      );
      expect(containerfile).toContain('ENTRYPOINT ["sealantd", "boot"]');
    }
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
