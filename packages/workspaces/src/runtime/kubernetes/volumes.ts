/**
 * Lower runtime-neutral mount intents onto PVC + subPath volume mounts (design §D1).
 *
 * Rules, all enforced here and all pure:
 *   - an intent's `sourcePath` must be absolute and normalized (no `.`/`..`, no `//`, no trailing
 *     slash) — the blueprint schema already guarantees this for blueprint paths, but the staging
 *     path and anything the SDK adds go through the same gate;
 *   - it must be a PROPER descendant of exactly one configured logical root. Equal to a root is
 *     refused: a workspace never gets the whole store;
 *   - the remainder after the root becomes the `subPath`. kubelet resolves subPath without
 *     following symlinks out of the volume (the CVE-2017-1002101 fix), which is what makes this a
 *     containment boundary rather than a suggestion;
 *   - the container `mountPath` is preserved verbatim and `readOnly` is the intent's value OR'ed
 *     with the mapping's `readOnly`.
 *
 * Output is deterministic: one `volume` per claim in first-use order, one `volumeMount` per intent
 * in input order. Volume names are `store-<n>` so they are always valid DNS labels regardless of
 * claim names.
 */
import type { RuntimeMountIntent } from "../mount-intent.js";
import type { VolumeMapping } from "./config.js";

export interface LoweredVolume {
  readonly name: string;
  readonly persistentVolumeClaim: { readonly claimName: string; readonly readOnly?: boolean };
}

export interface LoweredVolumeMount {
  readonly name: string;
  readonly mountPath: string;
  readonly subPath: string;
  readonly readOnly: boolean;
}

export interface LoweredMounts {
  readonly volumes: readonly LoweredVolume[];
  readonly volumeMounts: readonly LoweredVolumeMount[];
}

export class MountLoweringError extends Error {
  override readonly name = "MountLoweringError";
  readonly code = "unsupported-runtime-requirement" as const;
}

const NORMALIZED_ABSOLUTE = /^\/(?:[^/]+\/)*[^/]+$/;

const assertNormalizedAbsolute = (path: string, what: string): void => {
  if (!NORMALIZED_ABSOLUTE.test(path)) {
    throw new MountLoweringError(`${what} '${path}' must be an absolute, normalized path`);
  }
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "..") {
      throw new MountLoweringError(`${what} '${path}' must not contain '.' or '..' segments`);
    }
  }
};

/** Find the single mapping whose root properly contains `sourcePath`. */
export const resolveVolumeMapping = (
  sourcePath: string,
  mappings: readonly VolumeMapping[],
): { readonly mapping: VolumeMapping; readonly subPath: string } => {
  assertNormalizedAbsolute(sourcePath, "mount source");
  const matches = mappings.filter((mapping) => sourcePath.startsWith(`${mapping.logicalRoot}/`));
  if (matches.length > 1) {
    // Config validation forbids nested roots, so this is defensive; name the ambiguity anyway.
    throw new MountLoweringError(
      `mount source '${sourcePath}' matches more than one logical root (${matches
        .map((m) => m.logicalRoot)
        .join(", ")})`,
    );
  }
  const mapping = matches[0];
  if (mapping === undefined) {
    if (mappings.some((candidate) => candidate.logicalRoot === sourcePath)) {
      throw new MountLoweringError(
        `mount source '${sourcePath}' is a configured logical root itself; a workspace may only mount a proper descendant`,
      );
    }
    throw new MountLoweringError(
      `mount source '${sourcePath}' is not under any configured logical root (${mappings
        .map((m) => m.logicalRoot)
        .join(", ")})`,
    );
  }
  const subPath = sourcePath.slice(mapping.logicalRoot.length + 1);
  // A subPath must itself be relative and clean; the checks above guarantee it, assert anyway.
  if (subPath.length === 0 || subPath.startsWith("/") || subPath.split("/").includes("..")) {
    throw new MountLoweringError(`derived subPath for '${sourcePath}' is not safe: '${subPath}'`);
  }
  return { mapping, subPath };
};

/** Lower every intent. Throws `MountLoweringError` on the first intent that cannot be placed. */
export const lowerMountIntents = (
  intents: readonly RuntimeMountIntent[],
  mappings: readonly VolumeMapping[],
): LoweredMounts => {
  const volumeByClaim = new Map<string, LoweredVolume>();
  const volumeMounts: LoweredVolumeMount[] = [];
  const seenMountPaths = new Set<string>();

  for (const intent of intents) {
    assertNormalizedAbsolute(intent.mountPath, "mount path");
    if (seenMountPaths.has(intent.mountPath)) {
      throw new MountLoweringError(`mount path '${intent.mountPath}' is requested twice`);
    }
    seenMountPaths.add(intent.mountPath);

    const { mapping, subPath } = resolveVolumeMapping(intent.sourcePath, mappings);
    let volume = volumeByClaim.get(mapping.claimName);
    if (volume === undefined) {
      volume = {
        name: `store-${volumeByClaim.size}`,
        persistentVolumeClaim: {
          claimName: mapping.claimName,
          ...(mapping.readOnly ? { readOnly: true } : {}),
        },
      };
      volumeByClaim.set(mapping.claimName, volume);
    }
    volumeMounts.push({
      name: volume.name,
      mountPath: intent.mountPath,
      subPath,
      readOnly: intent.readOnly || mapping.readOnly,
    });
  }

  return { volumes: [...volumeByClaim.values()], volumeMounts };
};
