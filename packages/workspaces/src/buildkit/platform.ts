import type { WorkspaceImagePlatform } from "@sealant/validators";

import type { BuildkitCommandRunner } from "./buildkit-builder.js";

/**
 * Which platform a workspace image is built for. An image built for the wrong one still runs, under
 * emulation (Rosetta on Apple silicon, QEMU elsewhere), so the builders never leave it to a
 * default: every plan names its platform, every build passes it on, and the plan hash covers it.
 */

export class UnsupportedImagePlatformError extends Error {
  override readonly name = "UnsupportedImagePlatformError";
}

/**
 * The platform for an architecture as Docker (`amd64`, `arm64`), the kernel (`x86_64`, `aarch64`)
 * or Node (`x64`, `arm64`) names it. Undefined for one workspace images are not built for.
 */
export const workspaceImagePlatformOf = (
  architecture: string,
): WorkspaceImagePlatform | undefined => {
  switch (architecture.trim()) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "linux/amd64";
    case "arm64":
    case "aarch64":
      return "linux/arm64";
    default:
      return undefined;
  }
};

/** The platform of the machine this process runs on. */
export const processImagePlatform = (
  architecture: string = process.arch,
): WorkspaceImagePlatform => {
  const platform = workspaceImagePlatformOf(architecture);
  if (platform === undefined) {
    throw new UnsupportedImagePlatformError(
      `Workspace images are built for amd64 and arm64; this machine is ${architecture}. Set SEALANT_WORKSPACE_IMAGE_PLATFORM to build for one of them.`,
    );
  }
  return platform;
};

/** The platform of the Docker daemon `docker` reaches: what its builds would build for. */
export const dockerDaemonImagePlatform = async (
  commandRunner: BuildkitCommandRunner,
): Promise<WorkspaceImagePlatform> => {
  const { stdout } = await commandRunner("docker", ["version", "--format", "{{.Server.Arch}}"]);
  const platform = workspaceImagePlatformOf(stdout);
  if (platform === undefined) {
    throw new UnsupportedImagePlatformError(
      `Workspace images are built for amd64 and arm64; the Docker daemon is ${stdout.trim() || "of no architecture it named"}. Set SEALANT_WORKSPACE_IMAGE_PLATFORM to build for one of them.`,
    );
  }
  return platform;
};
