import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import assetLock from "../../../boat-image/asset-lock.json" with { type: "json" };
import {
  NativeBuildError,
  sha256,
  VerifiedRuntimeBundle,
  type NativeResult,
} from "./runtime-bundle.js";

const assetSchema = z.object({
  /** The file's name in a staged `boat-assets` directory. */
  name: z.string().regex(/^[a-z0-9_.-]+$/),
  /** Where the file lives in the package source (`microvm-image/…`, `boat-image/…`). */
  source: z.string().regex(/^(microvm-image|boat-image)\/[a-z0-9_.-]+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const lockSchema = z.object({
  format: z.literal("sealant-native-assets-v2"),
  files: z.array(assetSchema).min(1),
});

/**
 * Where the packaged assets are read from. Beside the worker bundle in production (`boat-assets`,
 * staged by `stage-assets.mjs`, one flat directory); from the package root when running from
 * source, where each file sits in its own directory (`microvm-image/`, `boat-image/`).
 */
export interface NativeAssetDirectory {
  readonly root: string;
  readonly layout: "staged" | "source";
}

export const nativeAssetDirectory = (): NativeAssetDirectory =>
  import.meta.url.endsWith("/src/images/boat/assets.ts")
    ? { root: fileURLToPath(new URL("../../../", import.meta.url)), layout: "source" }
    : { root: fileURLToPath(new URL("../boat-assets/", import.meta.url)), layout: "staged" };

const assetPath = (directory: NativeAssetDirectory, file: z.infer<typeof assetSchema>) =>
  join(directory.root, directory.layout === "staged" ? file.name : file.source);

/** Exact packaged bytes, by staged name. A missing, changed or replaced manifest fails before recipe planning. */
export const readNativeAssets = async (
  directory = nativeAssetDirectory(),
): Promise<NativeResult<ReadonlyMap<string, Uint8Array>>> => {
  try {
    const expected = lockSchema.parse(assetLock);
    const lockFile =
      directory.layout === "staged"
        ? join(directory.root, "asset-lock.json")
        : join(directory.root, "boat-image", "asset-lock.json");
    const manifest = JSON.parse(await readFile(lockFile, "utf8"));
    if (JSON.stringify(lockSchema.parse(manifest)) !== JSON.stringify(expected))
      throw new NativeBuildError("native-asset-manifest-mismatch");
    const entries = await Promise.all(
      expected.files.map(async (file): Promise<readonly [string, Uint8Array]> => {
        const path = assetPath(directory, file);
        const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
        if (!info.isFile() || sha256(bytes) !== file.sha256)
          throw new NativeBuildError("native-packaged-asset-mismatch");
        return [file.name, bytes];
      }),
    );
    return { ok: true, value: new Map(entries) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof NativeBuildError
          ? error
          : new NativeBuildError("native-packaged-assets-unavailable"),
    };
  }
};

/** The staged runtime files `stage-assets.mjs` places beside the assets. */
export const NATIVE_RUNTIME_FILES = [
  "source-index.json",
  "platform-manifest.json",
  "sealantd",
  "sealantctl",
] as const;

/** Verify the runtime from a staged directory without a provider acquisition or source checkout. */
export const loadPackagedRuntime = async (
  directory: NativeAssetDirectory = nativeAssetDirectory(),
): Promise<NativeResult<VerifiedRuntimeBundle>> => {
  const assets = await readNativeAssets(directory);
  if (!assets.ok) return assets;
  if (directory.layout !== "staged")
    return { ok: false, error: new NativeBuildError("native-runtime-bundle-unavailable") };
  try {
    const [sourceIndex, platformManifest, sealantd, sealantctl] = await Promise.all(
      NATIVE_RUNTIME_FILES.map((name) => readFile(join(directory.root, name))),
    );
    if (!sourceIndex || !platformManifest || !sealantd || !sealantctl)
      return { ok: false, error: new NativeBuildError("native-runtime-provenance-mismatch") };
    return VerifiedRuntimeBundle.parse({ sourceIndex, platformManifest, sealantd, sealantctl });
  } catch {
    return { ok: false, error: new NativeBuildError("native-runtime-bundle-unavailable") };
  }
};
