#!/usr/bin/env node
/**
 * Normalizes an npm tarball once, in release.yml's credential-free pack job, so the publisher can
 * publish those exact bytes without rewriting them (ported from sealant-sh/mend
 * scripts/normalize-npm-tarball.mjs; next.yml's republish block still rewrites at publication):
 *   node tooling/scripts/normalize-npm-tarball.mjs <tarball> --out <dir> --name <name>
 *     --version <version> --commit <sha> [--channel next|latest]
 * extracts it with npm's own copy of pacote, rewrites package.json from an allowlist (no `tag`, no
 * scripts, no publishConfig but `access`), refuses a wrong name, version or gitHead, a dependency
 * alias and a root binding.gyp (npm would turn it into an install script), deletes every `.npmrc`
 * (a packed one would configure the pack), and repacks it into <dir> with `npm pack`.
 *   node tooling/scripts/normalize-npm-tarball.mjs --check <tarball> --name … --version … --commit …
 * extracts it the same way and refuses it unless its manifest is already normalized; it never
 * repacks. Both print {file, sha512, integrity} of the resulting (or checked) tarball as JSON.
 * --channel adds the publisher's channel checks: the version's shape, and under next a -next name.
 * release.yml's npm job carries the --check written out; release-npm.test.mjs holds the two to the
 * same answers.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

/** The manifest fields a published package keeps; everything else (scripts, `tag`, …) is dropped. */
export const KEEP_FIELDS = [
  "name",
  "version",
  "description",
  "license",
  "repository",
  "homepage",
  "bugs",
  "keywords",
  "type",
  "main",
  "module",
  "types",
  "typings",
  "exports",
  "files",
  "bin",
  "man",
  "directories",
  "engines",
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "gitHead",
];

/** The allowlisted manifest `read` normalizes to. */
export function normalizedManifest(read) {
  const manifest = {};
  for (const field of KEEP_FIELDS) if (field in read) manifest[field] = read[field];
  if (read.publishConfig?.access !== undefined)
    manifest.publishConfig = { access: read.publishConfig.access };
  return manifest;
}

/** The packages one release publishes together, at one version. */
export const RELEASED_TOGETHER = ["@sealant/api-contracts", "@sealant/sdk"];

/**
 * Why `manifest`, extracted into `dir`, may not be published as `name`@`version` from `commit`; an
 * empty list when it may. A -next package depends on its siblings only as
 * `npm:@sealant/<sibling>-next@<this version>`; anything else, and any alias at all outside the
 * -next packages, is refused. Outside them, a package released together with this one is depended
 * on at exactly this version.
 */
export function manifestProblems(manifest, dir, { name, version, commit, channel }) {
  const isNextPackage = /^@sealant\/[a-z0-9-]+-next$/.test(String(manifest.name));
  const dependencyProblems = ["dependencies", "peerDependencies", "optionalDependencies"].flatMap(
    (field) =>
      Object.entries(manifest[field] ?? {}).flatMap(([dependency, spec]) => {
        const alias = String(spec).startsWith("npm:");
        if (!dependency.startsWith("@sealant/")) {
          return alias ? [`${dependency} is an alias (${spec})`] : [];
        }
        const expected = `npm:${dependency}-next@${version}`;
        if (isNextPackage)
          return spec === expected ? [] : [`${dependency}@${spec}, not ${expected}`];
        if (alias) return [`${dependency} is an alias (${spec})`];
        return RELEASED_TOGETHER.includes(dependency) && spec !== version
          ? [`${dependency}@${spec}, not ${version}`]
          : [];
      }),
  );
  const shape =
    channel === undefined
      ? undefined
      : channel === "next"
        ? /^\d+\.\d+\.\d+-next\.\d+$/
        : /^\d+\.\d+\.\d+$/;
  return [
    channel === "next" && !isNextPackage && `${manifest.name} is not a -next package`,
    ...dependencyProblems,
    manifest.name !== name && `name ${manifest.name}, not ${name}`,
    manifest.version !== version && `version ${manifest.version}, not ${version}`,
    shape !== undefined &&
      !shape.test(String(manifest.version)) &&
      `${manifest.version} is not a ${channel} version`,
    manifest.gitHead !== commit && `gitHead ${manifest.gitHead}, not ${commit}`,
    existsSync(path.join(dir, "binding.gyp")) &&
      "a binding.gyp, which npm turns into an install script",
  ].filter(Boolean);
}

