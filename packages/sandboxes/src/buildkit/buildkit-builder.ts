import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  parseSandboxBlueprint,
  parseBuildkitOsBuilderCompileInput,
  parseBuildkitOsBuilderCompileResult,
  parseOsBuilderSupport,
  type BuildkitBuildSpec,
  type BuildkitOsBuilderCompileResult,
  type BuildkitPackageManager,
  type BuildkitTargetOsFamily,
  type OsBuilderSupport,
  type ResolvedImagePackage,
  type ResolvedImagePlan,
  type SandboxBlueprint,
} from "@sealant/validators";

import { getHarnessIntegration, type HarnessIntegration } from "../harness/integrations.js";

/**
 * This module contains the full BuildKit-backed executor implementation used by worker-side build
 * orchestration.
 *
 * Design notes:
 * - We keep all BuildKit and distro-specific logic in this package to avoid leaking container build
 *   concerns into `@sealant/workspace-composition` contracts.
 * - We return parsed/validated contract objects at boundaries so downstream consumers receive a
 *   stable shape even if internals evolve.
 * - We generate script and Dockerfile content as strings rather than template files so compile
 *   behavior can remain deterministic and easy to test with snapshot-like string assertions.
 */

/** Captured output from a command invocation used during image build/save steps. */
export interface BuildkitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Optional execution settings passed to the command runner. */
export interface BuildkitCommandOptions {
  readonly cwd?: string;
}

/**
 * Injectable command runner abstraction.
 *
 * We keep this injectable for two reasons:
 * - deterministic tests can avoid spawning Docker by stubbing this function
 * - production callers can still rely on the default runner with BuildKit enabled
 */
export type BuildkitCommandRunner = (
  command: string,
  args: string[],
  options?: BuildkitCommandOptions,
) => Promise<BuildkitCommandResult>;

export interface BuildkitCompilerOptions {
  readonly commandRunner?: BuildkitCommandRunner;
  readonly autoOsFamilyOrder?: readonly BuildkitTargetOsFamily[];
}

/** Maps a logical package request id to concrete distro packages to install. */
interface PackageMapping {
  readonly installPackages: readonly string[];
}

/**
 * Per-distro behavior contract used by planning and rendering.
 *
 * `shellPaths` and `sshdPath` are explicit so entrypoint and SSH templates do not rely on
 * assumptions that only hold for one distro family.
 */
interface DistroDefinition {
  readonly baseImage: string;
  readonly packageManager: BuildkitPackageManager;
  readonly packageMap: Record<string, PackageMapping>;
  readonly internalPackages: readonly string[];
  /**
   * Distro-native package ids installed only when the sealantd runtime daemon is enabled.
   *
   * sealantd reaches its control socket over a `docker exec` relay that needs `socat`; no base
   * image ships it, so we install it per-distro. Kept separate from `internalPackages` so the
   * `enableSealantd === false` build path renders byte-identically to before.
   */
  readonly sealantdPackages: readonly string[];
  readonly shellPaths: Record<"bash" | "zsh" | "fish", string>;
  readonly sshdPath: string;
}

/**
 * Default process runner for Docker commands.
 *
 * Behavior invariants:
 * - forces `DOCKER_BUILDKIT=1` to activate BuildKit features (including secret mounts)
 * - buffers stdout/stderr for diagnostics and testing
 * - throws with a stable `code` (`buildkit-command-failed`) on non-zero exit or signal so callers
 *   can classify failures consistently
 */
const defaultCommandRunner: BuildkitCommandRunner = (command, args, options) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: {
        ...process.env,
        DOCKER_BUILDKIT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: string | Buffer) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk: string | Buffer) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (signal !== null) {
        const error = new Error(
          `BuildKit command exited via signal ${signal}: ${command} ${args.join(" ")}`,
        ) as Error & { code: string };
        error.code = "buildkit-command-failed";
        reject(error);
        return;
      }

      if (code !== 0) {
        const error = new Error(
          `BuildKit command failed with exit ${code ?? "unknown"}: ${command} ${args.join(" ")}\n${stderr || stdout}`,
        ) as Error & { code: string };
        error.code = "buildkit-command-failed";
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
};

/**
 * Central distro catalog.
 *
 * This table controls almost all platform-specific differences in compile output:
 * - base image selection
 * - package manager command style
 * - symbolic package id mapping
 * - shell and sshd binary paths used by rendered scripts
 *
 * When adding a new distro, this object is the first place to update.
 */
const distroDefinitions: Record<BuildkitTargetOsFamily, DistroDefinition> = {
  fedora: {
    baseImage: "fedora:41",
    packageManager: "dnf",
    packageMap: {
      bash: { installPackages: ["bash"] },
      curl: { installPackages: ["curl"] },
      fish: { installPackages: ["fish"] },
      git: { installPackages: ["git"] },
      jq: { installPackages: ["jq"] },
      neovim: { installPackages: ["neovim"] },
      nodejs: { installPackages: ["nodejs", "npm"] },
      pnpm: { installPackages: ["nodejs", "npm", "pnpm"] },
      ripgrep: { installPackages: ["ripgrep"] },
      stow: { installPackages: ["stow"] },
      tmux: { installPackages: ["tmux"] },
      zsh: { installPackages: ["zsh"] },
    },
    internalPackages: [
      "bash",
      "ca-certificates",
      "coreutils",
      "git",
      "openssh-clients",
      "openssh-server",
      "shadow-utils",
    ],
    sealantdPackages: ["socat"],
    shellPaths: {
      bash: "/bin/bash",
      zsh: "/usr/bin/zsh",
      fish: "/usr/bin/fish",
    },
    sshdPath: "/usr/sbin/sshd",
  },
  arch: {
    baseImage: "archlinux:latest",
    packageManager: "pacman",
    packageMap: {
      bash: { installPackages: ["bash"] },
      curl: { installPackages: ["curl"] },
      fish: { installPackages: ["fish"] },
      git: { installPackages: ["git"] },
      jq: { installPackages: ["jq"] },
      neovim: { installPackages: ["neovim"] },
      nodejs: { installPackages: ["nodejs", "npm"] },
      pnpm: { installPackages: ["nodejs", "npm", "pnpm"] },
      ripgrep: { installPackages: ["ripgrep"] },
      stow: { installPackages: ["stow"] },
      tmux: { installPackages: ["tmux"] },
      zsh: { installPackages: ["zsh"] },
    },
    internalPackages: ["bash", "ca-certificates", "coreutils", "git", "openssh", "shadow"],
    sealantdPackages: ["socat"],
    shellPaths: {
      bash: "/bin/bash",
      zsh: "/usr/bin/zsh",
      fish: "/usr/bin/fish",
    },
    sshdPath: "/usr/sbin/sshd",
  },
  nix: {
    baseImage: "nixos/nix:latest",
    packageManager: "nix",
    packageMap: {
      bash: { installPackages: ["bash"] },
      curl: { installPackages: ["curl"] },
      fish: { installPackages: ["fish"] },
      git: { installPackages: ["gitMinimal"] },
      jq: { installPackages: ["jq"] },
      neovim: { installPackages: ["neovim"] },
      nodejs: { installPackages: ["nodejs"] },
      pnpm: { installPackages: ["nodejs", "pnpm"] },
      ripgrep: { installPackages: ["ripgrep"] },
      stow: { installPackages: ["stow"] },
      tmux: { installPackages: ["tmux"] },
      zsh: { installPackages: ["zsh"] },
    },
    internalPackages: ["bash", "cacert", "coreutils", "gitMinimal", "openssh", "shadow"],
    sealantdPackages: ["socat"],
    shellPaths: {
      bash: "/root/.nix-profile/bin/bash",
      zsh: "/root/.nix-profile/bin/zsh",
      fish: "/root/.nix-profile/bin/fish",
    },
    sshdPath: "/root/.nix-profile/bin/sshd",
  },
};

