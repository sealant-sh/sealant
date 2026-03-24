import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getHarnessIntegration, type HarnessIntegration } from "@sealant/ai-harness-integrations";
import {
  parseBuildkitOsExecutorCompileInput,
  parseBuildkitOsExecutorCompileResult,
  parseOsExecutorSupport,
  type BuildkitBuildSpec,
  type BuildkitOsExecutor,
  type BuildkitOsExecutorCompileResult,
  type BuildkitPackageManager,
  type BuildkitTargetOsFamily,
  type ConcreteWorkspaceTargetOsFamily,
  type OsExecutorCompileInput,
  type OsExecutorSupport,
  type ResolvedImagePackage,
  type ResolvedImagePlan,
  type WorkspaceBlueprint,
} from "@sealant/workspace-composition";

export interface BuildkitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface BuildkitCommandOptions {
  readonly cwd?: string;
}

export type BuildkitCommandRunner = (
  command: string,
  args: string[],
  options?: BuildkitCommandOptions,
) => Promise<BuildkitCommandResult>;

export interface BuildkitOsExecutorOptions {
  readonly osFamily: BuildkitTargetOsFamily;
  readonly commandRunner?: BuildkitCommandRunner;
}

interface PackageMapping {
  readonly installPackages: readonly string[];
}

interface DistroDefinition {
  readonly baseImage: string;
  readonly packageManager: BuildkitPackageManager;
  readonly packageMap: Record<string, PackageMapping>;
  readonly internalPackages: readonly string[];
  readonly shellPaths: Record<"bash" | "zsh" | "fish", string>;
  readonly sshdPath: string;
}

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
      nodejs: { installPackages: ["nodejs"] },
      pnpm: { installPackages: ["nodejs", "pnpm"] },
      ripgrep: { installPackages: ["ripgrep"] },
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
      nodejs: { installPackages: ["nodejs"] },
      pnpm: { installPackages: ["nodejs", "pnpm"] },
      ripgrep: { installPackages: ["ripgrep"] },
      tmux: { installPackages: ["tmux"] },
      zsh: { installPackages: ["zsh"] },
    },
    internalPackages: ["bash", "ca-certificates", "coreutils", "git", "openssh", "shadow"],
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
      tmux: { installPackages: ["tmux"] },
      zsh: { installPackages: ["zsh"] },
    },
    internalPackages: ["bash", "cacert", "coreutils", "gitMinimal", "openssh", "shadow"],
    shellPaths: {
      bash: "/root/.nix-profile/bin/bash",
      zsh: "/root/.nix-profile/bin/zsh",
      fish: "/root/.nix-profile/bin/fish",
    },
    sshdPath: "/root/.nix-profile/bin/sshd",
  },
};

const defaultImageNameForBlueprint = (
  blueprint: WorkspaceBlueprint,
  osFamily: BuildkitTargetOsFamily,
): string => {
  return `sealant-workspace-${osFamily}-${blueprint.harness.id}`;
};

const shellQuote = (value: string): string => {
  return `'${value.split("'").join(`'"'"'`)}'`;
};

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

const getBuildkitExecutorSupport = (
  blueprint: WorkspaceBlueprint,
  osFamily: BuildkitTargetOsFamily,
): OsExecutorSupport => {
  const requestedOsFamily = blueprint.target.os.family;
  if (requestedOsFamily !== "auto" && requestedOsFamily !== osFamily) {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-os",
      message: `The ${osFamily} BuildKit executor only supports target.os.family of auto or ${osFamily}.`,
    });
  }

  const harnessIntegration = getHarnessIntegration(blueprint.harness.id);
  if (harnessIntegration === undefined) {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-harness",
      message: `No AI harness integration is registered for '${blueprint.harness.id}'.`,
    });
  }

  for (const pkg of blueprint.tooling.packages) {
    if (pkg.version !== undefined) {
      return parseOsExecutorSupport({
        supported: false,
        reason: "unsupported-package",
        message: `The ${osFamily} BuildKit executor does not support package version pinning yet: ${pkg.id}.`,
      });
    }
  }

  const unsupportedInput = blueprint.sources.inputs.find((input) => input.purpose !== "dotfiles");
  if (unsupportedInput !== undefined) {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: `The ${osFamily} BuildKit executor currently supports only dotfiles input sources, received '${unsupportedInput.purpose}'.`,
    });
  }

  const dotfilesInputs = blueprint.sources.inputs.filter((input) => input.purpose === "dotfiles");
  if (dotfilesInputs.length > 1) {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: `The ${osFamily} BuildKit executor currently supports only one dotfiles input source.`,
    });
  }

  return parseOsExecutorSupport({ supported: true });
};

