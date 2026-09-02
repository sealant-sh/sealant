import { readFileSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { SealantError } from "../errors.js";

export interface LinkedWorktreeMetadataMount {
  readonly hostPath: string;
  readonly mountPath: string;
  readonly readOnly: false;
  readonly bindable?: false;
}

const isMissingPath = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

const readIfPresent = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    if (isMissingPath(cause)) return null;
    throw new SealantError(`Could not inspect mounted workspace Git metadata at ${file}.`, {
      code: "mount_source_git_inspection_failed",
      cause,
    });
  }
};

const requireDirectory = (directory: string): void => {
  try {
    if (statSync(directory).isDirectory()) return;
  } catch (cause) {
    throw new SealantError(
      `Mounted workspace Git metadata points to an unreadable directory: ${directory}.`,
      { code: "mount_source_git_metadata_invalid", cause },
    );
  }
  throw new SealantError(
    `Mounted workspace Git metadata points to a non-directory path: ${directory}.`,
    { code: "mount_source_git_metadata_invalid" },
  );
};

const isWithin = (child: string, parent: string): boolean => {
  const fromParent = relative(parent, child);
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
};

/**
 * A linked Git worktree carries a `.git` POINTER FILE rather than its repository metadata. Docker
 * mounting only the worktree preserves that file but not the absolute host path it names. Discover
 * the shared Git directory so the workspace creator can bind it at the same absolute path inside
 * the container; the pointer then works unchanged and no repository data is copied.
 */
export const discoverLinkedWorktreeMetadataMount = (
  sourcePath: string,
): LinkedWorktreeMetadataMount | null => {
  const dotGit = join(sourcePath, ".git");
  let dotGitStat: Stats;
  try {
    dotGitStat = statSync(dotGit);
  } catch (cause) {
    if (isMissingPath(cause)) return null;
    throw new SealantError(`Could not inspect mounted workspace Git entry at ${dotGit}.`, {
      code: "mount_source_git_inspection_failed",
      cause,
    });
  }
  // A normal repository already carries its complete `.git` directory inside the primary mount.
  if (!dotGitStat.isFile()) return null;

  const pointer = readIfPresent(dotGit);
  const gitDirValue = pointer?.match(/^gitdir:\s*(.+)\s*$/m)?.[1]?.trim();
  // A non-Git folder is still a valid mount source. Only Git's documented pointer shape opts in.
  if (gitDirValue === undefined || gitDirValue === "") return null;

  const gitDir = resolve(dirname(dotGit), gitDirValue);
  requireDirectory(gitDir);
  const commonDirValue = readIfPresent(join(gitDir, "commondir"))?.trim();
  const metadataRoot =
    commonDirValue === undefined || commonDirValue === ""
      ? gitDir
      : resolve(gitDir, commonDirValue);
  requireDirectory(metadataRoot);

  // Unusual but already functional: the pointer resolves within the primary mount itself.
  if (isWithin(metadataRoot, sourcePath)) return null;
  return { hostPath: metadataRoot, mountPath: metadataRoot, readOnly: false };
};
