/**
 * Runtime-neutral launch material (docs/kubernetes-support-design.md §D6).
 *
 * "Launch material" is everything a workspace needs at boot that is neither part of the image nor
 * safe to put in an environment variable: dotfiles archives (several MiB) and the transient secret
 * env file. The Docker adapter receives host directories it bind-mounts read-only; Kubernetes has no
 * host to stage on, so the mechanism must be pluggable while the *contract* stays fixed:
 *
 *   - `manifest.json` + `<index>.tar.gz` is what `sealantd boot` (`boot/dotfiles.rs::apply_archives`)
 *     reads from `SEALANT_DOTFILES_ARCHIVE_DIR`;
 *   - `env.json` is what it reads once from `SEALANT_SECRET_ENV_FILE`.
 *
 * `LaunchMaterialStager` owns staging, the post-ready secret cleanup and the final cleanup. The
 * host-directory implementation below is the existing Docker behaviour, moved verbatim from
 * `worker/process-workspace-build-job.ts`.
 */
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewWorkspace } from "@sealant/validators";

/** Archive metadata as the daemon's manifest expects it (`crates/sealantd/src/boot/dotfiles.rs`). */
export interface DotfilesArchiveManifestEntry {
  readonly file: string;
  readonly manager?: string;
  readonly target?: string;
  readonly bootstrap: boolean;
  readonly bootstrapCommand?: string;
}

/** Build the manifest the daemon consumes; shared by every stager so the contract has one source. */
export const buildDotfilesArchiveManifest = (
  archives: NewWorkspace["runtime"]["dotfilesArchives"],
): { readonly archives: readonly DotfilesArchiveManifestEntry[] } => ({
  archives: archives.map((archive, index) => ({
    file: `${index}.tar.gz`,
    ...(archive.manager === undefined ? {} : { manager: archive.manager }),
    ...(archive.target === undefined ? {} : { target: archive.target }),
    bootstrap: archive.bootstrap,
    ...(archive.bootstrapCommand === undefined
      ? {}
      : { bootstrapCommand: archive.bootstrapCommand }),
  })),
});

/** True when the spec has dotfiles archives the daemon should apply. */
export const hasDotfilesArchives = (spec: NewWorkspace): boolean =>
  spec.customization.applyDotfiles && spec.runtime.dotfilesArchives.length > 0;

export interface StageLaunchMaterialInput {
  readonly spec: NewWorkspace;
  /** Keys deterministic staging locations; null = no run id (legacy / unkeyed jobs). */
  readonly runId: string | null;
  /** Unsealed, policy-validated secret env. Undefined when the launch carries none. */
  readonly secretEnv?: Readonly<Record<string, string>>;
}

/**
 * What an adapter receives. For the host-directory stager these are host paths the Docker adapter
 * bind-mounts; a Kubernetes stager returns runtime-specific handles instead (see PR 3).
 */
export interface StagedLaunchMaterial {
  readonly dotfilesArchiveDir?: string;
  readonly secretEnvDir?: string;
}

export interface LaunchMaterialStager {
  readonly stage: (input: StageLaunchMaterialInput) => Promise<StagedLaunchMaterial>;
  /** The daemon has consumed the secret env at boot: remove it, keep the rest. Idempotent. */
  readonly removeSecretEnv: (runId: string | null) => Promise<void>;
  /** Remove everything staged for the run (stop, failure). Idempotent. */
  readonly removeAll: (runId: string | null) => Promise<void>;
}

/**
 * Where staged dotfiles archive dirs must live. `docker run -v` resolves paths on the DAEMON'S
 * host filesystem: a worker running inside the self-host compose stack must write through the
 * control-socket directory — the one path the stack bind-mounts at the SAME location on both
 * sides — or the workspace receives an empty mount and boot aborts. A host-run worker (dev,
 * tests) stages in the system tmpdir as before.
 */
export const dotfilesStagingRoot = (): string => {
  const shared = process.env["WORKSPACE_CONTROL_SOCKET_HOST_DIR"];
  return shared === undefined || shared === "" ? tmpdir() : join(shared, "_dotfiles");
};

const dotfilesStagingDir = (runId: string | null): string =>
  join(dotfilesStagingRoot(), `sealant-dotfiles-${runId ?? "unkeyed"}`);

/** Where the transient secret env file is staged; same daemon-host constraint as dotfiles. */
const secretEnvStagingDir = (runId: string | null): string =>
  join(dotfilesStagingRoot(), `sealant-secret-env-${runId ?? "unkeyed"}`);

/**
 * Stage the spec's dotfiles archives into a host directory the adapter bind-mounts read-only:
 * `manifest.json` plus one `<index>.tar.gz` per archive. The path is deterministic per run so a
 * redelivered launch overwrites its own staging instead of leaking a new directory, and a workspace
 * restart re-stages from the job payload. Returns undefined when there is nothing to stage.
 */
const stageDotfilesArchives = async (
  spec: NewWorkspace,
  runId: string | null,
): Promise<string | undefined> => {
  if (!hasDotfilesArchives(spec)) {
    return undefined;
  }
  const archives = spec.runtime.dotfilesArchives;

  const directory = dotfilesStagingDir(runId);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  const manifest = buildDotfilesArchiveManifest(archives);
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  for (const [index, archive] of archives.entries()) {
    await writeFile(join(directory, `${index}.tar.gz`), Buffer.from(archive.data, "base64"));
  }
  return directory;
};

/**
 * Stage the launch's secret environment as `<dir>/env.json` (dir 0700, file 0600) for the adapter
 * to bind-mount read-only; `sealantd boot` consumes it once. Deterministic per run so a redelivered
 * launch overwrites its own staging. The caller removes it the moment the workspace is ready.
 */
const stageSecretEnv = async (
  secretEnv: Readonly<Record<string, string>>,
  runId: string | null,
): Promise<string> => {
  const directory = secretEnvStagingDir(runId);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "env.json");
  await writeFile(file, JSON.stringify(secretEnv), { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return directory;
};

/** Best-effort removal of the staged secret env; safe to call when nothing was staged. */
export const removeStagedSecretEnv = (runId: string | null): Promise<void> =>
  rm(secretEnvStagingDir(runId), { recursive: true, force: true });

/** Best-effort removal of the staged dotfiles dir; safe to call when nothing was staged. */
export const removeStagedDotfilesArchives = (runId: string | null): Promise<void> =>
  rm(dotfilesStagingDir(runId), { recursive: true, force: true });

/** The Docker/self-host stager: host directories the adapter bind-mounts. */
export const hostDirectoryLaunchMaterialStager: LaunchMaterialStager = {
  stage: async (input) => {
    const dotfilesArchiveDir = await stageDotfilesArchives(input.spec, input.runId);
    const secretEnvDir =
      input.secretEnv === undefined
        ? undefined
        : await stageSecretEnv(input.secretEnv, input.runId);
    return {
      ...(dotfilesArchiveDir === undefined ? {} : { dotfilesArchiveDir }),
      ...(secretEnvDir === undefined ? {} : { secretEnvDir }),
    };
  },
  removeSecretEnv: removeStagedSecretEnv,
  removeAll: async (runId) => {
    await removeStagedDotfilesArchives(runId);
    await removeStagedSecretEnv(runId);
  },
};
