/**
 * Runtime-neutral mount intent (docs/kubernetes-support-design.md §D1).
 *
 * A blueprint says "this absolute path is the workspace" or "mount this absolute path there,
 * read-only". Today the only runtime is Docker, where an absolute path is literally a host path and
 * becomes `docker run -v`. Kubernetes cannot bind a host path across nodes; it maps approved
 * canonical roots to RWX claims and mounts a `subPath`. `RuntimeMountIntent` is the shared, pure
 * description both lowerings start from:
 *
 *   - the Docker adapter keeps emitting its argv directly from the blueprint (its output is pinned
 *     by golden tests and must not drift); `collectMountIntents` is cross-checked against it in tests;
 *   - the Kubernetes adapter consumes `collectMountIntents` and lowers each intent to a claim +
 *     subPath volume mount.
 *
 * Nothing here performs I/O or knows about PVCs.
 */
import type { RuntimeAdapterLaunchInput } from "./runtime-adapter.js";

/** Why a path is being mounted. Drives policy (what may be lowered from a store claim). */
export type RuntimeMountPurpose =
  /** The blueprint's `sources.workspace` mount source: the worktree at `runtime.workingDirectory`. */
  | "workspace"
  /**
   * A `sources.mounts` entry whose container path equals its source path. The SDK requests this
   * shape for a linked worktree's Git common directory so the absolute `gitdir:` pointer resolves
   * identically inside the workspace.
   */
  | "git-common"
  /** Any other `sources.mounts` entry (references, project folders, session channel, ...). */
  | "extra-mount"
  /** Worker-staged boot material: dotfiles archives, the transient secret env file. */
  | "launch-material";

export interface RuntimeMountIntent {
  /** Absolute, normalized source path in the runtime-neutral namespace (host path for Docker). */
  readonly sourcePath: string;
  /** Absolute container path; preserved verbatim by every lowering. */
  readonly mountPath: string;
  readonly readOnly: boolean;
  readonly purpose: RuntimeMountPurpose;
}

/** In-container paths the Docker adapter already uses for staged launch material. */
export const DOTFILES_ARCHIVE_MOUNT_PATH = "/run/sealant/dotfiles";
export const SECRET_ENV_MOUNT_PATH = "/run/sealant/secrets";

/**
 * Derive the full, ordered mount list for a launch. Order matches the Docker adapter's argv order
 * (launch material, workspace, extra mounts) so the two can be compared one-to-one in tests.
 */
export const collectMountIntents = (
  input: Pick<RuntimeAdapterLaunchInput, "blueprint" | "dotfilesArchiveDir" | "secretEnvDir">,
): readonly RuntimeMountIntent[] => {
  const { blueprint } = input;
  const intents: RuntimeMountIntent[] = [];

  if (input.dotfilesArchiveDir !== undefined) {
    intents.push({
      sourcePath: input.dotfilesArchiveDir,
      mountPath: DOTFILES_ARCHIVE_MOUNT_PATH,
      readOnly: true,
      purpose: "launch-material",
    });
  }
  if (input.secretEnvDir !== undefined) {
    intents.push({
      sourcePath: input.secretEnvDir,
      mountPath: SECRET_ENV_MOUNT_PATH,
      readOnly: true,
      purpose: "launch-material",
    });
  }

  const workspace = blueprint.sources.workspace;
  if (workspace.kind === "mount") {
    intents.push({
      sourcePath: workspace.hostPath,
      mountPath: blueprint.runtime.workingDirectory,
      readOnly: false,
      purpose: "workspace",
    });
  }

  for (const mount of blueprint.sources.mounts) {
    intents.push({
      sourcePath: mount.hostPath,
      mountPath: mount.mountPath,
      readOnly: mount.readOnly,
      purpose: mount.mountPath === mount.hostPath ? "git-common" : "extra-mount",
    });
  }

  return intents;
};

/**
 * The Docker lowering of one intent: exactly the `-v` pair the Docker adapter emits. Exists so a
 * test can prove `collectMountIntents` and the adapter agree; the adapter does not call it.
 */
export const dockerBindArgsForIntent = (intent: RuntimeMountIntent): readonly string[] => [
  "-v",
  `${intent.sourcePath}:${intent.mountPath}${intent.readOnly ? ":ro" : ""}`,
];
