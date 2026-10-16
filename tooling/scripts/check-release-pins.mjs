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
// A dry run (release.yml dispatched with dry_run) passes --dry-run and its own version,
// v<X.Y.Z>-dryrun.<run id>.<attempt>: the sealantd pin checks run as for a release, and only the tag's
// shape is a dry run's. Without the flag a dry-run-shaped tag is a prerelease, and refused.
//
//   node tooling/scripts/check-release-pins.mjs v0.39.0
//   node tooling/scripts/check-release-pins.mjs --dry-run v0.39.0-dryrun.38700000001.1
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

/** The version a dispatched dry run of release.yml carries: never a real release's. */
export const isDryRunVersion = (version) =>
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dryrun\.[1-9]\d*\.[1-9]\d*$/.test(version);

const RELEASED_IMAGE = /^ghcr\.io\/sealant-sh\/sealantd:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/;

/**
 * Every sealantd image reference in `text` that is not a release pinned by digest: a prerelease, a
 * bare digest (which could be any build), a tag alone (which can be moved), or anything else that
 * is not `sealantd:X.Y.Z@sha256:…` (the form tooling/scripts/pin-sealantd.mjs writes).
 */
export const prereleaseImages = (text) =>
  [...text.matchAll(/ghcr\.io\/sealant-sh\/sealantd(?:-next)?(?:[:@][0-9A-Za-z.:@-]+)?/g)]
    .map((match) => match[0])
    .filter((reference) => !RELEASED_IMAGE.test(reference));

/** `@sealant/runtime-*` ranges in a package.json that name a prerelease. */
export const prereleaseRanges = (manifest) =>
  Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([name, range]) => name.startsWith("@sealant/runtime-") && /\d-[0-9A-Za-z]/.test(range))
    .map(([name, range]) => `${name}@${range}`);

/** The packages this repository publishes: their manifests must depend on no `npm:` alias. */
export const PUBLISHED_MANIFESTS = [
  "packages/sdk/package.json",
  "packages/api-contracts/package.json",
];

/** `npm:` aliases among a published manifest's dependencies (only the -next packages carry them). */
export const aliasDependencies = (manifest) =>
  ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
    Object.entries(manifest[field] ?? {})
      .filter(([, spec]) => String(spec).startsWith("npm:"))
      .map(([name, spec]) => `${name}@${spec}`),
  );

/** `@sealant/runtime-*` versions the lockfile resolves that are prereleases. */
export const prereleaseLocks = (lockfile) => [
  ...new Set(
    [
      ...lockfile.matchAll(
        /'?(@sealant\/runtime-[a-z]+(?:-next)?)@(\d+\.\d+\.\d+-[0-9A-Za-z.-]+)'?:/g,
      ),
    ].map((match) => `${match[1]}@${match[2]}`),
  ),
];

export const releasePinProblems = ({ imageFiles, manifests, lockfile, published = {} }) => {
  const problems = [];
  for (const [file, manifest] of Object.entries(published)) {
    for (const alias of aliasDependencies(manifest)) problems.push(`${file} depends on ${alias}.`);
  }
  for (const [file, text] of Object.entries(imageFiles)) {
    for (const image of prereleaseImages(text))
      problems.push(`${file} pins ${image}, not a release by digest.`);
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
  const dryRun = process.argv[2] === "--dry-run";
  const [tag = "", ...extra] = process.argv.slice(dryRun ? 3 : 2);
  if (extra.length > 0 || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
    console.error("usage: node tooling/scripts/check-release-pins.mjs [--dry-run] <vX.Y.Z tag>");
    process.exit(2);
  }
  if (dryRun && !isDryRunVersion(tag.slice(1))) {
    console.error(
      `::error::--dry-run checks a dry-run version (vX.Y.Z-dryrun.<run>.<attempt>), not ${tag}.`,
    );
    process.exit(1);
  }
  if (!dryRun && tag.includes("-")) {
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
    published: Object.fromEntries(
      await Promise.all(
        PUBLISHED_MANIFESTS.map(async (file) => [file, JSON.parse(await read(file))]),
      ),
    ),
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
