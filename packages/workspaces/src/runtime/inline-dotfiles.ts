/**
 * Read worker-staged dotfiles material (`launch-material.ts`: `manifest.json` + `<n>.tar.gz`)
 * and inline it for runtimes with no filesystem to mount into the workspace (Cloudflare's bridge
 * request, the MicroVM agent's launch push). Bounded: the archives ride one HTTP request.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/** Inline dotfiles ride the launch request; refuse silliness rather than time out mid-upload. */
export const MAX_INLINE_DOTFILES_BYTES = 8 * 1024 * 1024;

/** The slice of `manifest.json` this reader needs (full shape: `launch-material.ts`). */
const stagedManifestSchema = z.object({
  archives: z.array(z.object({ file: z.string().trim().min(1) })),
});

export interface InlineDotfiles {
  readonly manifestJson: string;
  readonly archives: ReadonlyArray<{ readonly name: string; readonly contentBase64: string }>;
}

/** Undefined when nothing is staged or the manifest lists no archives. */
export const inlineDotfilesFromDir = async (
  dotfilesArchiveDir: string | undefined,
  runtimeName: string,
): Promise<InlineDotfiles | undefined> => {
  if (dotfilesArchiveDir === undefined) {
    return undefined;
  }
  const manifestJson = await readFile(path.join(dotfilesArchiveDir, "manifest.json"), "utf8");
  const manifest = stagedManifestSchema.parse(JSON.parse(manifestJson));
  let total = 0;
  const archives = await Promise.all(
    manifest.archives.map(async (entry) => {
      const name = path.basename(entry.file);
      const content = await readFile(path.join(dotfilesArchiveDir, name));
      total += content.byteLength;
      return { name, contentBase64: content.toString("base64") };
    }),
  );
  if (total > MAX_INLINE_DOTFILES_BYTES) {
    throw new Error(
      `dotfiles archives total ${total} bytes; ${runtimeName} takes at most ${MAX_INLINE_DOTFILES_BYTES} inline.`,
    );
  }
  if (archives.length === 0) {
    return undefined;
  }
  return { manifestJson, archives };
};
