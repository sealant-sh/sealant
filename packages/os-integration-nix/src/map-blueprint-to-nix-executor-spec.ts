import type { WorkspaceBlueprint } from "@zweit/workspace-composition";
import { parseOsExecutorSupport, type OsExecutorSupport } from "@zweit/workspace-composition";

import { parseNixExecutorSpec, type NixExecutorSpec } from "./nix-executor-spec.js";

// The current Nix path only supports the packages already mapped in nixpkgs.
// We mirror that set here so support checks can reject unknown symbolic package
// requests before they reach Nix evaluation.
const supportedPackageIds = new Set(["curl", "git", "jq", "nodejs", "pnpm", "ripgrep"]);

// Image naming is executor-owned because the shared blueprint intentionally does
// not include backend-specific artifact naming concerns.
const defaultImageNameForBlueprint = (blueprint: WorkspaceBlueprint): string =>
  `zweit-workspace-${blueprint.harness.id}`;

// The minimal wrapper path only supports the subset of the shared blueprint that
// the current Nix implementation can honestly honor today.
export const getNixExecutorSupport = (blueprint: WorkspaceBlueprint): OsExecutorSupport => {
  const osFamily = blueprint.target.os.family;

  if (osFamily !== "auto" && osFamily !== "nix") {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-os",
      message: `The Nix executor only supports target.os.family of auto or nix, received ${osFamily}.`,
    });
  }

  if (blueprint.sources.inputs.length > 0) {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The minimal Nix executor path does not support additional input sources yet.",
    });
  }

  if (blueprint.access.ssh.enabled) {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-access-mode",
      message:
        "The minimal Nix executor path does not support SSH wiring from the shared blueprint yet.",
    });
  }

  for (const pkg of blueprint.tooling.packages) {
    if (pkg.version !== undefined) {
      return parseOsExecutorSupport({
        supported: false,
        reason: "unsupported-package",
        message: `The Nix executor does not support package version pinning yet: ${pkg.id}.`,
      });
    }

    if (!supportedPackageIds.has(pkg.id)) {
      return parseOsExecutorSupport({
        supported: false,
        reason: "unsupported-package",
        message: `Unsupported package for the current Nix executor: ${pkg.id}.`,
      });
    }
  }

  if (blueprint.lifecycle.setup.length > 0) {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The minimal Nix executor path does not support lifecycle.setup yet.",
    });
  }

  if (blueprint.lifecycle.startup.steps.length > 0) {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The minimal Nix executor path does not support lifecycle.startup.steps yet.",
    });
  }

  if (
    blueprint.lifecycle.startup.foreground.kind === "command" &&
    blueprint.lifecycle.startup.foreground.workingDirectory !== undefined &&
    blueprint.lifecycle.startup.foreground.workingDirectory !== blueprint.runtime.workingDirectory
  ) {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "The minimal Nix executor path only supports foreground commands in the normalized runtime working directory.",
    });
  }

  if (blueprint.runtime.workspaceRoot !== "/workspace") {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "The minimal Nix executor path requires runtime.workspaceRoot to stay at /workspace.",
    });
  }

  if (blueprint.runtime.workingDirectory !== "/workspace/repo") {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "The minimal Nix executor path requires runtime.workingDirectory to stay at /workspace/repo.",
    });
  }

  if (blueprint.runtime.persistence !== "ephemeral") {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The minimal Nix executor path only supports ephemeral workspaces.",
    });
  }

  if (!blueprint.runtime.network.outbound) {
    return parseOsExecutorSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The minimal Nix executor path requires outbound network access.",
    });
  }

  return parseOsExecutorSupport({ supported: true });
};

// The mapper translates the shared blueprint into the concrete Nix spec that
// the current backend already knows how to compile.
export const mapBlueprintToNixExecutorSpec = (blueprint: WorkspaceBlueprint): NixExecutorSpec => {
  const support = getNixExecutorSupport(blueprint);

  if (!support.supported) {
    throw new Error(support.message);
  }

  const env = { ...blueprint.runtime.env };

  if (blueprint.lifecycle.startup.foreground.kind === "command") {
    env.ZWEIT_FOREGROUND_COMMAND = blueprint.lifecycle.startup.foreground.run;
  }

  return parseNixExecutorSpec({
    harness: blueprint.harness.id,
    imageName: defaultImageNameForBlueprint(blueprint),
    repoUrl: blueprint.sources.workspace.url,
    repoRef: blueprint.sources.workspace.ref,
    extraPackages: blueprint.tooling.packages.map((pkg) => pkg.id),
    env,
  });
};