/** Every `.npmrc` under `dir`, relative to it. */
function npmrcFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.name === ".npmrc")
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

/** npm's bundled pacote: no install, nothing unpinned loads. NORMALIZE_PACOTE names another. */
function loadPacote() {
  const location =
    process.env.NORMALIZE_PACOTE ??
    path.join(
      execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
      "npm/node_modules/pacote",
    );
  return createRequire(import.meta.url)(location);
}

/** The file's sha512 as hex, and as npm's `integrity` string. */
export function tarballDigests(file) {
  const digest = createHash("sha512").update(readFileSync(file)).digest();
  return {
    file: path.basename(file),
    sha512: digest.toString("hex"),
    integrity: `sha512-${digest.toString("base64")}`,
  };
}

class Refused extends Error {}

const refuse = (name, problems) => {
  throw new Refused(`${name}: ${problems.join("; ")}`);
};

/** Extracts `tarball` into a fresh directory and hands `use` the package directory and manifest. */
async function withExtracted(tarball, use) {
  const work = mkdtempSync(path.join(tmpdir(), "normalize-npm-"));
  try {
    const dir = path.join(work, "package");
    await loadPacote().extract(`file:${path.resolve(tarball)}`, dir);
    const read = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return await use(dir, read, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Rewrites, checks and repacks `tarball` into `out`; returns the new tarball's digests. */
export async function normalizeTarball(tarball, out, expected) {
  return withExtracted(tarball, (dir, read) => {
    const manifest = normalizedManifest(read);
    const problems = manifestProblems(manifest, dir, expected);
    if (problems.length > 0) refuse(expected.name, problems);
    writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    // A packed .npmrc would configure the pack below; nothing else in the tree runs.
    for (const file of npmrcFiles(dir)) rmSync(path.join(dir, file));
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", path.resolve(out)],
        { cwd: dir, encoding: "utf8" },
      ),
    );
    if (packed.length !== 1) refuse(expected.name, ["npm pack did not make one tarball"]);
    const digests = tarballDigests(path.join(out, packed[0].filename));
    // The integrity recorded in the release manifest is the one npm computes for this file.
    if (packed[0].integrity !== digests.integrity)
      refuse(expected.name, [
        `npm reports ${packed[0].integrity}, the file is ${digests.integrity}`,
      ]);
    return digests;
  });
}

/** Refuses `tarball` unless it is already what normalizeTarball makes; returns its digests. */
export async function checkTarball(tarball, expected) {
  await withExtracted(tarball, (dir, read) => {
    const problems = manifestProblems(read, dir, expected);
    const normalized = normalizedManifest(read);
    const extra = Object.keys(read).filter((field) => !(field in normalized));
    if (extra.length > 0) problems.push(`not normalized: it keeps ${extra.join(", ")}`);
    else if (!isDeepStrictEqual(read.publishConfig, normalized.publishConfig))
      problems.push("not normalized: publishConfig holds more than access");
    const npmrc = npmrcFiles(dir);
    if (npmrc.length > 0) problems.push(`not normalized: it holds ${npmrc.join(", ")}`);
    if (problems.length > 0) refuse(expected.name, problems);
  });
  return tarballDigests(tarball);
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      out: { type: "string" },
      name: { type: "string" },
      version: { type: "string" },
      commit: { type: "string" },
      channel: { type: "string" },
    },
  });
  const usage =
    "usage: normalize-npm-tarball.mjs [--check] <tarball> [--out <dir>] --name <name> --version <version> --commit <sha> [--channel next|latest]";
  if (
    positionals.length !== 1 ||
    !values.name ||
    !values.version ||
    !values.commit ||
    values.check === (values.out !== undefined) ||
    (values.channel !== undefined && !["next", "latest"].includes(values.channel))
  )
    throw new Refused(usage);
  const expected = {
    name: values.name,
    version: values.version,
    commit: values.commit,
    channel: values.channel,
  };
  const result = values.check
    ? await checkTarball(positionals[0], expected)
    : await normalizeTarball(positionals[0], values.out, expected);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