/**
 * Computes artifact/image naming used across metadata and OCI artifacts.
 *
 * Keeping this naming centralized prevents subtle drift between the image reference, default
 * artifact name, and metadata artifact names.
 */
const defaultImageNameForBlueprint = (
  blueprint: SandboxBlueprint,
  osFamily: BuildkitTargetOsFamily,
): string => {
  return `sealant-sandbox-${osFamily}-${blueprint.harness.id}`;
};

/**
 * Shell-quotes arbitrary values for safe interpolation into generated shell scripts.
 *
 * We prefer this dedicated helper over ad-hoc quoting to reduce the chance of malformed commands
 * when user-provided values include spaces or quotes.
 */
const shellQuote = (value: string): string => {
  return `'${value.split("'").join(`'"'"'`)}'`;
};

/**
 * Special authRef namespace indicating that dotfiles auth should be deferred to runtime and resolved
 * through a GitHub installation repository token path.
 */
const gitHubInstallationRepositoryAuthRefPrefix = "github-installation-repository:";

/**
 * Parses the installation repository id out of a special authRef.
 *
 * Returns `undefined` for any non-matching or empty payload value to keep downstream branching
 * simple (`undefined` means "treat as regular/non-installation auth").
 */
const parseGitHubInstallationRepositoryAuthRef = (
  authRef: string | undefined,
): string | undefined => {
  if (
    authRef === undefined ||
    !authRef.startsWith(gitHubInstallationRepositoryAuthRefPrefix) ||
    authRef.length <= gitHubInstallationRepositoryAuthRefPrefix.length
  ) {
    return undefined;
  }

  return authRef.slice(gitHubInstallationRepositoryAuthRefPrefix.length);
};

/**
 * Removes duplicates while preserving first-seen order.
 *
 * We preserve order intentionally so package install commands remain deterministic and easy to debug
 * (and test) while still eliminating redundant package names.
 */
const normalizeInstallPackages = (packages: Iterable<string>): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const pkg of packages) {
    if (seen.has(pkg)) {
      continue;
    }

    seen.add(pkg);
    normalized.push(pkg);
  }

  return normalized;
};

const getDotfilesSource = (blueprint: SandboxBlueprint) => {
  return blueprint.sources.inputs.find((input) => input.purpose === "dotfiles");
};

const createBuildkitCompilerError = (code: string, message: string) => {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
};

const getBuildkitSupportForOs = (
  blueprint: SandboxBlueprint,
  osFamily: BuildkitTargetOsFamily,
): OsBuilderSupport => {
  const requestedOsFamily = blueprint.target.os.family;
  if (requestedOsFamily !== "auto" && requestedOsFamily !== osFamily) {
    return parseOsBuilderSupport({
      supported: false,
      reason: "unsupported-os",
      message: `The ${osFamily} BuildKit compiler only supports target.os.family of auto or ${osFamily}.`,
    });
  }

  const harnessIntegration = getHarnessIntegration(blueprint.harness.id);
  if (harnessIntegration === undefined) {
    return parseOsBuilderSupport({
      supported: false,
      reason: "unsupported-harness",
      message: `No AI harness integration is registered for '${blueprint.harness.id}'.`,
    });
  }

  for (const pkg of blueprint.tooling.packages) {
    if (pkg.version !== undefined) {
      return parseOsBuilderSupport({
        supported: false,
        reason: "unsupported-package",
        message: `The ${osFamily} BuildKit compiler does not support package version pinning yet: ${pkg.id}.`,
      });
    }
  }

  const unsupportedInput = blueprint.sources.inputs.find((input) => input.purpose !== "dotfiles");
  if (unsupportedInput !== undefined) {
    return parseOsBuilderSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: `The ${osFamily} BuildKit compiler currently supports only dotfiles input sources, received '${unsupportedInput.purpose}'.`,
    });
  }

  const dotfilesInputs = blueprint.sources.inputs.filter((input) => input.purpose === "dotfiles");
  if (dotfilesInputs.length > 1) {
    return parseOsBuilderSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: `The ${osFamily} BuildKit compiler currently supports only one dotfiles input source.`,
    });
  }

  return parseOsBuilderSupport({ supported: true });
};

const defaultAutoOsFamilyOrder: readonly BuildkitTargetOsFamily[] = ["fedora", "arch", "nix"];

const resolveCandidateOsFamilies = (
  blueprint: SandboxBlueprint,
  autoOsFamilyOrder: readonly BuildkitTargetOsFamily[],
): readonly BuildkitTargetOsFamily[] => {
  if (blueprint.target.os.family === "auto") {
    return autoOsFamilyOrder;
  }

  return [blueprint.target.os.family];
};

export const selectBuildkitOsFamily = (input: {
  readonly blueprint: SandboxBlueprint;
  readonly autoOsFamilyOrder?: readonly BuildkitTargetOsFamily[];
}): BuildkitTargetOsFamily => {
  const autoOsFamilyOrder = input.autoOsFamilyOrder ?? defaultAutoOsFamilyOrder;
  const candidates = resolveCandidateOsFamilies(input.blueprint, autoOsFamilyOrder);

  let firstFailure: Exclude<OsBuilderSupport, { supported: true }> | undefined;

  for (const candidate of candidates) {
    const support = getBuildkitSupportForOs(input.blueprint, candidate);
    if (support.supported) {
      return candidate;
    }

    if (firstFailure === undefined) {
      firstFailure = support;
    }
  }

  if (firstFailure !== undefined) {
    throw createBuildkitCompilerError(firstFailure.reason, firstFailure.message);
  }

  throw createBuildkitCompilerError("unsupported-os", "No BuildKit target OS is available.");
};

const resolveHarnessIntegration = (blueprint: SandboxBlueprint): HarnessIntegration => {
  const integration = getHarnessIntegration(blueprint.harness.id);

  if (integration === undefined) {
    throw new Error(`No AI harness integration is registered for '${blueprint.harness.id}'.`);
  }

  return integration;
};

