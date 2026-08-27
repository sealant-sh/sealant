import { readFile } from "node:fs/promises";

import type { NewWorkspace } from "@sealant/validators";
import { describe, expect, it, vi } from "vitest";

import {
  compileWorkspaceBuildSpec,
  mapBlueprintToBuildkitImagePlan,
  planWorkspaceImageBuild,
  sealantdImageReference,
  selectBuildkitOsFamily,
} from "./buildkit-builder.js";

const createWorkspaceBuildSpec = (overrides: Partial<NewWorkspace> = {}): NewWorkspace => {
  const base: NewWorkspace = {
    version: "1",
    sources: {
      workspace: {
        kind: "git",
        provider: "generic",
        url: "https://github.com/example/repo.git",
        ref: "main",
      },
      inputs: [],
      mounts: [],
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
      userEnv: {},
      credentialRefs: [],
      dotfilesArchives: [],
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace/repo",
      persistence: "ephemeral",
      envFrom: [],
      kubernetes: {},
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
      workspace: {
        ...base.sources.workspace,
        ...overrides.sources?.workspace,
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

describe("compileWorkspaceBuildSpec", () => {
  it("renders Mend's complete Arch profile into one sealantd workspace image", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const packages = [
      "pnpm",
      "python",
      "uv",
      "mise",
      "github-cli",
      "lazygit",
      "bat",
      "curl",
      "jq",
      "ripgrep",
      "fd",
      "fzf",
    ];
    const blueprint = createWorkspaceBuildSpec({
      tooling: {
        packages: packages.map((id) => ({ id })),
        services: { docker: { enabled: true } },
      },
      target: {
        os: { family: "arch", mode: "prefer" },
        runtime: { family: "docker", mode: "require" },
      },
    });

    const result = await compileWorkspaceBuildSpec({ blueprint, options: { commandRunner } });
    const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");

    expect(containerfile).toContain("FROM archlinux:latest");
    for (const packageName of packages) {
      expect(containerfile).toContain(packageName);
    }
    expect(containerfile).toContain("/usr/local/bin/sealantd");
    expect(containerfile).toContain("/usr/local/bin/docker");
    expect(containerfile).toContain('ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]');
  });

  it("adds the Docker client and Compose plugin for the runtime-managed Docker service", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const blueprint = createWorkspaceBuildSpec({
      tooling: {
        packages: [],
        services: { docker: { enabled: true } },
      },
    });

    const result = await compileWorkspaceBuildSpec({ blueprint, options: { commandRunner } });
    const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");

    expect(containerfile).toContain(
      "COPY --from=docker:27.5.1-cli /usr/local/bin/docker /usr/local/bin/docker",
    );
    expect(containerfile).toContain(
      "COPY --from=docker:27.5.1-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose",
    );
    expect(containerfile).not.toContain("dockerd");
  });

  it("maps a blueprint into a resolved BuildKit image plan", () => {
    const blueprint = createWorkspaceBuildSpec({
      sources: {
        workspace: {
          kind: "git",
          provider: "generic",
          url: "https://github.com/example/repo.git",
          ref: "main",
          authRef: "/workspace/.secrets/workspace_repo_key",
        },
        inputs: [
          {
            id: "dotfiles",
            kind: "git",
            purpose: "dotfiles",
            provider: "generic",
            url: "https://github.com/example/dotfiles.git",
            ref: "main",
            authRef: "/workspace/.secrets/dotfiles_key",
          },
        ],
        mounts: [],
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
    const blueprint = createWorkspaceBuildSpec({
      sources: {
        workspace: {
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
        mounts: [],
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

    const result = await compileWorkspaceBuildSpec({
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
    expect(containerfile).toContain('ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]');
  });

  it("installs stow when the dotfiles manager is stow", () => {
    const blueprint = createWorkspaceBuildSpec({
      sources: {
        workspace: {
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
        mounts: [],
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

  it("installs chezmoi from the pinned upstream release on ubuntu (no archive package)", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const blueprint = createWorkspaceBuildSpec({
      sources: {
        workspace: {
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
        mounts: [],
      },
      target: {
        os: {
          family: "ubuntu",
          mode: "require",
        },
        runtime: {
          family: "auto",
          mode: "prefer",
        },
      },
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "ubuntu");
    // The `auto` manager requests chezmoi; ubuntu maps that to the download prerequisites
    // instead of an apt package that does not exist in 24.04.
    const chezmoiRequest = plan.packages.find((pkg) => pkg.requestId === "chezmoi");
    expect(chezmoiRequest?.installPackages).toEqual(["curl", "ca-certificates"]);

    const result = await compileWorkspaceBuildSpec({
      blueprint,
      options: { commandRunner },
    });
    const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");
    expect(containerfile).toContain("github.com/twpayne/chezmoi/releases/download");
    expect(containerfile).toContain("sha256sum -c -");
    expect(containerfile).toContain("tar -xzf /tmp/chezmoi.tar.gz -C /usr/local/bin chezmoi");
  });

  it("omits the release install when the manager can never invoke chezmoi", () => {
    const blueprint = createWorkspaceBuildSpec({
      sources: {
        workspace: {
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
        mounts: [],
      },
      customization: {
        defaultShell: "bash",
        dotfilesManager: "copy",
        dotfilesTarget: "home",
        applyDotfiles: true,
        dotfilesBootstrap: true,
      },
      target: {
        os: {
          family: "ubuntu",
          mode: "require",
        },
        runtime: {
          family: "auto",
          mode: "prefer",
        },
      },
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "ubuntu");
    expect(plan.packages.find((pkg) => pkg.requestId === "chezmoi")).toBeUndefined();
  });

  it("clones the remote default branch when the dotfiles input has no ref", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const blueprint = createWorkspaceBuildSpec({
      sources: {
        workspace: {
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
          },
        ],
        mounts: [],
      },
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "fedora");
    expect(plan.dotfiles?.ref).toBeUndefined();

    const result = await compileWorkspaceBuildSpec({
      blueprint,
      options: { commandRunner },
    });
    const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");
    expect(containerfile).toContain(
      "git clone --depth=1 'https://github.com/example/dotfiles.git'",
    );
    expect(containerfile).not.toContain("--branch");
  });

  it("requests tar and the managers dotfiles archives can invoke", () => {
    const archiveData = Buffer.from("archive").toString("base64");
    const blueprint = createWorkspaceBuildSpec({
      runtime: {
        env: {},
        userEnv: {},
        credentialRefs: [],
        dotfilesArchives: [
          { data: archiveData, manager: "copy", bootstrap: false },
          { data: archiveData, bootstrap: true },
        ],
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/repo",
        persistence: "ephemeral",
        envFrom: [],
        kubernetes: {},
        ociRuntime: "runc",
        network: { outbound: true },
      },
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "fedora");
    const requestIds = plan.packages.map((pkg) => pkg.requestId);
    // The second archive defaults to "auto", which can invoke chezmoi or stow; no git — archives
    // are staged by the worker, not cloned.
    expect(requestIds).toEqual(expect.arrayContaining(["tar", "chezmoi", "stow"]));
    expect(requestIds).not.toContain("git");
  });

  it("requests only tar for copy-manager archives", () => {
    const archiveData = Buffer.from("archive").toString("base64");
    const blueprint = createWorkspaceBuildSpec({
      runtime: {
        env: {},
        userEnv: {},
        credentialRefs: [],
        dotfilesArchives: [{ data: archiveData, manager: "copy", bootstrap: false }],
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/repo",
        persistence: "ephemeral",
        envFrom: [],
        kubernetes: {},
        ociRuntime: "runc",
        network: { outbound: true },
      },
    });

    const plan = mapBlueprintToBuildkitImagePlan(blueprint, "fedora");
    const requestIds = plan.packages.map((pkg) => pkg.requestId);
    expect(requestIds).toContain("tar");
    expect(requestIds).not.toContain("chezmoi");
    expect(requestIds).not.toContain("stow");
  });

  it("rejects dotfiles archives with a custom base image", () => {
    const archiveData = Buffer.from("archive").toString("base64");
    const blueprint = createWorkspaceBuildSpec({
      runtime: {
        env: {},
        userEnv: {},
        credentialRefs: [],
        dotfilesArchives: [{ data: archiveData, bootstrap: true }],
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/repo",
        persistence: "ephemeral",
        envFrom: [],
        kubernetes: {},
        ociRuntime: "runc",
        network: { outbound: true },
      },
      target: {
        os: {
          family: "custom",
          mode: "require",
          baseImage: "node:22-bookworm",
        },
        runtime: {
          family: "auto",
          mode: "prefer",
        },
      },
    });

    expect(() => selectBuildkitOsFamily({ blueprint })).toThrow(/Dotfiles are not supported/);
  });

  it("emits no SEALANT_DOTFILES_REPO_REF for a ref-less runtime apply", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const blueprint = createWorkspaceBuildSpec({
      sources: {
        workspace: {
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
            authRef: "github-installation-repository:gh_installation_repo_1",
          },
        ],
        mounts: [],
      },
    });

    const result = await compileWorkspaceBuildSpec({
      blueprint,
      options: { commandRunner },
    });
    const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");
    expect(containerfile).toContain("SEALANT_DOTFILES_RUNTIME_APPLY='1'");
    expect(containerfile).not.toContain("SEALANT_DOTFILES_REPO_REF");
  });

  it("includes npm when Node.js-backed harness tooling is requested on Linux distros", () => {
    const fedoraPlan = mapBlueprintToBuildkitImagePlan(
      createWorkspaceBuildSpec({
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
      createWorkspaceBuildSpec({
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
      blueprint: createWorkspaceBuildSpec({
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

  it("rejects Docker when it is requested as an OS package", () => {
    const blueprint = createWorkspaceBuildSpec({
      tooling: {
        packages: [{ id: "docker" }],
      },
      target: {
        os: { family: "arch", mode: "prefer" },
        runtime: { family: "docker", mode: "require" },
      },
    });

    expect(() => selectBuildkitOsFamily({ blueprint })).toThrow(
      "Docker must be requested through tooling.services.docker",
    );
  });

  it("renders a build context and invokes docker build plus docker save", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const result = await compileWorkspaceBuildSpec({
      blueprint: createWorkspaceBuildSpec({
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
    expect(saveCommandArgs[2]).toMatch(/workspace-image\.tar$/);
    expect(result.builder).toEqual({
      id: "fedora",
      osFamily: "fedora",
    });
    expect(result.buildkit.imagePlan.packageManager).toBe("dnf");

    const containerfilePath = result.buildkit.spec.containerfilePath;
    const containerfile = await readFile(containerfilePath, "utf8");

    // Thin per-distro template: FROM + harness installs + sealantd copy + boot ENV + boot entrypoint.
    expect(containerfile).toContain("FROM fedora:41");
    // Every baked harness is installed; the blueprint's own (opencode) rides as an extra.
    expect(containerfile).toContain("RUN npm install -g @openai/codex@latest");
    expect(containerfile).toContain(
      "RUN npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest",
    );
    expect(containerfile).toContain("RUN npm install -g opencode-ai@latest");
    // Codex's sandbox prerequisite is baked with the CLI — no "could not find bubblewrap" banner.
    expect(containerfile).toMatch(/dnf -y install [^\n]*\bbubblewrap\b/);
    expect(containerfile).toContain(
      `COPY --from=${sealantdImageReference} /usr/local/bin/sealantd /usr/local/bin/sealantd`,
    );
    expect(containerfile).toContain("RUN chmod 755 /usr/local/bin/sealantd");
    expect(containerfile).toContain('ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]');

    // Build-static orchestration is conveyed via the ENV SEALANT_* contract `boot` reads.
    expect(containerfile).toContain("SEALANT_OS_FAMILY='fedora'");
    expect(containerfile).toContain("SEALANT_WORKSPACE_ROOT='/workspace'");
    expect(containerfile).toContain("SEALANT_WORKING_DIRECTORY='/workspace/repo'");
    expect(containerfile).toContain("SEALANT_BASH_SHELL_PATH='/bin/bash'");
    expect(containerfile).toContain("SEALANT_SSHD_PATH='/usr/sbin/sshd'");
    expect(containerfile).toContain("SEALANT_CONTROL_SOCKET='/run/sealant/control.sock'");
    // Harness identity is a LAUNCH fact (docker runtime adapter `-e`), never image ENV: one
    // image serves every baked harness.
    expect(containerfile).not.toContain("SEALANT_HARNESS_BANNER");
    expect(containerfile).not.toContain("SEALANT_HARNESS_LAUNCH_COMMAND");
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
    expect(containerfile).not.toContain("workspace-entrypoint");
    expect(containerfile).not.toContain("workspace-ssh-shell");
    expect(containerfile).not.toContain("set -euo pipefail");
    expect(containerfile).not.toContain("cleanup_workspace_clone_auth");
    expect(containerfile).not.toContain('git clone --branch "$WORKSPACE_REPO_REF"');
    expect(containerfile).not.toContain("exec /bin/bash -lc 'pnpm dev'");

    // The build context no longer materializes an entrypoint.sh next to the Containerfile.
    const entrypointPath = containerfilePath.replace(/Containerfile$/, "entrypoint.sh");
    await expect(readFile(entrypointPath, "utf8")).rejects.toThrow();
  });

  it("starts the selected harness when startup foreground is harness", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));
    const result = await compileWorkspaceBuildSpec({
      blueprint: createWorkspaceBuildSpec({
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
    expect(containerfile).toContain(
      "RUN npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest",
    );
    // Harness foreground resolves its launch command from RUNTIME env (docker `-e`), not image
    // ENV. No `SEALANT_FOREGROUND_RUN_JSON` for harness kind.
    expect(containerfile).not.toContain("SEALANT_HARNESS_LAUNCH_COMMAND");
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
    const result = await compileWorkspaceBuildSpec({
      blueprint: createWorkspaceBuildSpec({
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
    expect(containerfile).toContain("nixpkgs#bubblewrap");
    expect(containerfile).not.toContain("nixpkgs#git'");
    expect(containerfile).toContain("RUN npm install -g --prefix /usr/local @openai/codex@latest");
    expect(containerfile).toContain(
      "RUN npm install -g --prefix /usr/local --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest",
    );
    expect(containerfile).toContain("ENV SHELL='/root/.nix-profile/bin/zsh'");
    expect(containerfile).not.toContain("RUN usermod -s");
    expect(containerfile).toContain('ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]');
    // nixos/nix's PATH is only its profile dirs; without this prepend the container dies at
    // init with `exec: "sealantd": executable file not found in $PATH`.
    expect(containerfile).toContain("ENV PATH=/usr/local/bin:$PATH");

    // Nix-specific shell paths flow to `boot` via the build-static ENV contract so the supervisor
    // (E3 glibc shim, ssh bring-up, harness launch) resolves the right binaries per distro.
    expect(containerfile).toContain("SEALANT_OS_FAMILY='nix'");
    expect(containerfile).toContain("SEALANT_BASH_SHELL_PATH='/root/.nix-profile/bin/bash'");
    expect(containerfile).toContain("SEALANT_LOGIN_SHELL_PATH='/root/.nix-profile/bin/zsh'");
    expect(containerfile).toContain("SEALANT_SSHD_PATH='/root/.nix-profile/bin/sshd'");
    expect(containerfile).not.toContain("SEALANT_HARNESS_LAUNCH_COMMAND");

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
    const result = await compileWorkspaceBuildSpec({
      blueprint: createWorkspaceBuildSpec({
        // No enableSealantd flag at all: the clean-cut design boots every workspace via `sealantd boot`.
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
      `COPY --from=${sealantdImageReference} /usr/local/bin/sealantd /usr/local/bin/sealantd`,
    );
    expect(containerfile).toContain("RUN chmod 755 /usr/local/bin/sealantd");
    expect(containerfile).toContain("socat");
    // The sealantd COPY follows the harness install (cache ordering).
    expect(containerfile.indexOf("COPY --from=ghcr.io/sealant-sh/sealantd")).toBeGreaterThan(
      containerfile.indexOf("npm install -g"),
    );

    // PID 1 is `sealantd boot`; the control socket is conveyed via build-static ENV.
    expect(containerfile).toContain('ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]');
    expect(containerfile).toContain("SEALANT_CONTROL_SOCKET='/run/sealant/control.sock'");

    // No generated bash entrypoint, no opt-out flag, no inline `&`+trap supervision.
    expect(containerfile).not.toContain("entrypoint.sh");
    expect(containerfile).not.toContain("workspace-entrypoint");
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
      {
        osFamily: "ubuntu",
        sealantdLayer: "nixpkgs#socat",
      },
    ] as const) {
      const commandRunner = vi.fn<
        (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
      >(async () => ({ stdout: "", stderr: "" }));
      const result = await compileWorkspaceBuildSpec({
        blueprint: createWorkspaceBuildSpec({
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
        `COPY --from=${sealantdImageReference} /usr/local/bin/sealantd /usr/local/bin/sealantd`,
      );
      expect(containerfile).toContain('ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]');
    }
  });

  it("supports distro package passthrough for unmapped package ids", () => {
    const blueprint = createWorkspaceBuildSpec({
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

describe("ubuntu distro family", () => {
  it("renders an apt install layer with cache mounts and non-interactive frontend", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));

    const result = await compileWorkspaceBuildSpec({
      blueprint: createWorkspaceBuildSpec({
        tooling: { packages: [{ id: "ripgrep" }, { id: "fd-find" }] },
        customization: {
          defaultShell: "zsh",
          dotfilesManager: "auto",
          dotfilesTarget: "home",
          applyDotfiles: false,
          dotfilesBootstrap: false,
        },
        target: {
          os: { family: "ubuntu", mode: "prefer" },
          runtime: { family: "auto", mode: "prefer" },
        },
      }),
      options: { commandRunner },
    });

    expect(result.builder).toEqual({ id: "ubuntu", osFamily: "ubuntu" });
    // opencode is not a baked harness, so the image name carries the harness suffix.
    expect(result.buildkit.spec.imageReference).toBe("sealant-workspace-ubuntu-opencode:latest");

    const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");

    expect(containerfile).toContain("FROM ubuntu:24.04");
    expect(containerfile).toContain("RUN --mount=type=cache,target=/var/cache/apt,sharing=locked");
    expect(containerfile).toContain("--mount=type=cache,target=/var/lib/apt,sharing=locked");
    expect(containerfile).toContain("rm -f /etc/apt/apt.conf.d/docker-clean");
    expect(containerfile).toContain(
      "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends",
    );
    // Internal + sealantd + requested packages all land in the single install layer.
    for (const expectedPackage of [
      "ca-certificates",
      "openssh-client",
      "passwd",
      "socat",
      "ripgrep",
      "fd-find",
      "zsh",
    ]) {
      expect(containerfile).toContain(expectedPackage);
    }
    expect(containerfile).toContain("RUN usermod -s '/usr/bin/zsh' root");
    expect(containerfile).toContain("SEALANT_OS_FAMILY='ubuntu'");
    expect(containerfile).toContain('ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]');
  });

  it("selects ubuntu when target.os.family requests it explicitly", () => {
    const osFamily = selectBuildkitOsFamily({
      blueprint: createWorkspaceBuildSpec({
        target: {
          os: { family: "ubuntu", mode: "prefer" },
          runtime: { family: "auto", mode: "prefer" },
        },
      }),
    });

    expect(osFamily).toBe("ubuntu");
  });
});

const customTarget = (baseImage: string) =>
  ({
    os: { family: "custom", mode: "require", baseImage },
    runtime: { family: "auto", mode: "prefer" },
  }) as const;

describe("custom base images", () => {
  it("renders an overlay-only Containerfile: preflight, harness CLIs, static sealantd+socat", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));

    const result = await compileWorkspaceBuildSpec({
      blueprint: createWorkspaceBuildSpec({
        target: customTarget("node:22-bookworm"),
      }),
      options: { commandRunner },
    });

    expect(result.builder).toEqual({ id: "custom", osFamily: "custom" });

    const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");

    expect(containerfile).toContain("FROM node:22-bookworm");
    // Contract preflight with readable failures for each requirement.
    expect(containerfile).toContain("the custom base image has no git");
    expect(containerfile).toContain("the custom base image has no node");
    expect(containerfile).toContain("the custom base image has no npm");
    // Static binaries via COPY --chmod: nothing assumes coreutils in the base.
    expect(containerfile).toContain(
      `COPY --chmod=755 --from=${sealantdImageReference} /usr/local/bin/sealantd /usr/local/bin/sealantd`,
    );
    expect(containerfile).toContain(
      `COPY --chmod=755 --from=${sealantdImageReference} /usr/local/bin/socat /usr/local/bin/socat`,
    );
    // No distro package installs, no shell reconfiguration.
    expect(containerfile).not.toContain("dnf ");
    expect(containerfile).not.toContain("pacman ");
    expect(containerfile).not.toContain("nix profile");
    expect(containerfile).not.toContain("usermod");
    // Harness CLIs still install through npm.
    expect(containerfile).toContain("RUN npm install -g");
    expect(containerfile).toContain("SEALANT_OS_FAMILY='custom'");
    expect(containerfile).toContain("SEALANT_LOGIN_SHELL_PATH='/bin/sh'");
    expect(containerfile).toContain("SEALANT_BASH_SHELL_PATH='/bin/sh'");
    expect(containerfile).toContain('ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]');
    // A custom base makes no PATH promises; the baked binaries must resolve by name anyway.
    expect(containerfile).toContain("ENV PATH=/usr/local/bin:$PATH");
  });

  it("installs requested packages through the base's detected package manager", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));

    const result = await compileWorkspaceBuildSpec({
      blueprint: createWorkspaceBuildSpec({
        tooling: { packages: [{ id: "ripgrep" }, { id: "jq" }] },
        target: customTarget("node:22-alpine"),
      }),
      options: { commandRunner },
    });

    const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");

    expect(containerfile).toContain("apt-get install -y --no-install-recommends ripgrep jq");
    expect(containerfile).toContain("apk add --no-cache ripgrep jq");
    expect(containerfile).toContain("dnf -y install ripgrep jq");
    expect(containerfile).toContain("pacman -Sy --noconfirm --needed ripgrep jq");
    expect(containerfile).toContain("no supported package manager (apt/apk/dnf/pacman)");
  });

  it("omits the package-manager detection layer when no packages are requested", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));

    const result = await compileWorkspaceBuildSpec({
      blueprint: createWorkspaceBuildSpec({ target: customTarget("node:22-bookworm") }),
      options: { commandRunner },
    });

    const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");

    expect(containerfile).not.toContain("apk add");
    expect(containerfile).not.toContain("apt-get update");
  });

  it("rejects non-default shells: custom bases guarantee /bin/sh and nothing more", () => {
    expect(() =>
      selectBuildkitOsFamily({
        blueprint: createWorkspaceBuildSpec({
          customization: {
            defaultShell: "zsh",
            dotfilesManager: "auto",
            dotfilesTarget: "home",
            applyDotfiles: false,
            dotfilesBootstrap: false,
          },
          target: customTarget("node:22-bookworm"),
        }),
      }),
    ).toThrow(/custom base images run \/bin\/sh/i);
  });

  it("translates a shell-less base's build failure into the contract's own words", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async (_command, args) => {
      if (args[0] === "build") {
        throw new Error(
          'BuildKit command failed with exit 1: docker build\nrunc run failed: unable to start container process: exec: "/bin/sh": stat /bin/sh: no such file or directory',
        );
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      compileWorkspaceBuildSpec({
        blueprint: createWorkspaceBuildSpec({ target: customTarget("gcr.io/distroless/static") }),
        options: { commandRunner },
      }),
    ).rejects.toThrow(
      "The custom base image 'gcr.io/distroless/static' has no /bin/sh — the custom base contract requires a POSIX shell.",
    );
  });

  it("keeps mount-sourced git trust and names the image after the base reference", async () => {
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));

    // The helper's deep-merge would splice mount keys over the base git source, so replace the
    // sources block wholesale.
    const blueprint: NewWorkspace = {
      ...createWorkspaceBuildSpec({ target: customTarget("node:22-bookworm") }),
      sources: {
        workspace: { kind: "mount", hostPath: "/tmp/example-worktree" },
        inputs: [],
        mounts: [],
      },
    };

    const result = await compileWorkspaceBuildSpec({
      blueprint,
      options: { commandRunner },
    });

    const containerfile = await readFile(result.buildkit.spec.containerfilePath, "utf8");

    expect(containerfile).toContain(
      "RUN git config --system --add safe.directory '/workspace/repo'",
    );
    expect(result.buildkit.spec.imageReference).toBe(
      "sealant-workspace-custom-node-22-bookworm-opencode:latest",
    );
  });
});

describe("planWorkspaceImageBuild", () => {
  it("hashes the rendered Containerfile deterministically without running Docker", () => {
    const blueprint = createWorkspaceBuildSpec();

    const first = planWorkspaceImageBuild({ blueprint });
    const second = planWorkspaceImageBuild({ blueprint });

    expect(first.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.planHash).toBe(first.planHash);
    expect(second.containerfile).toBe(first.containerfile);
    expect(first.osFamily).toBe("fedora");
  });

  it("changes the hash when the plan changes the image content", () => {
    const base = planWorkspaceImageBuild({ blueprint: createWorkspaceBuildSpec() });
    const withPackage = planWorkspaceImageBuild({
      blueprint: createWorkspaceBuildSpec({
        tooling: { packages: [{ id: "ripgrep" }] },
      }),
    });

    expect(withPackage.planHash).not.toBe(base.planHash);
  });

  it("keeps the hash stable across launch-only differences (runtime env)", () => {
    const base = planWorkspaceImageBuild({ blueprint: createWorkspaceBuildSpec() });
    const withRuntimeEnv = planWorkspaceImageBuild({
      blueprint: createWorkspaceBuildSpec({
        runtime: {
          env: { EXAMPLE: "per-session-value" },
          userEnv: {},
          credentialRefs: [],
          dotfilesArchives: [],
          workspaceRoot: "/workspace",
          workingDirectory: "/workspace/repo",
          persistence: "ephemeral",
          envFrom: [],
          kubernetes: {},
          ociRuntime: "runc",
          network: { outbound: true },
        },
      }),
    });

    // runtime.env is injected at `docker run`, not baked into the image, so it must not force
    // a rebuild of an already-published image.
    expect(withRuntimeEnv.planHash).toBe(base.planHash);
  });

  it("records the plan hash in the compile result metadata and writes the same Containerfile", async () => {
    const blueprint = createWorkspaceBuildSpec();
    const commandRunner = vi.fn<
      (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    >(async () => ({ stdout: "", stderr: "" }));

    const planned = planWorkspaceImageBuild({ blueprint });
    const result = await compileWorkspaceBuildSpec({ blueprint, options: { commandRunner } });

    expect(result.metadata?.planHash).toBe(planned.planHash);
    await expect(readFile(result.buildkit.spec.containerfilePath, "utf8")).resolves.toBe(
      planned.containerfile,
    );
  });
});
