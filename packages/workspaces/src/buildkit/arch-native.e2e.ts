/**
 * An Arch workspace image builds and runs natively on the Docker daemon's own architecture: from
 * Docker Hub's `archlinux` on amd64, from Arch Linux ARM's verified rootfs on arm64 (CI runs this
 * on both). The image carries every package in the catalog and every baked harness, so a package
 * Arch Linux ARM lacks, or a harness without an arm64 build, fails it. Started as an executor
 * starts it, `sealantd boot` is PID 1, and a person made the way prepare makes one runs a harness
 * and reaches root through `sudo` only.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { NewWorkspace, WorkspaceImagePlatform } from "@sealant/validators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HARNESS_VERSIONS } from "../harness/integrations.js";
import { ARCHLINUXARM_MIRRORLIST } from "./archlinuxarm.js";
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

/** One command per catalog entry, by the name it installs (`fonts-dejavu` installs fonts only). */
const COMMANDS = [
  "bash",
  "bat",
  "bun",
  "bunx",
  "bwrap",
  "chezmoi",
  "chromium",
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
  "openbox",
  "pnpm",
  "python3",
  "rg",
  "starship",
  "stow",
  "tar",
  "tmux",
  "unzip",
  "uv",
  "vncpasswd",
  "Xvnc",
  "xauth",
  "xdpyinfo",
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
      `for c in ${COMMANDS.join(" ")}; do command -v "$c" >/dev/null || echo "missing $c"; done; [ -f /usr/share/fonts/TTF/DejaVuSans.ttf ] || echo "missing DejaVuSans"; echo checked`,
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

  it("boots sealantd as PID 1, and a person runs a harness and reaches root through sudo only", async () => {
    const repo = await mkdtemp(join(tmpdir(), "sealant-arch-native-repo-"));
    await execFileAsync("git", ["init", "-q", repo]);
    const { stdout } = await docker("docker", [
      "run",
      "-d",
      "--rm",
      "-e",
      "SEALANT_WORKSPACE_REPO_URL=https://example.invalid/skipped.git",
      "-e",
      "SEALANT_WORKSPACE_REPO_REF=main",
      "-v",
      `${repo}:/workspace/repo`,
      imageReference,
    ]);
    const container = stdout.trim();
    const exec = async (script: string) =>
      (await docker("docker", ["exec", container, "/bin/bash", "-c", script])).stdout;
    try {
      // Ready when its control socket is: the daemon booted the workspace.
      await exec(
        "i=0; while [ ! -S /run/sealant/control.sock ]; do i=$((i+1)); [ $i -gt 600 ] && exit 1; sleep 0.1; done",
      ).catch(async (error: unknown) => {
        const logs = await docker("docker", ["logs", container]).catch(() => ({
          stdout: "",
          stderr: "",
        }));
        throw new Error(`sealantd did not boot: ${String(error)}\n${logs.stdout}${logs.stderr}`);
      });
      expect((await exec("cat /proc/1/comm")).trim()).toBe("sealantd");

      const out = await exec(
        [
          "set -u",
          // A person as prepare makes one: a uid from the reserved range, in the mend group.
          "useradd -u 40001 -g mend -m -s /bin/bash p1",
          "sudo -u p1 -H bash -lc 'id -un; codex --version; claude --version; opencode --version; pi --version'",
          "sudo -u p1 -H sudo -n true && echo sudo=ok",
          // su through a terminal, fed (once it prompts) the password the rootfs ships root with.
          "command -v script >/dev/null && command -v su >/dev/null || { echo tools=missing; exit 1; }",
          "if (sleep 1; printf 'root\\n') | sudo -u p1 script -qec 'su -c true root' /dev/null >/dev/null 2>&1; then echo su-root=allowed; else echo su-root=refused; fi",
          // The same path with a password that is right succeeds, so the refusal above is real.
          "echo 'p1:person-pw' | chpasswd",
          "if (sleep 1; printf 'person-pw\\n') | sudo -u p1 script -qec 'su -c true p1' /dev/null >/dev/null 2>&1; then echo su-control=ok; else echo su-control=failed; fi",
        ].join("\n"),
      );
      expect(out).toMatch(/^p1$/m);
      expect(out).toContain(HARNESS_VERSIONS.codex);
      expect(out).toContain(HARNESS_VERSIONS["claude-code"]);
      expect(out).toContain(HARNESS_VERSIONS.opencode);
      expect(out).toContain(HARNESS_VERSIONS.pi);
      expect(out).toContain("sudo=ok");
      expect(out).toContain("su-control=ok");
      expect(out).toContain("su-root=refused");
    } finally {
      await docker("docker", ["rm", "-f", container]).catch(() => undefined);
      await rm(repo, { recursive: true, force: true });
    }
  }, 180_000);

  it("installs from the measured Arch Linux ARM mirrors in a workspace, the geo redirector last", async () => {
    if (platform !== "linux/arm64") return;
    expect(await run("cat /etc/pacman.d/mirrorlist")).toBe(ARCHLINUXARM_MIRRORLIST);
    // What `pacman -S` in a workspace does: sync every database, then fetch from the first mirror.
    const url = await run("pacman -Sy --noconfirm >/dev/null && pacman -Sp --noconfirm ripgrep");
    expect(url.trim()).toMatch(/^http:\/\/dk\.mirror\.archlinuxarm\.org\/aarch64\/extra\/ripgrep-/);
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