/**
 * Resolves all package requests into concrete install package names.
 *
 * Resolution order is important:
 * 1) user-requested tooling packages
 * 2) harness-required packages
 * 3) shell package for non-bash default shells
 * 4) dotfiles helper packages (`git` + manager-specific helpers)
 *
 * The returned list is not de-duplicated yet; de-duplication is performed later right before
 * renderer emission so all request intent remains visible in plan metadata.
 */
const resolvePackages = (
  blueprint: SandboxBlueprint,
  osFamily: BuildkitTargetOsFamily,
): ResolvedImagePackage[] => {
  const distro = distroDefinitions[osFamily];
  const harnessIntegration = resolveHarnessIntegration(blueprint);
  const harnessPackageRequests: SandboxBlueprint["tooling"]["packages"] =
    harnessIntegration.installPackages.map((id) => ({ id }));
  const requests: Array<SandboxBlueprint["tooling"]["packages"][number]> = [
    ...blueprint.tooling.packages,
    ...harnessPackageRequests,
  ];

  if (blueprint.customization.defaultShell !== "bash") {
    requests.push({ id: blueprint.customization.defaultShell });
  }

  if (blueprint.customization.applyDotfiles && getDotfilesSource(blueprint) !== undefined) {
    requests.push({ id: "git" });

    if (blueprint.customization.dotfilesManager === "auto") {
      requests.push({ id: "chezmoi" });
      requests.push({ id: "stow" });
    }

    if (blueprint.customization.dotfilesManager === "chezmoi") {
      requests.push({ id: "chezmoi" });
    }

    if (blueprint.customization.dotfilesManager === "stow") {
      requests.push({ id: "stow" });
    }
  }

  return requests.map((request) => {
    const mapping = distro.packageMap[request.id] ?? { installPackages: [request.id] };
    return {
      requestId: request.id,
      ...(request.version === undefined ? {} : { requestedVersion: request.version }),
      installPackages: [...mapping.installPackages],
    };
  });
};

/**
 * Core compile planning step.
 *
 * Produces a fully concrete `ResolvedImagePlan` that renderers can consume without additional policy
 * decisions.
 *
 * Security-sensitive decisions encoded here:
 * - build vs runtime secret phase assignment
 * - dotfiles apply phase (`build` vs `runtime`)
 * - GitHub installation repository routing for runtime dotfiles auth
 */
const mapBlueprintToResolvedImagePlan = (
  blueprint: SandboxBlueprint,
  osFamily: BuildkitTargetOsFamily,
): ResolvedImagePlan => {
  const support = getBuildkitSupportForOs(blueprint, osFamily);
  if (!support.supported) {
    throw new Error(support.message);
  }

  const dotfiles = getDotfilesSource(blueprint);
  const dotfilesGitHubInstallationRepositoryId = parseGitHubInstallationRepositoryAuthRef(
    dotfiles?.authRef,
  );
  const buildSecrets =
    dotfiles?.authRef === undefined || dotfilesGitHubInstallationRepositoryId !== undefined
      ? []
      : [
          {
            id: "dotfiles_git_key",
            kind: "ssh-key" as const,
            phase: "build" as const,
            sourceRef: dotfiles.authRef,
          },
        ];
  const runtimeSecrets =
    blueprint.sources.sandbox.authRef === undefined
      ? []
      : [
          {
            id: "sandbox_git_key",
            kind: "ssh-key" as const,
            phase: "runtime" as const,
            sourceRef: blueprint.sources.sandbox.authRef,
          },
        ];

  return {
    blueprint,
    osFamily,
    baseImage: distroDefinitions[osFamily].baseImage,
    packageManager: distroDefinitions[osFamily].packageManager,
    packages: resolvePackages(blueprint, osFamily),
    customization: blueprint.customization,
    ...(dotfiles === undefined || !blueprint.customization.applyDotfiles
      ? {}
      : {
          dotfiles: {
            sourceId: dotfiles.id,
            manager: blueprint.customization.dotfilesManager,
            url: dotfiles.url,
            ref: dotfiles.ref,
            target: blueprint.customization.dotfilesTarget,
            bootstrap: blueprint.customization.dotfilesBootstrap,
            ...(blueprint.customization.dotfilesBootstrapCommand === undefined
              ? {}
              : { bootstrapCommand: blueprint.customization.dotfilesBootstrapCommand }),
            applyAt: dotfilesGitHubInstallationRepositoryId === undefined ? "build" : "runtime",
            ...(dotfilesGitHubInstallationRepositoryId === undefined
              ? dotfiles.authRef === undefined
                ? {}
                : { authSecretId: "dotfiles_git_key" }
              : { githubInstallationRepositoryId: dotfilesGitHubInstallationRepositoryId }),
          },
        }),
    buildSecrets,
    runtimeSecrets,
    imageEnv: {},
    runtimeEnv: {
      ...blueprint.runtime.env,
    },
  };
};

/**
 * Renders distro-specific package installation commands.
 *
 * Output is a single Dockerfile `RUN` block per package manager family so cache behavior is easy to
 * reason about. Internal packages are always merged with resolved package requests.
 */
const renderPackageInstallCommand = (plan: ResolvedImagePlan): string => {
  const distro = distroDefinitions[plan.osFamily];
  const packageList = normalizeInstallPackages([
    ...distro.internalPackages,
    // `socat` (and any other relay deps) only when the sealantd runtime daemon is enabled, so the
    // disabled path produces the exact same package set as before.
    ...(plan.customization.enableSealantd === true ? distro.sealantdPackages : []),
    ...plan.packages.flatMap((pkg) => pkg.installPackages),
  ]);

  if (plan.packageManager === "dnf") {
    return [
      "RUN --mount=type=cache,target=/var/cache/dnf \\",
      "    dnf -y upgrade --refresh && \\",
      `    dnf -y install ${packageList.join(" ")} && \\`,
      "    dnf clean all",
    ].join("\n");
  }

  if (plan.packageManager === "pacman") {
    return [
      "RUN sed -i 's/^DownloadUser/#DownloadUser/' /etc/pacman.conf",
      "RUN --mount=type=cache,target=/var/cache/pacman/pkg \\",
      "    pacman -Syu --noconfirm && \\",
      `    pacman -S --noconfirm --needed ${packageList.join(" ")} && \\`,
      "    pacman -Scc --noconfirm || true",
    ].join("\n");
  }

  const nixPackageList = packageList.map((pkg) => shellQuote(`nixpkgs#${pkg}`));
  return [
    "RUN nix profile add --priority 6 --accept-flake-config --extra-experimental-features 'nix-command flakes' \\",
    `    ${nixPackageList.join(" ")} && \\`,
    "    nix --extra-experimental-features 'nix-command flakes' profile list > /dev/null",
  ].join("\n");
};

/**
 * Renders the harness install layer.
 *
 * Nix images rewrite plain `npm install -g ...` commands to include `--prefix /usr/local` to avoid
 * relying on npm global locations that can be awkward in nix-based containers.
 */
