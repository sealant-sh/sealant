/**
 * An Arch workspace image builds and runs natively on the Docker daemon's own architecture: from
 * Docker Hub's `archlinux` on amd64, from Arch Linux ARM's verified rootfs on arm64 (CI runs this
 * on both). The image carries every package in the catalog and every baked harness, so a package
 * Arch Linux ARM lacks, or a harness without an arm64 build, fails it.
 */
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

import type { NewWorkspace, WorkspaceImagePlatform } from "@sealant/validators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HARNESS_VERSIONS } from "../harness/integrations.js";
import { compileWorkspaceBuildSpec, type BuildkitCommandRunner } from "./buildkit-builder.js";
import { knownWorkspacePackageIds } from "./package-catalog.js";
import { dockerDaemonImagePlatform } from "./platform.js";

const execFileAsync = promisify(execFile);
const docker: BuildkitCommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    maxBuffer: 50 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

const blueprint: NewWorkspace = {
  version: "1",
  sources: {
    workspace: { kind: "mount", hostPath: "/tmp/sealant-arch-native-e2e-source" },
    inputs: [],
    mounts: [],
  },
  harness: { id: "codex" },
  access: { ssh: { enabled: false, listenPort: 2222 } },
  tooling: {
    packages: knownWorkspacePackageIds().map((id) => ({ id })),
    services: { docker: { enabled: false } },
  },
  customization: {
    defaultShell: "zsh",
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
    network: { outbound: true, cloudMetadata: false },
  },
  target: {
    os: { family: "arch", mode: "require" },
    runtime: { family: "docker", mode: "require" },
  },
};

/** One command per catalog entry, by the name it installs. */
const COMMANDS = [
  "bash",
  "bat",
  "bun",
  "bunx",
  "bwrap",
  "chezmoi",
  "curl",
  "direnv",
  "eza",
  "fd",
  "fish",
  "fzf",
  "gh",
  "git",
  "htop",
  "jq",
  "lazygit",
  "mise",
  "node",
  "npm",
  "nvim",
  "pnpm",
  "python3",
  "rg",
  "starship",
  "stow",
  "tar",
  "tmux",
  "unzip",
  "uv",
  "zsh",
  "sealantd",
] as const;

describe("an Arch workspace image on the Docker daemon's architecture", () => {
  let platform: WorkspaceImagePlatform | undefined;
  let contextDirectory: string | undefined;
  let imageReference = "missing-arch-native-e2e-image";

  const run = async (script: string) =>
    (
      await docker("docker", [
        "run",
        "--rm",
        "--entrypoint",
        "/bin/bash",
        imageReference,
        "-lc",
        script,
      ])
    ).stdout;

  beforeAll(async () => {
    platform = await dockerDaemonImagePlatform(docker);
    const result = await compileWorkspaceBuildSpec({
      blueprint,
      platform,
      options: { commandRunner: docker, emitTarball: false },
    });
    contextDirectory = result.buildkit.spec.contextDirectory;
    imageReference = result.buildkit.spec.imageReference;
    // The image probe ran and the build required the person layout (`image-probe --require`).
    expect(result.metadata?.imageProbe).toBeDefined();
  }, 2_400_000);

  afterAll(async () => {
    await docker("docker", ["image", "rm", "-f", imageReference]).catch(() => undefined);
    if (contextDirectory !== undefined) {
      await rm(contextDirectory, { recursive: true, force: true });
    }
  });

  it("is built for the daemon's architecture and runs it natively", async () => {
    const machine = (await run("uname -m")).trim();
    const id = (await run('. /etc/os-release && printf %s "$ID"')).trim();
    const architecture = (
      await docker("docker", ["image", "inspect", "--format", "{{.Architecture}}", imageReference])
    ).stdout.trim();
    if (platform === "linux/arm64") {
      expect(machine).toBe("aarch64");
      expect(id).toBe("archarm");
      expect(architecture).toBe("arm64");
    } else {
      expect(machine).toBe("x86_64");
      expect(id).toBe("arch");
      expect(architecture).toBe("amd64");
    }
    expect(await run("pacman --version")).toMatch(/Pacman v\d/);
  }, 60_000);

  it("carries every catalog package and every baked harness, and they run", async () => {
    const found = await run(
      `for c in ${COMMANDS.join(" ")}; do command -v "$c" >/dev/null || echo "missing $c"; done; echo checked`,
    );
    expect(found.trim()).toBe("checked");

    const versions = await run(
      "codex --version && claude --version && opencode --version && pi --version && bun --version",
    );
    expect(versions).toContain(HARNESS_VERSIONS.codex);
    expect(versions).toContain(HARNESS_VERSIONS["claude-code"]);
    expect(versions).toContain(HARNESS_VERSIONS.opencode);
    expect(versions).toContain(HARNESS_VERSIONS.pi);
  }, 120_000);

  it("has no login password on root, no default user, and no board kernel", async () => {
    const shadow = await run("grep '^root:' /etc/shadow | cut -d: -f2");
    expect(shadow.trim()).toMatch(/^[*!]/);
    expect(await run("getent passwd alarm || echo none")).toBe("none\n");
    expect(
      await run("pacman -Qq | grep -E '^(linux-aarch64|linux-firmware|mkinitcpio)$' || echo none"),
    ).toBe("none\n");
  }, 60_000);
});
