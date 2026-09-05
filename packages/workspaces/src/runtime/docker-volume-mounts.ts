import { chmod, lstat, mkdir } from "node:fs/promises";
import { posix as path } from "node:path";

import { z } from "zod";

import type { RuntimeMountIntent } from "./mount-intent.js";

const hasUnsafeMountDelimiter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === "," || codePoint < 0x20 || codePoint === 0x7f;
  });

const absoluteNormalizedPathSchema = z
  .string()
  .min(2)
  .refine((value) => path.isAbsolute(value), "must be absolute")
  .refine((value) => path.normalize(value) === value && !value.endsWith("/"), "must be normalized")
  .refine((value) => value !== "/", "must not be the filesystem root")
  .refine((value) => !hasUnsafeMountDelimiter(value), "contains a Docker --mount delimiter");

const dockerVolumeNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
    "must be a Docker volume name containing only letters, digits, '.', '_' or '-'",
  );

const dockerVolumeMappingSchema = z.strictObject({
  logicalRoot: absoluteNormalizedPathSchema,
  volumeName: dockerVolumeNameSchema,
});

const isProperDescendant = (candidate: string, root: string): boolean =>
  candidate.startsWith(`${root}/`);

const dockerVolumeMappingsSchema = z
  .array(dockerVolumeMappingSchema)
  .min(1)
  .superRefine((mappings, context) => {
    for (const [index, mapping] of mappings.entries()) {
      for (const [otherIndex, other] of mappings.entries()) {
        if (index === otherIndex) continue;
        if (mapping.logicalRoot === other.logicalRoot) {
          context.addIssue({
            code: "custom",
            message: `logicalRoot '${mapping.logicalRoot}' is listed more than once`,
            path: [index, "logicalRoot"],
          });
        } else if (isProperDescendant(mapping.logicalRoot, other.logicalRoot)) {
          context.addIssue({
            code: "custom",
            message: `logicalRoot '${mapping.logicalRoot}' overlaps '${other.logicalRoot}'`,
            path: [index, "logicalRoot"],
          });
        }
        if (index < otherIndex && mapping.volumeName === other.volumeName) {
          context.addIssue({
            code: "custom",
            message: `volumeName '${mapping.volumeName}' is mapped to more than one root`,
            path: [otherIndex, "volumeName"],
          });
        }
      }
    }
  });

/** One canonical deployment path mapped to an existing Docker Engine named volume. */
export type DockerVolumeMapping = z.infer<typeof dockerVolumeMappingSchema>;

/** A mount intent resolved to the Docker volume and non-empty subpath that will back it. */
export interface ResolvedDockerVolumeMount {
  readonly intent: RuntimeMountIntent;
  readonly mapping: DockerVolumeMapping;
  readonly volumeSubpath: string;
}

/** Expected strict-volume configuration or mount failure. */
export class DockerVolumeMountError extends Error {
  override readonly name = "DockerVolumeMountError";
  readonly code = "unsupported-runtime-requirement" as const;
}

const configurationError = (message: string): DockerVolumeMountError =>
  new DockerVolumeMountError(`Docker volume mount configuration is invalid: ${message}`);

