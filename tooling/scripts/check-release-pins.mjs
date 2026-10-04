#!/usr/bin/env node
// The first job of a stable release (.github/workflows/release.yml), before anything builds or
// publishes. The tag must be a stable vX.Y.Z: prereleases publish from main (next.yml). And Core may
// pin a sealantd prerelease on main (ADR 0015 in sealant-sh/mend), but never release with one. It
// reads every place Core names sealantd:
//
// - the image the worker bakes into workspace images (buildkit-builder.ts) and the cf-bridge image;
// - the @sealant/runtime-* ranges in package.json files;
// - the @sealant/runtime-* versions pnpm-lock.yaml resolves.
//
//   node tooling/scripts/check-release-pins.mjs v0.39.0
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Files that reference the sealantd image, with what they reference it as. */
export const SEALANTD_IMAGE_FILES = [
  "packages/workspaces/src/buildkit/buildkit-builder.ts",
  "apps/cf-bridge/Dockerfile",
];

/** Packages that depend on the sealantd runtime packages. */
export const RUNTIME_DEPENDENTS = [
  "apps/ssh-gateway/package.json",
  "packages/telemetry/package.json",
  "packages/workspaces/package.json",
];

const RELEASED_IMAGE = /^ghcr\.io\/sealant-sh\/sealantd:\d+\.\d+\.\d+(@sha256:[0-9a-f]{64})?$/;

/**
 * Every sealantd image reference in `text` that is not a release: a prerelease tag, a bare digest
 * (which could be any build), or anything else that is not `sealantd:X.Y.Z[@sha256:…]`.
 */
export const prereleaseImages = (text) =>
  [...text.matchAll(/ghcr\.io\/sealant-sh\/sealantd(?:[:@][0-9A-Za-z.:@-]+)?/g)]
    .map((match) => match[0])
    .filter((reference) => !RELEASED_IMAGE.test(reference));

/** `@sealant/runtime-*` ranges in a package.json that name a prerelease. */
export const prereleaseRanges = (manifest) =>
  Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([name, range]) => name.startsWith("@sealant/runtime-") && /\d-[0-9A-Za-z]/.test(range))
    .map(([name, range]) => `${name}@${range}`);

/** `@sealant/runtime-*` versions the lockfile resolves that are prereleases. */
export const prereleaseLocks = (lockfile) => [
  ...new Set(
    [...lockfile.matchAll(/'?(@sealant\/runtime-[a-z]+)@(\d+\.\d+\.\d+-[0-9A-Za-z.-]+)'?:/g)].map(
      (match) => `${match[1]}@${match[2]}`,
    ),
  ),
];

export const releasePinProblems = ({ imageFiles, manifests, lockfile }) => {
  const problems = [];
  for (const [file, text] of Object.entries(imageFiles)) {
    for (const image of prereleaseImages(text))
      problems.push(`${file} pins ${image}, not a release.`);
  }
  for (const [file, manifest] of Object.entries(manifests)) {
    for (const range of prereleaseRanges(manifest)) problems.push(`${file} depends on ${range}.`);
  }
  for (const locked of prereleaseLocks(lockfile)) {
    problems.push(`pnpm-lock.yaml resolves ${locked}.`);
  }
  return problems;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const tag = process.argv[2] ?? "";
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
    console.error("usage: node tooling/scripts/check-release-pins.mjs <vX.Y.Z tag>");
    process.exit(2);
  }
  if (tag.includes("-")) {
    // A prerelease tag here would publish to npm `latest` and tag the images `latest`.
    console.error(
      `::error::${tag} is a prerelease. Prereleases publish from main (next.yml), never from a tag.`,
    );
    process.exit(1);
  }
  const read = (file) => readFile(path.join(root, file), "utf8");
  const problems = releasePinProblems({
    imageFiles: Object.fromEntries(
      await Promise.all(SEALANTD_IMAGE_FILES.map(async (file) => [file, await read(file)])),
    ),
    manifests: Object.fromEntries(
      await Promise.all(
        RUNTIME_DEPENDENTS.map(async (file) => [file, JSON.parse(await read(file))]),
      ),
    ),
    lockfile: await read("pnpm-lock.yaml"),
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    console.error(
      `::error::${tag} cannot release with a sealantd prerelease. Release sealantd, pin it, then tag.`,
    );
    process.exit(1);
  }
  console.log(`${tag}: every sealantd pin is a release.`);
}
