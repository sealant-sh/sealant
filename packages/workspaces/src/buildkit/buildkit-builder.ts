import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  parseWorkspaceBlueprint,
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
  type WorkspaceBlueprint,
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
   * Distro-native package ids required by the `sealantd boot` supervisor that PID-1s every image.
   *
   * The control socket is bridged to the host over a `docker exec` relay that needs `socat`; no
   * base image ships it, so we install it per-distro. Always installed now that `sealantd boot` is
   * the mandatory entrypoint (clean cut — there is no longer a sealantd-disabled build path).
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
      // KEEP openssh-clients: git-over-ssh clone needs the ssh client (GIT_SSH_COMMAND in boot/git.rs).
      // The inner sshd is gone (gateway reaches the daemon control socket, not an inner sshd), so the
      // openssh-server package is dropped here. Fedora's standalone sftp-server ships in openssh-server,
      // so SFTP-via-exec (gateway-spec §1.C) is unavailable on Fedora until that note is resolved.
      "openssh-clients",
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
 * Public GHCR image whose `/usr/local/bin/sealantd` binary is `COPY --from`'d into every workspace.
 *
 * Pinned to a digest-or-tag here (single source of truth) so the multi-stage copy stays
 * deterministic and easy to bump. The binary is multi-arch (amd64+arm64) so we inherit both without
 * bundling a local build context.
 */
const sealantdImageReference = "ghcr.io/sealant-sh/sealantd:0.5.0";

/**
 * In-container control socket `sealantd boot` listens on. Build-static; promoted to
 * `ENV SEALANT_CONTROL_SOCKET` so `boot` reads it from the env contract. Matches the path the
 * sealantd transport/target code (`sealantd/target.ts`, `sealantd/boot.ts`) bridges into.
 */
const sealantdControlSocketPath = "/run/sealant/control.sock";

/**
 * Computes artifact/image naming used across metadata and OCI artifacts.
 *
 * Keeping this naming centralized prevents subtle drift between the image reference, default
 * artifact name, and metadata artifact names.
 */
