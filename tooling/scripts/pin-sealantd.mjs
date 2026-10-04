#!/usr/bin/env node
// Core's pins of sealantd, moved together to one version (ADR 0015 in sealant-sh/mend):
//
// - the image the worker bakes into workspace images (buildkit-builder.ts) and the cf-bridge image,
//   always written as `tag@sha256:<digest>`: a moved tag cannot change what Core builds;
// - the two runtime packages in packages/workspaces/package.json, exact.
//
// A release lives under the plain names (`ghcr.io/sealant-sh/sealantd:X.Y.Z`, `@sealant/runtime-*`);
// a next build under the -next names (`ghcr.io/sealant-sh/sealantd-next:X.Y.Z-next.N`, and the
// packages as exact aliases of `@sealant/runtime-*-next`).
//
//   node tooling/scripts/pin-sealantd.mjs 0.20.0-next.139      # rewrite, then pnpm install
//   node tooling/scripts/pin-sealantd.mjs 0.20.0 --no-install
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const IMAGE_FILES = [
  "packages/workspaces/src/buildkit/buildkit-builder.ts",
  "apps/cf-bridge/Dockerfile",
];
export const RUNTIME_MANIFEST = "packages/workspaces/package.json";
const SEMVER = /^\d+\.\d+\.\d+(-next\.\d+)?$/;

export const repositoryFor = (version) =>
  version.includes("-") ? "sealant-sh/sealantd-next" : "sealant-sh/sealantd";

/** Every sealantd image reference in `text`, whatever its form, replaced by `reference`. */
export const rewriteImages = (text, reference) =>
  text.replace(
    /ghcr\.io\/sealant-sh\/sealantd(?:-next)?(?::[0-9A-Za-z._-]+)?(?:@sha256:[0-9a-f]{64})?/g,
    reference,
  );

/** The runtime packages' entries for `version`: exact, or exact aliases of the -next packages. */
export const runtimeSpecs = (version) =>
  Object.fromEntries(
    ["@sealant/runtime-client", "@sealant/runtime-protocol"].map((name) => [
      name,
      version.includes("-") ? `npm:${name}-next@${version}` : version,
    ]),
  );

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** The digest GHCR serves for `repository:tag`, read anonymously. */
export const registryDigest = async (repository, tag, fetchImpl = fetch) => {
  const token = await fetchImpl(`https://ghcr.io/token?scope=repository:${repository}:pull`);
  if (!token.ok) throw new Error(`GHCR refused a pull token for ${repository}: ${token.status}.`);
  const { token: bearer } = await token.json();
  const manifest = await fetchImpl(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${bearer}`, Accept: MANIFEST_TYPES },
  });
  if (!manifest.ok) {
    throw new Error(`ghcr.io/${repository}:${tag} is not published (HTTP ${manifest.status}).`);
  }
  const digest = manifest.headers.get("docker-content-digest");
  if (digest === null || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`ghcr.io/${repository}:${tag} came back without a digest.`);
  }
  return digest;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [version, ...flags] = process.argv.slice(2);
  if (version === undefined || !SEMVER.test(version)) {
    console.error(
      "usage: node tooling/scripts/pin-sealantd.mjs <X.Y.Z | X.Y.Z-next.N> [--no-install]",
    );
    process.exit(2);
  }
  const repository = repositoryFor(version);
  const reference = `ghcr.io/${repository}:${version}@${await registryDigest(repository, version)}`;
  for (const file of IMAGE_FILES) {
    const absolute = path.join(root, file);
    await writeFile(absolute, rewriteImages(await readFile(absolute, "utf8"), reference));
  }
  const manifestPath = path.join(root, RUNTIME_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  Object.assign(manifest.dependencies, runtimeSpecs(version));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`sealantd → ${reference}`);
  if (!flags.includes("--no-install"))
    execFileSync("pnpm", ["install"], { cwd: root, stdio: "inherit" });
}