/** Parse `SEALANT_DOCKER_VOLUME_MAPPINGS` as a strict logical-root to volume-name array. */
export const parseDockerVolumeMappings = (raw: string): readonly DockerVolumeMapping[] => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw configurationError(
      `SEALANT_DOCKER_VOLUME_MAPPINGS is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const parsed = dockerVolumeMappingsSchema.safeParse(decoded);
  if (!parsed.success) {
    throw configurationError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    );
  }
  return parsed.data;
};

const parseAllowedStoreRoots = (raw: string | undefined): readonly string[] => {
  if (raw === undefined || raw.length === 0) return [];
  return raw.split(":").map((root) => {
    const parsed = absoluteNormalizedPathSchema.safeParse(root);
    if (!parsed.success) {
      throw configurationError(
        `SEALANT_MOUNT_ALLOWED_STORE_ROOTS root '${root}' ${parsed.error.issues
          .map((issue) => issue.message)
          .join(", ")}`,
      );
    }
    return parsed.data;
  });
};

/**
 * Check strict-volume deployment coherence without granting mount authorization. Every authorized
 * store root and the operational socket root must have separate, exact mappings.
 */
export const assertDockerVolumeConfiguration = (input: {
  readonly mappings: readonly DockerVolumeMapping[];
  readonly mountAllowedStoreRoots?: string | undefined;
  readonly controlSocketHostDir?: string | undefined;
}): readonly string[] => {
  const parsedMappings = dockerVolumeMappingsSchema.safeParse(input.mappings);
  if (!parsedMappings.success) {
    throw configurationError(
      parsedMappings.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    );
  }
  const controlRoot = input.controlSocketHostDir;
  if (controlRoot === undefined) {
    throw configurationError(
      "WORKSPACE_CONTROL_SOCKET_HOST_DIR must be set when strict Docker volume mode is enabled",
    );
  }
  const parsedControlRoot = absoluteNormalizedPathSchema.safeParse(controlRoot);
  if (!parsedControlRoot.success) {
    throw configurationError(
      `WORKSPACE_CONTROL_SOCKET_HOST_DIR '${controlRoot}' ${parsedControlRoot.error.issues
        .map((issue) => issue.message)
        .join(", ")}`,
    );
  }

  const allowedStoreRoots = parseAllowedStoreRoots(input.mountAllowedStoreRoots);
  const requiredRoots = [...allowedStoreRoots, parsedControlRoot.data];
  for (const root of requiredRoots) {
    if (!parsedMappings.data.some((mapping) => mapping.logicalRoot === root)) {
      throw configurationError(`logical root '${root}' has no exact volume mapping`);
    }
  }
  if (allowedStoreRoots.includes(parsedControlRoot.data)) {
    throw configurationError(
      "the operational socket root must be separate from allowed store roots",
    );
  }
  return allowedStoreRoots;
};

const assertMountValueSafe = (value: string, label: string): void => {
  if (hasUnsafeMountDelimiter(value)) {
    throw new DockerVolumeMountError(
      `${label} '${value}' contains a character that is unsafe in Docker --mount syntax`,
    );
  }
};

/** Resolve one source beneath exactly one mapping and require a non-empty relative volume subpath. */
export const resolveDockerVolumeMount = (
  intent: RuntimeMountIntent,
  mappings: readonly DockerVolumeMapping[],
): ResolvedDockerVolumeMount => {
  const sourceResult = absoluteNormalizedPathSchema.safeParse(intent.sourcePath);
  if (!sourceResult.success) {
    throw new DockerVolumeMountError(
      `Docker volume mount source '${intent.sourcePath}' must be an absolute, normalized path below a mapped root`,
    );
  }
  assertMountValueSafe(intent.mountPath, "Docker volume mount destination");

  const matches = mappings.filter((mapping) =>
    isProperDescendant(sourceResult.data, mapping.logicalRoot),
  );
  if (matches.length !== 1) {
    if (mappings.some((mapping) => mapping.logicalRoot === sourceResult.data)) {
      throw new DockerVolumeMountError(
        `Docker volume mount source '${intent.sourcePath}' is a mapped root itself; a non-empty volume subpath is required`,
      );
    }
    throw new DockerVolumeMountError(
      matches.length === 0
        ? `Docker volume mount source '${intent.sourcePath}' is not beneath a configured logical root`
        : `Docker volume mount source '${intent.sourcePath}' matches more than one logical root`,
    );
  }
  const mapping = matches[0];
  if (mapping === undefined) {
    throw new DockerVolumeMountError(
      `Docker volume mount source '${intent.sourcePath}' has no usable mapping`,
    );
  }
  const volumeSubpath = sourceResult.data.slice(mapping.logicalRoot.length + 1);
  if (
    volumeSubpath.length === 0 ||
    path.isAbsolute(volumeSubpath) ||
    path.normalize(volumeSubpath) !== volumeSubpath
  ) {
    throw new DockerVolumeMountError(
      `Docker volume subpath derived from '${intent.sourcePath}' is unsafe: '${volumeSubpath}'`,
    );
  }
  assertMountValueSafe(volumeSubpath, "Docker volume subpath");
  return { intent, mapping, volumeSubpath };
};

/** Resolve all intents and enforce the independent store-root authorization policy. */
export const resolveDockerVolumeMounts = (input: {
  readonly intents: readonly RuntimeMountIntent[];
  readonly mappings: readonly DockerVolumeMapping[];
  readonly allowedStoreRoots: readonly string[];
}): readonly ResolvedDockerVolumeMount[] =>
  input.intents.map((intent) => {
    if (
      intent.purpose !== "launch-material" &&
      !input.allowedStoreRoots.some((root) => isProperDescendant(intent.sourcePath, root))
    ) {
      throw new DockerVolumeMountError(
        `Docker volume mount source '${intent.sourcePath}' is not authorized by SEALANT_MOUNT_ALLOWED_STORE_ROOTS`,
      );
    }
    return resolveDockerVolumeMount(intent, input.mappings);
  });

/** Lower a resolved mount to Docker's volume-subpath syntax without shell interpolation. */
export const dockerVolumeMountArgs = (
  mount: ResolvedDockerVolumeMount,
): readonly ["--mount", string] => [
  "--mount",
  [
    "type=volume",
    `src=${mount.mapping.volumeName}`,
    `dst=${mount.intent.mountPath}`,
    `volume-subpath=${mount.volumeSubpath}`,
    "volume-nocopy",
    ...(mount.intent.readOnly ? ["readonly"] : []),
  ].join(","),
];

const assertDirectoryWithoutSymlink = async (directory: string, label: string): Promise<void> => {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(directory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DockerVolumeMountError(`${label} '${directory}' does not exist: ${message}`);
  }
  if (stats.isSymbolicLink()) {
    throw new DockerVolumeMountError(`${label} '${directory}' must not be a symbolic link`);
  }
  if (!stats.isDirectory()) {
    throw new DockerVolumeMountError(`${label} '${directory}' must be a directory`);
  }
};

/**
 * Require every selected source directory to exist and reject symbolic links in every component
 * from its mapped root. The deployment must prevent concurrent path replacement during launch.
 */
export const assertDockerVolumeSourceDirectories = async (
  mounts: readonly ResolvedDockerVolumeMount[],
): Promise<void> => {
  for (const mount of mounts) {
    let current = mount.mapping.logicalRoot;
    await assertDirectoryWithoutSymlink(current, "Docker volume logical root");
    for (const segment of mount.volumeSubpath.split("/")) {
      current = path.join(current, segment);
      await assertDirectoryWithoutSymlink(current, "Docker volume mount source");
    }
  }
};

const ensureDirectoryPathWithoutSymlinks = async (directory: string): Promise<void> => {
  let current = "/";
  for (const segment of directory.split("/").filter((value) => value.length > 0)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    await assertDirectoryWithoutSymlink(current, "Docker control socket path");
  }
};

const assertOwnedDirectoryName = (directoryName: string, prefix: string): void => {
  if (
    !directoryName.startsWith(`${prefix}-`) ||
    directoryName === "." ||
    directoryName === ".." ||
    directoryName.includes("/")
  ) {
    throw new DockerVolumeMountError(
      `Refusing to manage control directory '${directoryName}': it is not owned by prefix '${prefix}'`,
    );
  }
};

/** Create or verify one adapter-owned control directory without following a symlink at the child. */
export const prepareDockerControlDirectory = async (input: {
  readonly controlRoot: string;
  readonly directoryName: string;
  readonly containerNamePrefix: string;
}): Promise<string> => {
  assertOwnedDirectoryName(input.directoryName, input.containerNamePrefix);
  await ensureDirectoryPathWithoutSymlinks(input.controlRoot);
  const directory = path.join(input.controlRoot, input.directoryName);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  await assertDirectoryWithoutSymlink(directory, "Docker workspace control directory");
  await chmod(directory, 0o700);
  return directory;
};
