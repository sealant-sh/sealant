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
  /** A standby source's ROOT (sealantd ADR-0014), mounted hidden; the working directory is bound later. */
  | "workspace-root"
  /** A bindable extra mount's ROOT, mounted hidden; its declared `mountPath` is bound later. */
  | "extra-mount-root"
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
 * Where bindable roots are mounted (sealantd ADR-0014): the standby source's root at
 * `/workspace/.roots/workspace` (the daemon's own default for a standby working directory), and a
 * bindable extra mount's root at `/workspace/.roots/<its mount path, slashes doubled-underscored>`.
 */
export const BIND_ROOTS_DIR = "/workspace/.roots";
export const STANDBY_ROOT_MOUNT_PATH = `${BIND_ROOTS_DIR}/workspace`;
export const bindRootMountPath = (mountPath: string): string =>
  `${BIND_ROOTS_DIR}/${mountPath.replace(/^\//, "").replace(/\//g, "__")}`;

/**
 * The daemon's view of the bindable extra mounts (`SEALANT_BINDABLE_MOUNTS`). The standby working
 * directory is NOT listed: `sealantd boot` synthesizes it from `SEALANT_WORKSPACE_SOURCE=standby`.
 */
export const bindableMountsEnv = (
  blueprint: RuntimeAdapterLaunchInput["blueprint"],
): string | undefined => {
  const bindable = blueprint.sources.mounts.filter((mount) => mount.bindable);
  if (bindable.length === 0) return undefined;
  return JSON.stringify(
    bindable.map((mount) => ({
      mountPath: mount.mountPath,
      rootMountPath: bindRootMountPath(mount.mountPath),
      hostRootPath: mount.hostPath,
    })),
  );
};

/** `SEALANT_BINDS`: the binds to apply before the harness starts (a relaunch re-supplies them). */
export const bindsEnv = (
  binds: RuntimeAdapterLaunchInput["binds"] | undefined,
): string | undefined =>
  binds === undefined || binds.length === 0
    ? undefined
    : JSON.stringify(binds.map((bind) => ({ mountPath: bind.mountPath, subpath: bind.subpath })));

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
  if (workspace.kind === "standby") {
    intents.push({
      sourcePath: workspace.rootPath,
      mountPath: STANDBY_ROOT_MOUNT_PATH,
      readOnly: false,
      purpose: "workspace-root",
    });
  }
  if (workspace.kind === "mount") {
    intents.push({
      sourcePath: workspace.hostPath,
      mountPath: blueprint.runtime.workingDirectory,
      readOnly: false,
      purpose: "workspace",
    });
  }

  for (const mount of blueprint.sources.mounts) {
    intents.push(
      mount.bindable
        ? {
            sourcePath: mount.hostPath,
            mountPath: bindRootMountPath(mount.mountPath),
            readOnly: mount.readOnly,
            purpose: "extra-mount-root",
          }
        : {
            sourcePath: mount.hostPath,
            mountPath: mount.mountPath,
            readOnly: mount.readOnly,
            purpose: mount.mountPath === mount.hostPath ? "git-common" : "extra-mount",
          },
    );
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
