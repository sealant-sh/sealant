import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fresh 0700 directory filled by `fill`. When filling throws, the directory and whatever part of
 * a secret it already holds are removed before the error goes on.
 */
export const makePrivateDir = <A>(
  prefix: string,
  baseDir: string | undefined,
  fill: (dir: string) => A,
): A => {
  const dir = mkdtempSync(join(baseDir ?? tmpdir(), prefix));
  try {
    return fill(dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
};