const renderHarnessInstallCommand = (plan: ResolvedImagePlan): string => {
  const harnessIntegration = resolveHarnessIntegration(plan.blueprint);
  if (plan.osFamily === "nix") {
    const npmInstallGlobalPattern = /^npm\s+install\s+-g\s+(.+)$/;
    const match = npmInstallGlobalPattern.exec(harnessIntegration.installCommand);
    if (match !== null) {
      return `RUN npm install -g --prefix /usr/local ${match[1]}`;
    }
  }

  return `RUN ${harnessIntegration.installCommand}`;
};

/**
 * Renders one lifecycle step as an isolated subshell block.
 *
 * We intentionally execute each step in a subshell so one step's `cd` or env mutations do not leak
 * into the next step unless explicitly encoded by the user command itself.
 */
const renderRuntimeStep = (
  step: SandboxBlueprint["lifecycle"]["setup"][number],
  defaultWorkingDirectory: string,
  bashShellPath: string,
): string => {
  const shell = step.shell === "sh" ? "/bin/sh" : bashShellPath;
  const workingDirectory = step.workingDirectory ?? defaultWorkingDirectory;
  return [
    "(",
    `  cd ${shellQuote(workingDirectory)}`,
    `  ${shell} -lc ${shellQuote(step.run)}`,
    ")",
  ].join("\n");
};

/**
 * Resolves the final foreground process command for the entrypoint script.
 *
 * If blueprint startup selects a literal command, it is executed with the requested shell.
 * Otherwise we launch the selected harness's canonical launch command in the configured default
 * shell.
 */
const renderForegroundCommand = (plan: ResolvedImagePlan): string => {
  const foreground = plan.blueprint.lifecycle.startup.foreground;
  if (foreground.kind === "command") {
    const shell =
      foreground.shell === "sh" ? "/bin/sh" : distroDefinitions[plan.osFamily].shellPaths.bash;
    const workingDirectory = foreground.workingDirectory ?? plan.blueprint.runtime.workingDirectory;
    return [
      `cd ${shellQuote(workingDirectory)}`,
      `exec ${shell} -lc ${shellQuote(foreground.run)}`,
    ].join("\n");
  }

  const harnessIntegration = resolveHarnessIntegration(plan.blueprint);
  const shellPath = distroDefinitions[plan.osFamily].shellPaths[plan.customization.defaultShell];

  return [
    `cd ${shellQuote(plan.blueprint.runtime.workingDirectory)}`,
    `exec ${shellPath} -lc ${shellQuote(harnessIntegration.launchCommand)}`,
  ].join("\n");
};