const resolveHarnessIntegration = (blueprint: WorkspaceBlueprint): HarnessIntegration => {
  const integration = getHarnessIntegration(blueprint.harness.id);

  if (integration === undefined) {
    throw new Error(`No AI harness integration is registered for '${blueprint.harness.id}'.`);
  }

  return integration;
};

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

const mapBlueprintToResolvedImagePlan = (
  blueprint: WorkspaceBlueprint,
  osFamily: BuildkitTargetOsFamily,
): ResolvedImagePlan => {
  const support = getBuildkitExecutorSupport(blueprint, osFamily);
  if (!support.supported) {
    throw new Error(support.message);
  }

  const dotfiles = getDotfilesSource(blueprint);
  const buildSecrets =
    dotfiles?.authRef === undefined
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
            manager: blueprint.customization.dotfilesManager ?? "chezmoi",
            url: dotfiles.url,
            ref: dotfiles.ref,
            ...(dotfiles.authRef === undefined ? {} : { authSecretId: "dotfiles_git_key" }),
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

const renderPackageInstallCommand = (plan: ResolvedImagePlan): string => {
  const distro = distroDefinitions[plan.osFamily];
  const packageList = normalizeInstallPackages([
    ...distro.internalPackages,
    ...plan.packages.flatMap((pkg) => pkg.installPackages),
    ...(plan.dotfiles === undefined ? [] : ["chezmoi"]),
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

const renderRuntimeStep = (
  step: WorkspaceBlueprint["lifecycle"]["setup"][number],
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

const renderWorkspaceEntrypoint = (plan: ResolvedImagePlan): string => {
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
    `WORKSPACE_ROOT=${shellQuote(plan.blueprint.runtime.workspaceRoot)}`,
    `WORKING_DIRECTORY=${shellQuote(plan.blueprint.runtime.workingDirectory)}`,
    `WORKSPACE_REPO_URL=${shellQuote(plan.blueprint.sources.workspace.url)}`,
    `WORKSPACE_REPO_REF=${shellQuote(plan.blueprint.sources.workspace.ref)}`,
    `HARNESS_BANNER=${shellQuote(`Starting ${plan.blueprint.harness.id} workspace`)}`,
    "SSH_RUNTIME_DIR=/workspace/.ssh-runtime",
    "REPO_SSH_KEY_PATH=$SSH_RUNTIME_DIR/workspace_repo_key",
    "",
    'mkdir -p "$WORKSPACE_ROOT" "$WORKING_DIRECTORY" "$SSH_RUNTIME_DIR" /root /tmp /var/empty /run/sshd',
    "export HOME=/root",
    "export USER=root",
    "export LOGNAME=root",
    'export PATH="/usr/local/bin:$PATH"',
    'cd "$WORKSPACE_ROOT"',
    "if [ ! -e /lib64/ld-linux-x86-64.so.2 ]; then",
    '  GLIBC_LOADER="$(ls /nix/store/*-glibc-*/lib/ld-linux-x86-64.so.2 2>/dev/null | head -n1 || true)"',
    '  if [ -n "$GLIBC_LOADER" ]; then',
    "    mkdir -p /lib64",
    '    ln -sf "$GLIBC_LOADER" /lib64/ld-linux-x86-64.so.2',
    "  fi",
    "fi",
    "",
    'if [ -n "${SEALANT_WORKSPACE_AUTH_KEY_BASE64:-}" ]; then',
    '  printf \'%s\' "$SEALANT_WORKSPACE_AUTH_KEY_BASE64" | base64 --decode > "$REPO_SSH_KEY_PATH"',
    '  chmod 600 "$REPO_SSH_KEY_PATH"',
    '  export GIT_SSH_COMMAND="ssh -i $REPO_SSH_KEY_PATH -o IdentitiesOnly=yes -o StrictHostKeyChecking=no"',
    "fi",
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
    "  cat > /usr/local/bin/workspace-ssh-shell <<'EOF'",
    `#!${bashShellPath}`,
    "set -euo pipefail",
    `WORKING_DIRECTORY=${shellQuote(plan.blueprint.runtime.workingDirectory)}`,
    `LOGIN_SHELL=${shellQuote(loginShellPath)}`,
    'export PATH="/usr/local/bin:/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin:$PATH"',
    'if [ ! -x "$LOGIN_SHELL" ]; then',
    `  LOGIN_SHELL=${shellQuote(bashShellPath)}`,
    "fi",
    'if [ -d "$WORKING_DIRECTORY" ]; then',
    '  cd "$WORKING_DIRECTORY"',
    "fi",
    'if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then',
    '  exec "$LOGIN_SHELL" -lc "$SSH_ORIGINAL_COMMAND"',
    "fi",
    'exec "$LOGIN_SHELL" -i',
    "EOF",
    "",
    "  chmod 755 /usr/local/bin/workspace-ssh-shell",
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
    "ForceCommand /usr/local/bin/workspace-ssh-shell",
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
    '  git clone --branch "$WORKSPACE_REPO_REF" "$WORKSPACE_REPO_URL" "$WORKING_DIRECTORY"',
    "fi",
    "",
    ...(setupSteps.length === 0 ? [] : [setupSteps, ""]),
    ...(startupSteps.length === 0 ? [] : [startupSteps, ""]),
    'if [ -n "${SEALANT_FOREGROUND_COMMAND:-}" ]; then',
    `  exec ${bashShellPath} -lc "$SEALANT_FOREGROUND_COMMAND"`,
    "fi",
    "",
    renderForegroundCommand(plan),
    "",
  ].join("\n");
};

const renderDotfilesStep = (plan: ResolvedImagePlan): string | undefined => {
  if (plan.dotfiles === undefined) {
    return undefined;
  }

  const cloneCommand =
    plan.dotfiles.authSecretId === undefined
      ? `git clone --depth=1 --branch ${shellQuote(plan.dotfiles.ref)} ${shellQuote(plan.dotfiles.url)} /tmp/sealant-dotfiles`
      : `GIT_SSH_COMMAND='ssh -i /run/sealant/dotfiles_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=no' git clone --depth=1 --branch ${shellQuote(plan.dotfiles.ref)} ${shellQuote(plan.dotfiles.url)} /tmp/sealant-dotfiles`;
  const mountPrefix =
    plan.dotfiles.authSecretId === undefined
      ? "RUN "
      : "RUN --mount=type=secret,id=dotfiles_git_key,target=/run/sealant/dotfiles_key,required=true \\\n    ";

  return [
    `${mountPrefix}${cloneCommand} && \\\n    HOME=/root chezmoi init --apply --source=/tmp/sealant-dotfiles && \\\n    rm -rf /tmp/sealant-dotfiles`,
  ].join("\n");
};

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
    "COPY entrypoint.sh /usr/local/bin/workspace-entrypoint",
    "RUN chmod 755 /usr/local/bin/workspace-entrypoint",
    ...(dotfilesStep === undefined ? [] : ["", dotfilesStep]),
    "",
    "WORKDIR /workspace",
    'ENTRYPOINT ["/usr/local/bin/workspace-entrypoint"]',
    "",
  ].join("\n");
};

const writeBuildContext = async (plan: ResolvedImagePlan) => {
  const contextDirectory = await mkdtemp(join(tmpdir(), `sealant-buildkit-${plan.osFamily}-`));
  const containerfilePath = join(contextDirectory, "Containerfile");
  const entrypointPath = join(contextDirectory, "entrypoint.sh");
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
  await writeFile(entrypointPath, renderWorkspaceEntrypoint(plan), "utf8");
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

const buildImageTarball = async (
  spec: BuildkitBuildSpec,
  imageTarPath: string,
  commandRunner: BuildkitCommandRunner,
) => {
  const buildArgs = [
    "build",
    "--file",
    spec.containerfilePath,
    ...spec.secrets.flatMap((secret) => ["--secret", `id=${secret.id},src=${secret.sourceRef}`]),
    ...Object.entries(spec.buildArgs).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
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

export class BuildkitDistroOsExecutor implements BuildkitOsExecutor {
  public readonly buildTool = "buildkit" as const;

  public readonly id: ConcreteWorkspaceTargetOsFamily;

  public readonly osFamily: BuildkitTargetOsFamily;

  private readonly commandRunner: BuildkitCommandRunner;

  public constructor(options: BuildkitOsExecutorOptions) {
    this.osFamily = options.osFamily;
    this.id = options.osFamily;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
  }

  public supports(input: OsExecutorCompileInput): OsExecutorSupport {
    const parsed = parseBuildkitOsExecutorCompileInput(input);
    return getBuildkitExecutorSupport(parsed.blueprint, this.osFamily);
  }

  public async compile(input: OsExecutorCompileInput): Promise<BuildkitOsExecutorCompileResult> {
    const parsed = parseBuildkitOsExecutorCompileInput(input);
    const support = this.supports(parsed);

    if (!support.supported) {
      throw new Error(support.message);
    }

    const imagePlan = mapBlueprintToResolvedImagePlan(parsed.blueprint, this.osFamily);
    const buildContext = await writeBuildContext(imagePlan);
    await buildImageTarball(buildContext.spec, buildContext.imageTarPath, this.commandRunner);

    return parseBuildkitOsExecutorCompileResult({
      executor: {
        id: this.id,
        osFamily: this.osFamily,
      },
      artifacts: [
        {
          kind: "oci-image",
          name: defaultImageNameForBlueprint(parsed.blueprint, this.osFamily),
          path: buildContext.imageTarPath,
          reference: buildContext.spec.imageReference,
          loader: "docker-load",
        },
        {
          kind: "metadata",
          name: `${defaultImageNameForBlueprint(parsed.blueprint, this.osFamily)}-image-plan`,
          path: buildContext.imagePlanPath,
          format: "json",
        },
        {
          kind: "metadata",
          name: `${defaultImageNameForBlueprint(parsed.blueprint, this.osFamily)}-buildkit-spec`,
          path: buildContext.buildSpecPath,
          format: "json",
        },
      ],
      metadata: {
        defaultArtifactName: defaultImageNameForBlueprint(parsed.blueprint, this.osFamily),
        notes: [`Compiled by the ${this.osFamily} BuildKit OS executor.`],
      },
      buildkit: {
        imagePlan,
        spec: buildContext.spec,
      },
    });
  }
}

export const createBuildkitOsExecutor = (
  osFamily: BuildkitTargetOsFamily,
  options: Omit<BuildkitOsExecutorOptions, "osFamily"> = {},
) => {
  return new BuildkitDistroOsExecutor({
    osFamily,
    ...options,
  });
};

export const mapBlueprintToBuildkitImagePlan = (
  blueprint: WorkspaceBlueprint,
  osFamily: BuildkitTargetOsFamily,
) => {
  return mapBlueprintToResolvedImagePlan(blueprint, osFamily);
};
