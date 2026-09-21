/**
 * Where the files a MicroVM recipe copies in (`agent.mjs`, `docker-service.mjs`,
 * `download-docker.sh`) are read from: the release's own copy on the worker, never a bucket and
 * never a path a blueprint can name.
 *
 * Two layouts exist. From source, this file is `src/images/microvm/` and the files are the
 * package's `microvm-image/`. In a bundled worker image this code is `dist/index.js` and the
 * Dockerfile puts them at `microvm-image/` beside `dist/`.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MICROVM_AGENT_FILES,
  MICROVM_ARCH_FILES,
  MICROVM_DOCKER_FILES,
  type MicrovmContextFile,
} from "./recipe.js";

const CANDIDATE_DIRECTORIES = ["../../../microvm-image/", "../microvm-image/"] as const;

export class MicrovmContextFilesError extends Error {
  override readonly name = "MicrovmContextFilesError";
}

/**
 * Resolves the directory once and checks every file is there, so a release that forgot to ship
 * them stops the worker at start instead of failing the first build.
 */
export interface MicrovmContextFiles {
  readonly read: (name: MicrovmContextFile) => Promise<Uint8Array>;
  /** Over every file's name and bytes: part of each image's plan hash. */
  readonly digest: string;
}

export const loadMicrovmContextFiles = async (
  options: { readonly directory?: string; readonly moduleUrl?: string } = {},
): Promise<MicrovmContextFiles> => {
  const files: readonly MicrovmContextFile[] = [
    ...MICROVM_AGENT_FILES,
    ...MICROVM_DOCKER_FILES,
    ...MICROVM_ARCH_FILES,
  ];
  const candidates =
    options.directory === undefined
      ? CANDIDATE_DIRECTORIES.map((relative) =>
          fileURLToPath(new URL(relative, options.moduleUrl ?? import.meta.url)),
        )
      : [options.directory];
  for (const directory of candidates) {
    const present = await Promise.all(
      files.map((file) =>
        stat(path.join(directory, file)).then(
          (entry) => entry.isFile(),
          () => false,
        ),
      ),
    );
    if (present.every(Boolean)) {
      const hash = createHash("sha256");
      for (const file of files.toSorted()) {
        hash
          .update(`${file}\0`)
          .update(await readFile(path.join(directory, file)))
          .update("\0");
      }
      return { read: (name) => readFile(path.join(directory, name)), digest: hash.digest("hex") };
    }
  }
  throw new MicrovmContextFilesError(
    `The MicroVM image builder needs ${files.join(", ")} and found them in none of ${candidates.join(", ")}. The worker image copies them from packages/workspaces/microvm-image.`,
  );
};
