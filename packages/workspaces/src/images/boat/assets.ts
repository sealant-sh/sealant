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
  name: z.string().regex(/^[a-z0-9_.-]+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const lockSchema = z.object({
  format: z.literal("sealant-native-assets-v1"),
  relay: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(assetSchema).min(1),
});

/** Resolve beside the worker bundle in production; source lookup exists only for source execution. */
export const nativeAssetDirectory = (): string =>
  fileURLToPath(
    new URL(
      import.meta.url.endsWith("/src/images/boat/assets.ts")
        ? "../../../boat-image/"
        : "../boat-assets/",
      import.meta.url,
    ),
  );

/** Exact packaged bytes. A missing, changed or replaced manifest fails before recipe planning. */
export const readNativeAssets = async (
  directory = nativeAssetDirectory(),
): Promise<NativeResult<ReadonlyMap<string, Uint8Array>>> => {
  try {
    const expected = lockSchema.parse(assetLock);
    const manifest = JSON.parse(await readFile(join(directory, "asset-lock.json"), "utf8"));
    if (JSON.stringify(lockSchema.parse(manifest)) !== JSON.stringify(expected))
      throw new NativeBuildError("native-asset-manifest-mismatch");
    const entries = await Promise.all(
      expected.files.map(async (file): Promise<readonly [string, Uint8Array]> => {
        const path = join(directory, file.name);
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

/** Verify the runtime from shipped files without a provider acquisition or source checkout. */
export const loadPackagedRuntime = async (
  directory = nativeAssetDirectory(),
): Promise<NativeResult<VerifiedRuntimeBundle>> => {
  const assets = await readNativeAssets(directory);
  if (!assets.ok) return assets;
  try {
    const [sourceIndex, platformManifest, sealantd, socat, relay] = await Promise.all(
      ["source-index.json", "platform-manifest.json", "sealantd", "socat", "control-relay.cjs"].map(
        (name) => readFile(join(directory, name)),
      ),
    );
    if (
      !sourceIndex ||
      !platformManifest ||
      !sealantd ||
      !socat ||
      !relay ||
      sha256(relay) !== assetLock.relay
    )
      return { ok: false, error: new NativeBuildError("native-runtime-provenance-mismatch") };
    return VerifiedRuntimeBundle.parse({ sourceIndex, platformManifest, sealantd, socat, relay });
  } catch {
    return { ok: false, error: new NativeBuildError("native-runtime-bundle-unavailable") };
  }
};
