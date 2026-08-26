import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

import type { NewWorkspace } from "@sealant/validators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileWorkspaceBuildSpec, type BuildkitCommandRunner } from "./buildkit-builder.js";

const execFileAsync = promisify(execFile);
const docker: BuildkitCommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

const selectedPackages = [
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
] as const;

const blueprintForOs = (
  osFamily: "arch" | "ubuntu",
  packages: readonly string[],
): NewWorkspace => ({
  version: "1",
  sources: {
    workspace: { kind: "mount", hostPath: "/tmp/sealant-package-e2e-source" },
    inputs: [],
    mounts: [],
  },
  harness: { id: "opencode" },
  access: { ssh: { enabled: false, listenPort: 2222 } },
  tooling: {
    packages: packages.map((id) => ({ id })),
    services: { docker: { enabled: true } },
  },
  customization: {
    defaultShell: "bash",
    dotfilesManager: "auto",
    dotfilesTarget: "home",
    applyDotfiles: false,
    dotfilesBootstrap: false,
  },
  lifecycle: {
    setup: [],
    startup: { steps: [], foreground: { kind: "command", run: "sleep infinity", shell: "bash" } },
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
    network: { outbound: true },
  },
  target: {
    os: { family: osFamily, mode: "prefer" },
    runtime: { family: "docker", mode: "require" },
  },
});

const blueprint: NewWorkspace = blueprintForOs("arch", selectedPackages);

describe("selected packages in an Arch workspace image", () => {
  let contextDirectory: string | undefined;
  let imageReference: string | undefined;

  beforeAll(async () => {
    const result = await compileWorkspaceBuildSpec({
      blueprint,
      options: { commandRunner: docker },
    });
    contextDirectory = result.buildkit.spec.contextDirectory;
    imageReference = result.buildkit.spec.imageReference;
  }, 600_000);

  afterAll(async () => {
    if (imageReference !== undefined) {
      await docker("docker", ["image", "rm", "-f", imageReference]).catch(() => undefined);
    }
    if (contextDirectory !== undefined) {
      await rm(contextDirectory, { recursive: true, force: true });
    }
  });

  it("builds through pacman and contains every selected executable beside sealantd", async () => {
    const result = await docker("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "/bin/bash",
      imageReference ?? "missing-package-e2e-image",
      "-lc",
      [
        "command -v pnpm",
        "command -v python3",
        "command -v uv",
        "command -v mise",
        "command -v gh",
        "command -v lazygit",
        "command -v bat",
        "command -v curl",
        "command -v jq",
        "command -v rg",
        "command -v fd",
        "command -v fzf",
        "command -v docker",
        "command -v sealantd",
        "printf package-image-ok",
      ].join(" && "),
    ]);

    expect(result.stdout).toContain("package-image-ok");
  }, 60_000);

  it("includes Docker Compose with the runtime-managed Docker client", async () => {
    const result = await docker("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "/usr/local/bin/docker",
      imageReference ?? "missing-package-e2e-image",
      "compose",
      "version",
    ]);

    expect(result.stdout).toContain("Docker Compose version");
  }, 60_000);
});

// The Ubuntu list uses the CONCRETE apt package names the API's standardization pass would
// produce (python → python3, fd → fd-find, github-cli → gh, bat's binary is batcat) — the
// compiler receives resolved names in production, not catalog ids.
const ubuntuSelectedPackages = [
  "python3",
  "gh",
  "bat",
  "curl",
  "jq",
  "ripgrep",
  "fd-find",
  "fzf",
  "neovim",
  "tmux",
  "zsh",
] as const;

describe("selected packages in an Ubuntu workspace image", () => {
  let contextDirectory: string | undefined;
  let imageReference: string | undefined;

  beforeAll(async () => {
    const result = await compileWorkspaceBuildSpec({
      blueprint: blueprintForOs("ubuntu", ubuntuSelectedPackages),
      options: { commandRunner: docker },
    });
    contextDirectory = result.buildkit.spec.contextDirectory;
    imageReference = result.buildkit.spec.imageReference;
  }, 600_000);

  afterAll(async () => {
    if (imageReference !== undefined) {
      await docker("docker", ["image", "rm", "-f", imageReference]).catch(() => undefined);
    }
    if (contextDirectory !== undefined) {
      await rm(contextDirectory, { recursive: true, force: true });
    }
  });

  it("builds through apt and contains every selected executable beside sealantd", async () => {
    const result = await docker("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "/bin/bash",
      imageReference ?? "missing-package-e2e-image",
      "-lc",
      [
        "command -v python3",
        "command -v gh",
        "command -v batcat",
        "command -v curl",
        "command -v jq",
        "command -v rg",
        "command -v fdfind",
        "command -v fzf",
        "command -v nvim",
        "command -v tmux",
        "command -v zsh",
        "command -v node",
        "command -v docker",
        "command -v socat",
        "command -v sealantd",
        "printf package-image-ok",
      ].join(" && "),
    ]);

    expect(result.stdout).toContain("package-image-ok");
  }, 60_000);

  it("includes Docker Compose with the runtime-managed Docker client", async () => {
    const result = await docker("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "/usr/local/bin/docker",
      imageReference ?? "missing-package-e2e-image",
      "compose",
      "version",
    ]);

    expect(result.stdout).toContain("Docker Compose version");
  }, 60_000);
});