const defaultImageNameForBlueprint = (
  blueprint: WorkspaceBlueprint,
  osFamily: BuildkitTargetOsFamily,
): string => {
  return `sealant-workspace-${osFamily}-${blueprint.harness.id}`;
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

const getDotfilesSource = (blueprint: WorkspaceBlueprint) => {
  return blueprint.sources.inputs.find((input) => input.purpose === "dotfiles");
};

const createBuildkitCompilerError = (code: string, message: string) => {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
};

const getBuildkitSupportForOs = (
  blueprint: WorkspaceBlueprint,
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
  blueprint: WorkspaceBlueprint,
  autoOsFamilyOrder: readonly BuildkitTargetOsFamily[],
): readonly BuildkitTargetOsFamily[] => {
  if (blueprint.target.os.family === "auto") {
    return autoOsFamilyOrder;
  }

  return [blueprint.target.os.family];
};

export const selectBuildkitOsFamily = (input: {
  readonly blueprint: WorkspaceBlueprint;
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

const resolveHarnessIntegration = (blueprint: WorkspaceBlueprint): HarnessIntegration => {
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
  blueprint: WorkspaceBlueprint,
  osFamily: BuildkitTargetOsFamily,
): ResolvedImagePackage[] => {
  const distro = distroDefinitions[osFamily];
  const harnessIntegration = resolveHarnessIntegration(blueprint);
  const harnessPackageRequests: WorkspaceBlueprint["tooling"]["packages"] =
    harnessIntegration.installPackages.map((id) => ({ id }));
  const requests: Array<WorkspaceBlueprint["tooling"]["packages"][number]> = [
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
  blueprint: WorkspaceBlueprint,
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
    blueprint.sources.workspace.authRef === undefined
      ? []
      : [
          {
            id: "workspace_git_key",
            kind: "ssh-key" as const,
            phase: "runtime" as const,
            sourceRef: blueprint.sources.workspace.authRef,
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
    // `socat` (and any other relay deps) are always installed: `sealantd boot` is the mandatory
    // PID-1 entrypoint and its control socket is bridged to the host over a `docker exec` relay.
    ...distro.sealantdPackages,
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
 * JSON encoding of a single lifecycle step for the `SEALANT_LIFECYCLE_*_JSON` / `SEALANT_FOREGROUND_RUN_JSON`
 * env contract consumed by `sealantd boot` (`crates/sealantd/src/boot/config.rs`).
 *
 * The shape deliberately mirrors `blueprint.lifecycle.setup[n]` so the Rust loader can deserialize
 * it 1:1: `run`, `shell` (`sh` | `bash`), and an optional `workingDirectory`. `boot` resolves the
 * concrete shell binary and a missing `workingDirectory` to `SEALANT_WORKING_DIRECTORY`.
 */
interface BootLifecycleStepJson {
  readonly run: string;
  readonly shell: "sh" | "bash";
  readonly workingDirectory?: string;
}

const toBootLifecycleStepJson = (
  step: WorkspaceBlueprint["lifecycle"]["setup"][number],
): BootLifecycleStepJson => {
  return {
    run: step.run,
    shell: step.shell,
    ...(step.workingDirectory === undefined ? {} : { workingDirectory: step.workingDirectory }),
  };
};

/**
 * Renders an ordered `ENV` block from key/value pairs.
 *
 * Single Dockerfile `ENV` instruction with backslash-continued lines so the layer is cache-stable
 * and the diff stays readable. Every value is shell-quoted via {@link shellQuote} so JSON payloads
 * (double quotes, brackets) and arbitrary command strings survive Docker's env parsing intact.
 */
const renderEnvBlock = (entries: ReadonlyArray<readonly [string, string]>): string => {
  return entries
    .map(([key, value], index) => {
      const prefix = index === 0 ? "ENV " : "    ";
      const suffix = index === entries.length - 1 ? "" : " \\";
      return `${prefix}${key}=${shellQuote(value)}${suffix}`;
    })
    .join("\n");
};

/**
 * Renders the build-static `ENV SEALANT_*` block consumed by the `sealantd boot` PID-1 supervisor.
 *
 * These were previously baked inline as shell literals by the deleted bash entrypoint
 * (`renderWorkspaceEntrypoint`). The clean-cut design promotes every build-time-static value to an
 * image `ENV` so it reaches `boot` through the same `std::env` surface as the run-dynamic vars the
 * Docker runtime adapter injects with `docker run -e`. No new contract is invented here — these are
 * the exact keys `crates/sealantd/src/boot/config.rs` reads.
 *
 * Ordering of emission:
 * - always: os family, workspace/working roots, shell + sshd paths, control socket, harness banner +
 *   launch command, the (possibly empty) lifecycle setup/startup JSON arrays.
 * - conditional: `SEALANT_FOREGROUND_RUN_JSON` when startup foreground is a literal command.
 * - conditional: `SEALANT_DOTFILES_RUNTIME_APPLY=1` + the `SEALANT_DOTFILES_*` block when planning
 *   chose runtime apply (GitHub-installation-backed dotfiles). Build-time dotfiles stay a `RUN`
 *   layer (see `renderDotfilesStep`) and emit no boot env.
 */
const renderBootEnv = (plan: ResolvedImagePlan): string => {
  const distro = distroDefinitions[plan.osFamily];
  const loginShellPath = distro.shellPaths[plan.customization.defaultShell];
  const harnessIntegration = resolveHarnessIntegration(plan.blueprint);

  const setupJson = JSON.stringify(plan.blueprint.lifecycle.setup.map(toBootLifecycleStepJson));
  const startupJson = JSON.stringify(
    plan.blueprint.lifecycle.startup.steps.map(toBootLifecycleStepJson),
  );

  const entries: Array<[string, string]> = [
    ["SEALANT_OS_FAMILY", plan.osFamily],
    ["SEALANT_WORKSPACE_ROOT", plan.blueprint.runtime.workspaceRoot],
    ["SEALANT_WORKING_DIRECTORY", plan.blueprint.runtime.workingDirectory],
    ["SEALANT_LOGIN_SHELL_PATH", loginShellPath],
    ["SEALANT_BASH_SHELL_PATH", distro.shellPaths.bash],
    ["SEALANT_SSHD_PATH", distro.sshdPath],
    ["SEALANT_CONTROL_SOCKET", sealantdControlSocketPath],
    ["SEALANT_HARNESS_BANNER", `Starting ${plan.blueprint.harness.id} workspace`],
    ["SEALANT_HARNESS_LAUNCH_COMMAND", harnessIntegration.launchCommand],
    ["SEALANT_LIFECYCLE_SETUP_JSON", setupJson],
    ["SEALANT_LIFECYCLE_STARTUP_JSON", startupJson],
  ];

  const foreground = plan.blueprint.lifecycle.startup.foreground;
  if (foreground.kind === "command") {
    entries.push([
      "SEALANT_FOREGROUND_RUN_JSON",
      JSON.stringify(toBootLifecycleStepJson(foreground)),
    ]);
  }

  if (plan.dotfiles !== undefined && plan.dotfiles.applyAt === "runtime") {
    entries.push(
      ["SEALANT_DOTFILES_RUNTIME_APPLY", "1"],
      ["SEALANT_DOTFILES_REPO_URL", plan.dotfiles.url],
      ["SEALANT_DOTFILES_REPO_REF", plan.dotfiles.ref],
      ["SEALANT_DOTFILES_MANAGER", plan.dotfiles.manager],
      ["SEALANT_DOTFILES_TARGET", plan.dotfiles.target],
      ["SEALANT_DOTFILES_BOOTSTRAP", plan.dotfiles.bootstrap ? "1" : "0"],
      ["SEALANT_DOTFILES_BOOTSTRAP_COMMAND", plan.dotfiles.bootstrapCommand ?? "./install.sh"],
    );
    if (plan.dotfiles.githubInstallationRepositoryId !== undefined) {
      entries.push([
        "SEALANT_DOTFILES_GITHUB_INSTALLATION_REPOSITORY_ID",
        plan.dotfiles.githubInstallationRepositoryId,
      ]);
    }
  }

  return renderEnvBlock(entries);
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
 * This is now a thin per-distro template: it installs packages + the harness, configures the login
 * shell, `COPY --from`'s the `sealantd` binary, emits the build-static `ENV SEALANT_*` block, and
 * sets `ENTRYPOINT ["sealantd", "boot"]`. All container orchestration that the deleted bash
 * entrypoint performed (workspace prep, clone, ssh bring-up, runtime dotfiles, lifecycle, harness
 * supervision) now lives in the `sealantd boot` PID-1 supervisor, configured entirely via the
 * `SEALANT_*` env contract (build-static here, run-dynamic via the Docker runtime adapter).
 *
 * Ordering is intentional:
 * - package and harness installs first to maximize layer cache reuse
 * - shell configuration, then the `sealantd` binary copy
 * - optional build-time dotfiles `RUN` layer near the end because it can be highly variable
 * - the boot `ENV` block + `ENTRYPOINT` last so config changes do not bust earlier cache layers
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
    // The sealantd binary is the mandatory PID-1 entrypoint. We bake it in from the public GHCR
    // image via a multi-stage `COPY --from` so we inherit its multi-arch (amd64+arm64) binary
    // without bundling a local build context.
    `COPY --from=${sealantdImageReference} /usr/local/bin/sealantd /usr/local/bin/sealantd`,
    "RUN chmod 755 /usr/local/bin/sealantd",
    ...(dotfilesStep === undefined ? [] : ["", dotfilesStep]),
    "",
    renderBootEnv(plan),
    "",
    "WORKDIR /workspace",
    'ENTRYPOINT ["sealantd", "boot"]',
    "",
  ].join("\n");
};

/**
 * Materializes a temporary BuildKit context directory and writes all generated inputs.
 *
 * Artifacts written here are the build input (`Containerfile`) and metadata outputs
 * (`resolved-image-plan.json`, `buildkit-spec.json`) consumed by downstream systems. The old
 * generated `entrypoint.sh` is gone: the container's PID 1 is now the baked-in `sealantd boot`
 * binary, configured via the `ENV SEALANT_*` block in the Containerfile.
 */
const writeBuildContext = async (plan: ResolvedImagePlan) => {
  const contextDirectory = await mkdtemp(join(tmpdir(), `sealant-buildkit-${plan.osFamily}-`));
  const containerfilePath = join(contextDirectory, "Containerfile");
  const imagePlanPath = join(contextDirectory, "resolved-image-plan.json");
  const buildSpecPath = join(contextDirectory, "buildkit-spec.json");
  const imageTarPath = join(contextDirectory, "workspace-image.tar");
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

export const compileWorkspaceBuildSpec = async (input: {
  readonly blueprint: WorkspaceBlueprint;
  readonly options?: BuildkitCompilerOptions;
}): Promise<BuildkitOsBuilderCompileResult> => {
  const parsed = parseBuildkitOsBuilderCompileInput({
    blueprint: parseWorkspaceBlueprint(input.blueprint),
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
  blueprint: WorkspaceBlueprint,
  osFamily: BuildkitTargetOsFamily,
) => {
  return mapBlueprintToResolvedImagePlan(blueprint, osFamily);
};