const renderSandboxEntrypoint = (plan: ResolvedImagePlan): string => {
  const loginShellPath =
    distroDefinitions[plan.osFamily].shellPaths[plan.customization.defaultShell];
  const bashShellPath = distroDefinitions[plan.osFamily].shellPaths.bash;
  const sshdPath = distroDefinitions[plan.osFamily].sshdPath;
  const setupSteps = plan.blueprint.lifecycle.setup
    .map((step) => renderRuntimeStep(step, plan.blueprint.runtime.workingDirectory, bashShellPath))
    .join("\n\n");
  const startupSteps = plan.blueprint.lifecycle.startup.steps
    .map((step) => renderRuntimeStep(step, plan.blueprint.runtime.workingDirectory, bashShellPath))
    .join("\n\n");

  return [
    `#!${bashShellPath}`,
    "set -euo pipefail",
    "",
    `SANDBOX_ROOT=${shellQuote(plan.blueprint.runtime.sandboxRoot)}`,
    `WORKING_DIRECTORY=${shellQuote(plan.blueprint.runtime.workingDirectory)}`,
    `SANDBOX_REPO_URL=${shellQuote(plan.blueprint.sources.sandbox.url)}`,
    `SANDBOX_REPO_REF=${shellQuote(plan.blueprint.sources.sandbox.ref)}`,
    `HARNESS_BANNER=${shellQuote(`Starting ${plan.blueprint.harness.id} sandbox`)}`,
    "SSH_RUNTIME_DIR=/sandbox/.ssh-runtime",
    "REPO_SSH_KEY_PATH=$SSH_RUNTIME_DIR/sandbox_repo_key",
    "REPO_GIT_ASKPASS_PATH=$SSH_RUNTIME_DIR/git-askpass",
    "",
    'mkdir -p "$SANDBOX_ROOT" "$WORKING_DIRECTORY" "$SSH_RUNTIME_DIR" /root /tmp /var/empty /run/sshd',
    "export HOME=/root",
    "export USER=root",
    "export LOGNAME=root",
    'export PATH="/usr/local/bin:$PATH"',
    'cd "$SANDBOX_ROOT"',
    "if [ ! -e /lib64/ld-linux-x86-64.so.2 ]; then",
    '  GLIBC_LOADER="$(ls /nix/store/*-glibc-*/lib/ld-linux-x86-64.so.2 2>/dev/null | head -n1 || true)"',
    '  if [ -n "$GLIBC_LOADER" ]; then',
    "    mkdir -p /lib64",
    '    ln -sf "$GLIBC_LOADER" /lib64/ld-linux-x86-64.so.2',
    "  fi",
    "fi",
    "",
    'if [ -n "${SEALANT_SANDBOX_AUTH_KEY_BASE64:-}" ]; then',
    '  printf \'%s\' "$SEALANT_SANDBOX_AUTH_KEY_BASE64" | base64 --decode > "$REPO_SSH_KEY_PATH"',
    '  chmod 600 "$REPO_SSH_KEY_PATH"',
    '  export GIT_SSH_COMMAND="ssh -i $REPO_SSH_KEY_PATH -o IdentitiesOnly=yes -o StrictHostKeyChecking=no"',
    "fi",
    "",
    'if [ -n "${SEALANT_SANDBOX_HTTP_TOKEN:-}" ]; then',
    "  cat > \"$REPO_GIT_ASKPASS_PATH\" <<'EOF'",
    "#!/bin/sh",
    'case "$1" in',
    '  *Username*) printf "%s\\n" "${SEALANT_SANDBOX_HTTP_USERNAME:-x-access-token}" ;;',
    '  *Password*) printf "%s\\n" "$SEALANT_SANDBOX_HTTP_TOKEN" ;;',
    '  *) printf "\\n" ;;',
    "esac",
    "EOF",
    '  chmod 700 "$REPO_GIT_ASKPASS_PATH"',
    '  export GIT_ASKPASS="$REPO_GIT_ASKPASS_PATH"',
    "  export GIT_TERMINAL_PROMPT=0",
    "fi",
    "",
    "cleanup_sandbox_clone_auth() {",
    '  rm -f "$REPO_SSH_KEY_PATH" "$REPO_GIT_ASKPASS_PATH"',
    "  unset GIT_SSH_COMMAND GIT_ASKPASS GIT_TERMINAL_PROMPT SEALANT_SANDBOX_HTTP_USERNAME SEALANT_SANDBOX_HTTP_TOKEN SEALANT_SANDBOX_AUTH_KEY_BASE64",
    "}",
    "",
    'if [ "${SEALANT_ENABLE_SSH:-0}" = "1" ] || [ "${SEALANT_ENABLE_SSH:-}" = "true" ]; then',
    '  SSH_PORT="${SEALANT_SSH_PORT:-2222}"',
    '  SSH_AUTHORIZED_KEYS_FILE="${SEALANT_SSH_AUTHORIZED_KEYS_FILE:-/run/keys/authorized_keys}"',
    "  if [ ! -w /etc/passwd ] || [ ! -w /etc/group ] || [ ! -w /etc/shadow ]; then",
    '    cp /etc/passwd "$SSH_RUNTIME_DIR/passwd.base"',
    '    cp /etc/group "$SSH_RUNTIME_DIR/group.base"',
    '    cp /etc/shadow "$SSH_RUNTIME_DIR/shadow.base"',
    "    rm -f /etc/passwd /etc/group /etc/shadow",
    '    cp "$SSH_RUNTIME_DIR/passwd.base" /etc/passwd',
    '    cp "$SSH_RUNTIME_DIR/group.base" /etc/group',
    '    cp "$SSH_RUNTIME_DIR/shadow.base" /etc/shadow',
    "    chmod 644 /etc/passwd /etc/group",
    "    chmod 600 /etc/shadow",
    "  fi",
    "  SHADOW_UPDATED=0",
    '  : > "$SSH_RUNTIME_DIR/shadow.updated"',
    "  while IFS= read -r line; do",
    '    case "$line" in',
    "      root:!*)",
    '        printf "root::%s\\n" "${line#root:!:}" >> "$SSH_RUNTIME_DIR/shadow.updated"',
    "        SHADOW_UPDATED=1",
    "        ;;",
    "      *)",
    '        printf "%s\\n" "$line" >> "$SSH_RUNTIME_DIR/shadow.updated"',
    "        ;;",
    "    esac",
    "  done < /etc/shadow",
    '  if [ "$SHADOW_UPDATED" = "1" ]; then',
    '    cat "$SSH_RUNTIME_DIR/shadow.updated" > /etc/shadow',
    "    chmod 600 /etc/shadow",
    "  fi",
    "  if ! id -u sshd >/dev/null 2>&1; then",
    "    printf '%s\n' 'sshd:x:74:' >> /etc/group",
    "    printf '%s\n' 'sshd:x:74:74:Privilege-separated SSH:/var/empty:/bin/sh' >> /etc/passwd",
    "  fi",
    "",
    '  if [ -n "${SEALANT_SSH_AUTHORIZED_KEYS_BASE64:-}" ]; then',
    '    printf \'%s\' "$SEALANT_SSH_AUTHORIZED_KEYS_BASE64" | base64 --decode > "$SSH_RUNTIME_DIR/authorized_keys.input"',
    '    chmod 600 "$SSH_RUNTIME_DIR/authorized_keys.input"',
    '    SSH_AUTHORIZED_KEYS_FILE="$SSH_RUNTIME_DIR/authorized_keys.input"',
    "  fi",
    "",
    '  if [ ! -f "$SSH_AUTHORIZED_KEYS_FILE" ]; then',
    "    printf '%s\n' \"SSH enabled but no authorized keys file found at $SSH_AUTHORIZED_KEYS_FILE\" >&2",
    "    exit 1",
    "  fi",
    "",
    '  install -m 600 "$SSH_AUTHORIZED_KEYS_FILE" "$SSH_RUNTIME_DIR/authorized_keys"',
    '  if [ ! -f "$SSH_RUNTIME_DIR/ssh_host_ed25519_key" ]; then',
    '    ssh-keygen -q -t ed25519 -N "" -f "$SSH_RUNTIME_DIR/ssh_host_ed25519_key"',
    "  fi",
    "",
    "  cat > /usr/local/bin/sandbox-ssh-shell <<'EOF'",
    `#!${bashShellPath}`,
    "set -euo pipefail",
    `WORKING_DIRECTORY=${shellQuote(plan.blueprint.runtime.workingDirectory)}`,
    `LOGIN_SHELL=${shellQuote(loginShellPath)}`,
    `BASH_SHELL=${shellQuote(bashShellPath)}`,
    'export PATH="/usr/local/bin:/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin:$PATH"',
    'if [ ! -x "$LOGIN_SHELL" ]; then',
    `  LOGIN_SHELL=${shellQuote(bashShellPath)}`,
    "fi",
    'if [ ! -x "$BASH_SHELL" ]; then',
    '  BASH_SHELL="$LOGIN_SHELL"',
    "fi",
    'if [ -d "$WORKING_DIRECTORY" ]; then',
    '  cd "$WORKING_DIRECTORY"',
    "fi",
    'if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then',
    '  exec "$BASH_SHELL" -c "$SSH_ORIGINAL_COMMAND"',
    "fi",
    "if [ ! -t 0 ] || [ ! -t 1 ]; then",
    '  exec "$BASH_SHELL" --noprofile --norc -s',
    "fi",
    'if [ "${SEALANT_OCI_RUNTIME:-runc}" = "runsc" ]; then',
    '  exec "$BASH_SHELL" -i',
    "fi",
    'exec "$LOGIN_SHELL" -i',
    "EOF",
    "",
    "  chmod 755 /usr/local/bin/sandbox-ssh-shell",
    "",
    '  cat > "$SSH_RUNTIME_DIR/sshd_config" <<EOF',
    "Port $SSH_PORT",
    "ListenAddress 0.0.0.0",
    "HostKey $SSH_RUNTIME_DIR/ssh_host_ed25519_key",
    "AuthorizedKeysFile $SSH_RUNTIME_DIR/authorized_keys",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "ChallengeResponseAuthentication no",
    "PubkeyAuthentication yes",
    "PermitRootLogin yes",
    "PermitEmptyPasswords no",
    "UsePAM no",
    "PidFile $SSH_RUNTIME_DIR/sshd.pid",
    "PrintMotd no",
    "StrictModes yes",
    "ForceCommand /usr/local/bin/sandbox-ssh-shell",
    "Subsystem sftp internal-sftp",
    "EOF",
    "",
    `  ${sshdPath} -f "$SSH_RUNTIME_DIR/sshd_config" -E "$SSH_RUNTIME_DIR/sshd.log"`,
    "  printf '%s\n' \"SSH server listening on port $SSH_PORT\"",
    "fi",
    "",
    "printf '%s\n' \"$HARNESS_BANNER\"",
    "",
    'mkdir -p "$(dirname "$WORKING_DIRECTORY")"',
    'if [ ! -d "$WORKING_DIRECTORY/.git" ]; then',
    '  rm -rf "$WORKING_DIRECTORY"',
    '  git clone --branch "$SANDBOX_REPO_REF" "$SANDBOX_REPO_URL" "$WORKING_DIRECTORY"',
    "fi",
    "cleanup_sandbox_clone_auth",
    "",
    // Runtime dotfiles apply block is only injected when planning decided on `applyAt: runtime`.
    // This keeps build-time images free of dynamic runtime token requirements unless explicitly
    // needed for GitHub installation-backed dotfiles auth.
    ...(plan.dotfiles === undefined || plan.dotfiles.applyAt !== "runtime"
      ? []
      : [
          `DOTFILES_REPO_URL=${shellQuote(plan.dotfiles.url)}`,
          `DOTFILES_REPO_REF=${shellQuote(plan.dotfiles.ref)}`,
          `DOTFILES_GITHUB_INSTALLATION_REPOSITORY_ID=${shellQuote(plan.dotfiles.githubInstallationRepositoryId ?? "")}`,
          `DOTFILES_MANAGER=${shellQuote(plan.dotfiles.manager)}`,
          `DOTFILES_TARGET=${shellQuote(plan.dotfiles.target)}`,
          `DOTFILES_BOOTSTRAP=${shellQuote(plan.dotfiles.bootstrap ? "1" : "0")}`,
          `DOTFILES_BOOTSTRAP_COMMAND=${shellQuote(plan.dotfiles.bootstrapCommand ?? "./install.sh")}`,
          'DOTFILES_SOURCE_DIR="/root/.local/share/chezmoi"',
          'DOTFILES_TARGET_DIR="$HOME"',
          'DOTFILES_GIT_ASKPASS_PATH="$SSH_RUNTIME_DIR/dotfiles-git-askpass"',
          'if [ "$DOTFILES_TARGET" = "config" ]; then',
          '  DOTFILES_TARGET_DIR="$HOME/.config"',
          "fi",
          'if [ -n "$DOTFILES_GITHUB_INSTALLATION_REPOSITORY_ID" ] && [ -z "${SEALANT_DOTFILES_HTTP_TOKEN:-}" ]; then',
          `  printf '%s\n' "Dotfiles repo auth token is missing for GitHub installation repository $DOTFILES_GITHUB_INSTALLATION_REPOSITORY_ID." >&2`,
          "  exit 1",
          "fi",
          'if [ -n "${SEALANT_DOTFILES_HTTP_TOKEN:-}" ]; then',
          "  cat > \"$DOTFILES_GIT_ASKPASS_PATH\" <<'EOF'",
          "#!/bin/sh",
          'case "$1" in',
          '  *Username*) printf "%s\\n" "${SEALANT_DOTFILES_HTTP_USERNAME:-x-access-token}" ;;',
          '  *Password*) printf "%s\\n" "$SEALANT_DOTFILES_HTTP_TOKEN" ;;',
          '  *) printf "\\n" ;;',
          "esac",
          "EOF",
          '  chmod 700 "$DOTFILES_GIT_ASKPASS_PATH"',
          '  export GIT_ASKPASS="$DOTFILES_GIT_ASKPASS_PATH"',
          "  export GIT_TERMINAL_PROMPT=0",
          "fi",
          'mkdir -p "$(dirname "$DOTFILES_SOURCE_DIR")"',
          'rm -rf "$DOTFILES_SOURCE_DIR"',
          'git clone --depth=1 --branch "$DOTFILES_REPO_REF" "$DOTFILES_REPO_URL" "$DOTFILES_SOURCE_DIR"',
          'if [ "$DOTFILES_MANAGER" = "auto" ]; then',
          '  if [ -f "$DOTFILES_SOURCE_DIR/.chezmoi.toml" ] || [ -f "$DOTFILES_SOURCE_DIR/.chezmoi.yaml" ] || [ -f "$DOTFILES_SOURCE_DIR/.chezmoi.json" ] || [ -f "$DOTFILES_SOURCE_DIR/.chezmoiexternal.toml" ] || ls "$DOTFILES_SOURCE_DIR"/dot_* >/dev/null 2>&1; then',
          '    DOTFILES_MANAGER="chezmoi"',
          '  elif [ -f "$DOTFILES_SOURCE_DIR/.stow-global-ignore" ] || [ -f "$DOTFILES_SOURCE_DIR/install.sh" ]; then',
          '    DOTFILES_MANAGER="stow"',
          "  else",
          '    DOTFILES_MANAGER="copy"',
          "  fi",
          "fi",
          'if [ "$DOTFILES_MANAGER" != "copy" ]; then',
          '  DOTFILES_TARGET_DIR="$HOME"',
          "fi",
          'case "$DOTFILES_MANAGER" in',
          "  chezmoi)",
          '    HOME=/root chezmoi init --source="$DOTFILES_SOURCE_DIR"',
          "    HOME=/root chezmoi apply",
          "    ;;",
          "  stow)",
          '    if [ "$DOTFILES_BOOTSTRAP" = "1" ]; then',
          '      ( cd "$DOTFILES_SOURCE_DIR" && /bin/bash -lc "$DOTFILES_BOOTSTRAP_COMMAND" )',
          "    else",
          '      DOTFILES_STOW_PACKAGES=""',
          '      for package_dir in "$DOTFILES_SOURCE_DIR"/*; do',
          '        [ -d "$package_dir" ] || continue',
          '        package_name="$(basename "$package_dir")"',
          '        case "$package_name" in .* ) continue ;; esac',
          '        DOTFILES_STOW_PACKAGES="$DOTFILES_STOW_PACKAGES $package_name"',
          "      done",
          '      if [ -n "$DOTFILES_STOW_PACKAGES" ]; then',
          '        ( cd "$DOTFILES_SOURCE_DIR" && stow -t "$DOTFILES_TARGET_DIR" $DOTFILES_STOW_PACKAGES )',
          "      fi",
          "    fi",
          "    ;;",
          "  copy)",
          '    mkdir -p "$DOTFILES_TARGET_DIR"',
          '    ( cd "$DOTFILES_SOURCE_DIR" && tar --exclude=.git -cf - . ) | ( cd "$DOTFILES_TARGET_DIR" && tar -xf - )',
          "    ;;",
          "  *)",
          '    printf "%s\\n" "Unsupported dotfiles manager: $DOTFILES_MANAGER" >&2',
          "    exit 1",
          "    ;;",
          "esac",
          'rm -f "$DOTFILES_GIT_ASKPASS_PATH"',
          "unset GIT_ASKPASS GIT_TERMINAL_PROMPT SEALANT_DOTFILES_HTTP_USERNAME SEALANT_DOTFILES_HTTP_TOKEN DOTFILES_MANAGER DOTFILES_TARGET DOTFILES_BOOTSTRAP DOTFILES_BOOTSTRAP_COMMAND DOTFILES_TARGET_DIR",
          "",
        ]),
    ...(setupSteps.length === 0 ? [] : [setupSteps, ""]),
    ...(startupSteps.length === 0 ? [] : [startupSteps, ""]),
    // The sealantd runtime daemon is launched in the background before the foreground workload so
    // it owns its own lifecycle without blocking the harness. A runtime override
    // (`SEALANT_ENABLE_SEALANTD=0|false`) can suppress the launch even in a sealantd-enabled image.
    // SEALANTD_PID is pre-declared so the EXIT trap is `set -u`-safe when launch is skipped.
    ...(plan.customization.enableSealantd === true
      ? [
          'SEALANTD_PID=""',
          "cleanup_sealantd() {",
          '  if [ -n "$SEALANTD_PID" ]; then',
          '    kill "$SEALANTD_PID" 2>/dev/null || true',
          '    wait "$SEALANTD_PID" 2>/dev/null || true',
          "  fi",
          "}",
          "trap cleanup_sealantd EXIT INT TERM",
          'if [ "${SEALANT_ENABLE_SEALANTD:-1}" != "0" ] && [ "${SEALANT_ENABLE_SEALANTD:-1}" != "false" ]; then',
          "  mkdir -p /run/sealant",
          '  sealantd --socket /run/sealant/control.sock --workspace "$WORKING_DIRECTORY" &',
          "  SEALANTD_PID=$!",
          '  printf \'%s\\n\' "sealantd started (pid $SEALANTD_PID)"',
          "fi",
          "",
        ]
      : []),
    'if [ -n "${SEALANT_FOREGROUND_COMMAND:-}" ]; then',
    `  exec ${bashShellPath} -lc "$SEALANT_FOREGROUND_COMMAND"`,
    "fi",
    "",
    renderForegroundCommand(plan),
    "",
  ].join("\n");
};

