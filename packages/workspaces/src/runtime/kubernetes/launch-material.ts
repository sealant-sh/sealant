/**
 * Kubernetes launch-material stager (design §D6).
 *
 * The worker has no host the Pod can bind-mount, so:
 *   - the secret env is passed THROUGH to the adapter (`StagedLaunchMaterial.secretEnv`), which
 *     projects it as `env.json` in the launch Secret — never a file on the worker's disk;
 *   - dotfiles archives are left in the blueprint for the adapter to project into the same Secret
 *     when they fit the budget; when they do not, and a staging claim is configured, they are
 *     written under `<staging mount>/<runId>/dotfiles` on the RWX staging claim and the adapter
 *     mounts that subPath read-only; with no staging claim an oversize archive is a readable error.
 *
 * Cleanup is idempotent: `removeSecretEnv` is a no-op (the adapter deletes the launch Secret once
 * the workspace is ready) and `removeAll` removes the staging directory if one was written.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildDotfilesArchiveManifest,
  hasDotfilesArchives,
  type LaunchMaterialStager,
} from "../launch-material.js";
import type { KubernetesRuntimeConfig } from "./config.js";

export class LaunchMaterialTooLargeError extends Error {
  override readonly name = "LaunchMaterialTooLargeError";
  readonly code = "launch-material-too-large" as const;
}

/** Bytes the dotfiles archives would add to the launch Secret (base64 expansion included). */
export const dotfilesSecretBytes = (archives: ReadonlyArray<{ readonly data: string }>): number =>
  archives.reduce((sum, archive) => sum + archive.data.length, 0) +
  JSON.stringify(buildDotfilesArchiveManifest([]).archives).length +
  256 * archives.length;

const stagingDir = (config: KubernetesRuntimeConfig, runId: string | null): string | undefined =>
  config.staging === undefined
    ? undefined
    : join(config.staging.mountPath, `sealant-dotfiles-${runId ?? "unkeyed"}`);

/** Logical (claim-relative) path the Pod sees for the same directory. */
const stagingLogicalDir = (
  config: KubernetesRuntimeConfig,
  runId: string | null,
): string | undefined =>
  config.staging === undefined
    ? undefined
    : `${config.staging.logicalRoot}/sealant-dotfiles-${runId ?? "unkeyed"}`;

export const createKubernetesLaunchMaterialStager = (
  config: KubernetesRuntimeConfig,
): LaunchMaterialStager => ({
  stage: async (input) => {
    const result: {
      secretEnv?: Readonly<Record<string, string>>;
      dotfilesArchiveDir?: string;
    } = {};
    if (input.secretEnv !== undefined) {
      result.secretEnv = input.secretEnv;
    }
    if (hasDotfilesArchives(input.spec)) {
      const archives = input.spec.runtime.dotfilesArchives;
      const fits = dotfilesSecretBytes(archives) <= config.launchSecretBudgetBytes;
      if (!fits) {
        const directory = stagingDir(config, input.runId);
        const logical = stagingLogicalDir(config, input.runId);
        if (directory === undefined || logical === undefined) {
          throw new LaunchMaterialTooLargeError(
            `The dotfiles archives (${Math.round(dotfilesSecretBytes(archives) / 1024)} KiB) exceed the launch Secret budget (${Math.round(config.launchSecretBudgetBytes / 1024)} KiB) and no staging claim is configured (SEALANT_K8S_STAGING_LOGICAL_ROOT).`,
          );
        }
        await rm(directory, { recursive: true, force: true });
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const manifest = buildDotfilesArchiveManifest(archives);
        await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
        for (const [index, archive] of archives.entries()) {
          await writeFile(join(directory, `${index}.tar.gz`), Buffer.from(archive.data, "base64"));
        }
        result.dotfilesArchiveDir = logical;
      }
      // Fits: nothing to stage — the adapter reads the archives from the blueprint.
    }
    return result;
  },
  removeSecretEnv: async () => {
    // Nothing on disk; the adapter deletes the launch Secret after readiness.
  },
  removeAll: async (runId) => {
    const directory = stagingDir(config, runId);
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  },
});