/**
 * Renders the optional Dockerfile layer that applies dotfiles during image build.
 *
 * This is used only when `plan.dotfiles.applyAt === "build"`. Runtime apply uses entrypoint logic
 * instead so auth can be supplied at launch time.
 */
const renderDotfilesStep = (plan: ResolvedImagePlan): string | undefined => {
  if (plan.dotfiles === undefined || plan.dotfiles.applyAt !== "build") {
    return undefined;
  }

  const sourceParentDirectory = "/root/.local/share";
  const sourceDirectory = "/root/.local/share/chezmoi";
  const targetDirectory = plan.dotfiles.target === "config" ? "/root/.config" : "/root";
  const applyCommand = [
    `DOTFILES_MANAGER=${shellQuote(plan.dotfiles.manager)}`,
    `DOTFILES_TARGET=${shellQuote(plan.dotfiles.target)}`,
    `DOTFILES_BOOTSTRAP=${shellQuote(plan.dotfiles.bootstrap ? "1" : "0")}`,
    `DOTFILES_BOOTSTRAP_COMMAND=${shellQuote(plan.dotfiles.bootstrapCommand ?? "./install.sh")}`,
    `DOTFILES_SOURCE_DIR=${shellQuote(sourceDirectory)}`,
    `DOTFILES_TARGET_DIR=${shellQuote(targetDirectory)}`,
    'if [ "$DOTFILES_MANAGER" = "auto" ]; then',
    '  if [ -f "$DOTFILES_SOURCE_DIR/.chezmoi.toml" ] || [ -f "$DOTFILES_SOURCE_DIR/.chezmoi.yaml" ] || [ -f "$DOTFILES_SOURCE_DIR/.chezmoi.json" ] || [ -f "$DOTFILES_SOURCE_DIR/.chezmoiexternal.toml" ] || ls "$DOTFILES_SOURCE_DIR"/dot_* >/dev/null 2>&1; then',
    '    DOTFILES_MANAGER="chezmoi"',
    '  elif [ -f "$DOTFILES_SOURCE_DIR/.stow-global-ignore" ] || [ -f "$DOTFILES_SOURCE_DIR/install.sh" ]; then',
    '    DOTFILES_MANAGER="stow"',
    "  else",
    '    DOTFILES_MANAGER="copy"',
    "  fi",
    "fi",
    'if [ "$DOTFILES_MANAGER" != "copy" ]; then',
    '  DOTFILES_TARGET_DIR="/root"',
    "fi",
    'case "$DOTFILES_MANAGER" in',
    "  chezmoi)",
    '    HOME=/root chezmoi init --source="$DOTFILES_SOURCE_DIR"',
    "    HOME=/root chezmoi apply",
    "    ;;",
    "  stow)",
    '    if [ "$DOTFILES_BOOTSTRAP" = "1" ]; then',
    '      ( cd "$DOTFILES_SOURCE_DIR" && /bin/bash -lc "$DOTFILES_BOOTSTRAP_COMMAND" )',
    "    else",
    '      DOTFILES_STOW_PACKAGES=""',
    '      for package_dir in "$DOTFILES_SOURCE_DIR"/*; do',
    '        [ -d "$package_dir" ] || continue',
    '        package_name="$(basename "$package_dir")"',
    '        case "$package_name" in .* ) continue ;; esac',
    '        DOTFILES_STOW_PACKAGES="$DOTFILES_STOW_PACKAGES $package_name"',
    "      done",
    '      if [ -n "$DOTFILES_STOW_PACKAGES" ]; then',
    '        ( cd "$DOTFILES_SOURCE_DIR" && stow -t "$DOTFILES_TARGET_DIR" $DOTFILES_STOW_PACKAGES )',
    "      fi",
    "    fi",
    "    ;;",
    "  copy)",
    '    mkdir -p "$DOTFILES_TARGET_DIR"',
    '    ( cd "$DOTFILES_SOURCE_DIR" && tar --exclude=.git -cf - . ) | ( cd "$DOTFILES_TARGET_DIR" && tar -xf - )',
    "    ;;",
    "  *)",
    '    printf "%s\\n" "Unsupported dotfiles manager: $DOTFILES_MANAGER" >&2',
    "    exit 1",
    "    ;;",
    "esac",
  ].join("\n");

  const cloneCommand =
    plan.dotfiles.authSecretId === undefined
      ? [
          `mkdir -p ${shellQuote(sourceParentDirectory)}`,
          `rm -rf ${shellQuote(sourceDirectory)}`,
          `git clone --depth=1 --branch ${shellQuote(plan.dotfiles.ref)} ${shellQuote(plan.dotfiles.url)} ${shellQuote(sourceDirectory)}`,
          `/bin/bash -lc ${shellQuote(applyCommand)}`,
        ].join(" && ")
      : [
          `mkdir -p ${shellQuote(sourceParentDirectory)}`,
          `rm -rf ${shellQuote(sourceDirectory)}`,
          `GIT_SSH_COMMAND='ssh -i /run/sealant/dotfiles_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=no' git clone --depth=1 --branch ${shellQuote(plan.dotfiles.ref)} ${shellQuote(plan.dotfiles.url)} ${shellQuote(sourceDirectory)}`,
          `/bin/bash -lc ${shellQuote(applyCommand)}`,
        ].join(" && ");
  const mountPrefix =
    plan.dotfiles.authSecretId === undefined
      ? "RUN "
      : "RUN --mount=type=secret,id=dotfiles_git_key,target=/run/sealant/dotfiles_key,required=true \\\n    ";

  return `${mountPrefix}${cloneCommand}`;
};

/**
 * Renders the full Containerfile used for Docker build.
 *
 * Ordering is intentional:
 * - package and harness installs before entrypoint copy to maximize layer cache reuse
 * - shell configuration before runtime start
 * - optional dotfiles build step near the end because it can be highly variable
 */
const renderContainerfile = (plan: ResolvedImagePlan): string => {
  const distro = distroDefinitions[plan.osFamily];
  const shellPath = distro.shellPaths[plan.customization.defaultShell];
  const dotfilesStep = renderDotfilesStep(plan);
  const harnessInstallStep = renderHarnessInstallCommand(plan);

  return [
    "# syntax=docker/dockerfile:1.7",
    `FROM ${plan.baseImage}`,
    "",
    renderPackageInstallCommand(plan),
    "",
    harnessInstallStep,
    "",
    plan.osFamily === "nix"
      ? `ENV SHELL=${shellQuote(shellPath)}`
      : `RUN usermod -s ${shellQuote(shellPath)} root`,
    "",
    "COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint",
    "RUN chmod 755 /usr/local/bin/sandbox-entrypoint",
    // The sealantd runtime daemon is baked in from the public GHCR image via a multi-stage
    // `COPY --from` so we inherit its multi-arch (amd64+arm64) binary without bundling a local
    // build context. Gated on the build flag so existing sandboxes stay byte-identical.
    ...(plan.customization.enableSealantd === true
      ? [
          "",
          "COPY --from=ghcr.io/get-sealant/sealantd:0.1.2 /usr/local/bin/sealantd /usr/local/bin/sealantd",
          "RUN chmod 755 /usr/local/bin/sealantd",
        ]
      : []),
    ...(dotfilesStep === undefined ? [] : ["", dotfilesStep]),
    "",
    "WORKDIR /sandbox",
    'ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]',
    "",
  ].join("\n");
};

/**
 * Materializes a temporary BuildKit context directory and writes all generated inputs.
 *
 * Artifacts written here are both build inputs (`Containerfile`, `entrypoint.sh`) and metadata
 * outputs (`resolved-image-plan.json`, `buildkit-spec.json`) consumed by downstream systems.
 */
const writeBuildContext = async (plan: ResolvedImagePlan) => {
  const contextDirectory = await mkdtemp(join(tmpdir(), `sealant-buildkit-${plan.osFamily}-`));
  const containerfilePath = join(contextDirectory, "Containerfile");
  const entrypointPath = join(contextDirectory, "entrypoint.sh");
  const imagePlanPath = join(contextDirectory, "resolved-image-plan.json");
  const buildSpecPath = join(contextDirectory, "buildkit-spec.json");
  const imageTarPath = join(contextDirectory, "sandbox-image.tar");
  const imageReference = `${defaultImageNameForBlueprint(plan.blueprint, plan.osFamily)}:${plan.blueprint.harness.id}`;
  const spec: BuildkitBuildSpec = {
    contextDirectory,
    containerfilePath,
    imageReference,
    push: false,
    secrets: plan.buildSecrets.map((secret) => ({
      id: secret.id,
      sourceRef: secret.sourceRef,
    })),
    buildArgs: {},
  };

  await mkdir(dirname(containerfilePath), { recursive: true });
  await writeFile(containerfilePath, renderContainerfile(plan), "utf8");
  await writeFile(entrypointPath, renderSandboxEntrypoint(plan), "utf8");
  await writeFile(imagePlanPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeFile(buildSpecPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

  return {
    contextDirectory,
    containerfilePath,
    imagePlanPath,
    buildSpecPath,
    imageTarPath,
    spec,
  };
};

/**
 * Executes Docker build + save for the compiled BuildKit spec.
 *
 * We call `docker save` immediately after build so consumers can move a single OCI tarball artifact
 * across process boundaries without requiring local image state persistence.
 */
const buildImageTarball = async (
  spec: BuildkitBuildSpec,
  imageTarPath: string,
  commandRunner: BuildkitCommandRunner,
  osFamily: BuildkitTargetOsFamily,
) => {
  const platformArgs = osFamily === "arch" ? ["--platform", "linux/amd64"] : [];
  const buildArgs = [
    "build",
    "--file",
    spec.containerfilePath,
    ...spec.secrets.flatMap((secret) => ["--secret", `id=${secret.id},src=${secret.sourceRef}`]),
    ...Object.entries(spec.buildArgs).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
    ...platformArgs,
    "--tag",
    spec.imageReference,
    spec.contextDirectory,
  ];

  await commandRunner("docker", buildArgs, {
    cwd: spec.contextDirectory,
  });

  await commandRunner("docker", ["save", "--output", imageTarPath, spec.imageReference], {
    cwd: spec.contextDirectory,
  });
};

export const compileSandboxBuildSpec = async (input: {
  readonly blueprint: SandboxBlueprint;
  readonly options?: BuildkitCompilerOptions;
}): Promise<BuildkitOsBuilderCompileResult> => {
  const parsed = parseBuildkitOsBuilderCompileInput({
    blueprint: parseSandboxBlueprint(input.blueprint),
  });
  const osFamily = selectBuildkitOsFamily({
    blueprint: parsed.blueprint,
    ...(input.options?.autoOsFamilyOrder === undefined
      ? {}
      : { autoOsFamilyOrder: input.options.autoOsFamilyOrder }),
  });
  const imagePlan = mapBlueprintToResolvedImagePlan(parsed.blueprint, osFamily);
  const buildContext = await writeBuildContext(imagePlan);
  const commandRunner = input.options?.commandRunner ?? defaultCommandRunner;

  await buildImageTarball(buildContext.spec, buildContext.imageTarPath, commandRunner, osFamily);

  return parseBuildkitOsBuilderCompileResult({
    builder: {
      id: osFamily,
      osFamily,
    },
    artifacts: [
      {
        kind: "oci-image",
        name: defaultImageNameForBlueprint(parsed.blueprint, osFamily),
        path: buildContext.imageTarPath,
        reference: buildContext.spec.imageReference,
        loader: "docker-load",
      },
      {
        kind: "metadata",
        name: `${defaultImageNameForBlueprint(parsed.blueprint, osFamily)}-image-plan`,
        path: buildContext.imagePlanPath,
        format: "json",
      },
      {
        kind: "metadata",
        name: `${defaultImageNameForBlueprint(parsed.blueprint, osFamily)}-buildkit-spec`,
        path: buildContext.buildSpecPath,
        format: "json",
      },
    ],
    metadata: {
      defaultArtifactName: defaultImageNameForBlueprint(parsed.blueprint, osFamily),
      notes: [`Compiled by the ${osFamily} BuildKit compiler.`],
    },
    buildkit: {
      imagePlan,
      spec: buildContext.spec,
    },
  });
};

/** Public helper used by callers/tests that only need planning (without running Docker). */
export const mapBlueprintToBuildkitImagePlan = (
  blueprint: SandboxBlueprint,
  osFamily: BuildkitTargetOsFamily,
) => {
  return mapBlueprintToResolvedImagePlan(blueprint, osFamily);
};
