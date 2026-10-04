#!/usr/bin/env node
// The version a commit on main gets on the `next` channel (ADR 0015 in sealant-sh/mend,
// docs/adr/0015-next-channel.md):
//
//   B-next.N            N = every commit the commit contains (git rev-list --count)
//   B-next.N.preview.R  a preview build: B and N of the branch's merge base with main, R the run
//
// B is the larger of two bases:
// - what the pending changesets would release: the highest stable tag vX.Y.Z bumped by the largest
//   pending changeset of the released package or its `fixed` group (patches only or none:
//   X.Y.(Z+1); any minor: X.(Y+1).0; any major: (X+1).0.0), or the package's own version when the
//   Version Packages pull request has merged and the tag has not;
// - the base of the highest next build already published or tagged above vX.Y.Z.
//
// Neither part goes down, by construction. N counts the whole history, so it grows with every
// commit and never restarts at a tag. B never falls below a base already handed out since the
// last stable tag, whatever happens to the changesets (a revert, a Version Packages merge, a minor
// landing before the tag). After a tag vX.Y.Z, B is above X.Y.Z. So each next build is higher than
// every build published before it.
//
// The same file lives in sealant-sh/mend and sealant-sh/sealantd (scripts/) and sealant-sh/sealant
// (tooling/scripts/). Keep them identical.
//
//   node next-version.mjs --package <dir> [--npm <package>] [commit]        # default HEAD
//   node next-version.mjs --package <dir> --preview <run> --main <ref> [--npm <package>] [commit]
//   node next-version.mjs --stray vX.Y.Z [--npm <package>] [commit]         # exit 1 when any
//   node next-version.mjs --newer <version> <than>                          # exit 0 when newer
//   node next-version.mjs --published <package> <version>   # its gitHead ("unknown"), or nothing
//   node next-version.mjs --dist-tag <package> <tag>        # the tag's version, or nothing
//
// The next builds already handed out are the repository's vX.Y.Z-next.N tags, plus the versions of
// `--npm <package>` (Core and sealantd publish without tags).
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NEXT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-next\.(0|[1-9]\d*)$/;
const LEVELS = ["patch", "minor", "major"];

const parts = (version) => version.split(/[.-]/).slice(0, 3).map(Number);
const coreOf = (version) => parts(version).join(".");

/** Semver order of two X.Y.Z versions (a prerelease suffix is ignored). */
export const compareCore = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** Order of two `next` versions (X.Y.Z-next.N); a stable X.Y.Z sorts after its prereleases. */
export const compareNext = (a, b) => {
  const core = compareCore(a, b);
  if (core !== 0) return core;
  const n = (version) =>
    version.includes("-next.") ? Number(version.split("-next.")[1]) : Infinity;
  return n(a) === n(b) ? 0 : n(a) < n(b) ? -1 : 1;
};

/** The highest stable tag among `tags`, or undefined. */
export const highestStableTag = (tags) =>
  tags.filter((tag) => STABLE_TAG.test(tag)).sort((a, b) => compareCore(b.slice(1), a.slice(1)))[0];

/** The packages a changeset bumps, with their level: `"@sealant/sdk": minor`. */
export const changesetLevels = (text) => {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front === null) return [];
  return front[1]
    .split(/\r?\n/)
    .map((line) => /^\s*["']?([^"':\s]+)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ name: match[1], level: match[2] }));
};

const bump = (version, level) => {
  const [major, minor, patch] = parts(version);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

const highest = (versions) => versions.sort((a, b) => compareCore(b, a))[0];

/**
 * The base B. `names` are the released package and its `fixed` group; `changesets` the pending
 * changeset files' text; `packageVersion` the released package's version; `handedOut` the next
 * versions already published or tagged.
 */
export const planNext = ({ tags, names, changesets, packageVersion, handedOut = [] }) => {
  const anchor = highestStableTag(tags);
  if (anchor === undefined) throw new Error("No stable vX.Y.Z tag is reachable from this commit.");
  const released = anchor.slice(1);
  const level = changesets
    .flatMap(changesetLevels)
    .filter((entry) => names.includes(entry.name))
    .reduce((top, entry) => Math.max(top, LEVELS.indexOf(entry.level)), 0);
  const candidates = [
    bump(released, LEVELS[level]),
    ...(packageVersion !== undefined && compareCore(packageVersion, released) > 0
      ? [coreOf(packageVersion)]
      : []),
    ...handedOut
      .filter((version) => isNextVersion(version) && compareCore(version, released) > 0)
      .map(coreOf),
  ];
  return { base: highest(candidates), anchor };
};

export const nextVersion = (base, count) => `${base}-next.${count}`;

export const previewVersion = (base, count, run) => {
  if (!/^[1-9]\d*$/.test(String(run))) throw new Error(`"${run}" is not a run number.`);
  return `${base}-next.${count}.preview.${run}`;
};

export const isNextVersion = (version) => NEXT_VERSION.test(version);

/**
 * `next` builds of `version` (X.Y.Z) that a stable release on this commit would leave out: built
 * from a commit that is not an ancestor of it. A server on one of them would "upgrade" to X.Y.Z and
 * lose what that build had.
 */
export const strayNextBuilds = ({ version, builds, isAncestor }) =>
  builds.filter(
    (build) =>
      isNextVersion(build.version) &&
      compareCore(build.version, version) === 0 &&
      !isAncestor(build.commit),
  );

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const refuseShallow = () => {
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error("This is a shallow clone: N would be wrong. Fetch the full history first.");
  }
};

/**
 * The registry's record of `npmPackage`, retried. Every package this reads has been published, so
 * a 404 is an error like any other (a CDN hiccup, a typo): after the retries it throws, and the
 * caller stops instead of reading "nothing published" and computing a lower version.
 */
export const registryRecord = async (
  npmPackage,
  { fetchImpl = fetch, attempts = 4, delay = (attempt) => attempt * 1500 } = {},
) => {
  const registry = process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org/";
  const url = new URL(
    npmPackage.replace("/", "%2f"),
    registry.endsWith("/") ? registry : `${registry}/`,
  );
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url.toString(), { headers: { accept: "application/json" } });
      if (response.ok) return await response.json();
      last = new Error(`npm answered ${response.status} for ${npmPackage}.`);
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delay(attempt)));
  }
  throw last;
};

/** Every next build the repository tagged, and `npmPackage`'s published next versions. */
export const nextBuilds = async (npmPackage, options = {}) => {
  const builds = git(["tag", "--list", "v*-next.*"])
    .split("\n")
    .filter((tag) => isNextVersion(tag.slice(1)))
    .map((tag) => ({ version: tag.slice(1), commit: git(["rev-list", "-n", "1", tag]) }));
  if (npmPackage !== undefined) {
    const { versions = {} } = await registryRecord(npmPackage, options);
    for (const [published, manifest] of Object.entries(versions)) {
      if (!isNextVersion(published)) continue;
      builds.push({ version: published, commit: manifest.gitHead });
    }
  }
  return builds;
};

const planAt = (commit, packageDirectory, handedOut) => {
  refuseShallow();
  const show = (file) => git(["show", `${commit}:${file}`]);
  const manifest = JSON.parse(show(`${packageDirectory}/package.json`));
  const config = JSON.parse(show(".changeset/config.json"));
  const fixed = (config.fixed ?? []).find((group) => group.includes(manifest.name)) ?? [];
  const files = git(["ls-tree", "--name-only", `${commit}`, ".changeset/"])
    .split("\n")
    .filter((file) => file.endsWith(".md") && !file.endsWith("/README.md"));
  return planNext({
    tags: git(["tag", "--merged", commit, "--list", "v*"]).split("\n"),
    names: [manifest.name, ...fixed],
    changesets: files.map(show),
    packageVersion: manifest.version,
    handedOut,
  });
};

const countOf = (commit) => Number(git(["rev-list", "--count", commit]));

/** The `next` version of `commit` in the repository in the current directory. */
export const nextVersionOf = (commit, packageDirectory, handedOut = []) =>
  nextVersion(planAt(commit, packageDirectory, handedOut).base, countOf(commit));

/** The preview version of `commit`: B and N of its merge base with `main`. */
export const previewVersionOf = (commit, main, run, packageDirectory, handedOut = []) => {
  refuseShallow();
  const mergeBase = git(["merge-base", commit, main]);
  return previewVersion(
    planAt(mergeBase, packageDirectory, handedOut).base,
    countOf(mergeBase),
    run,
  );
};

const isAncestorOf = (commit) => (candidate) => {
  if (typeof candidate !== "string") return false;
  try {
    git(["merge-base", "--is-ancestor", candidate, commit]);
    return true;
  } catch {
    return false;
  }
};

/** Every next build of `version` the release on `commit` would leave out. */
export const strayBuildsOf = async (version, commit, npmPackage) => {
  refuseShallow();
  return strayNextBuilds({
    version,
    builds: (await nextBuilds(npmPackage)).map((build) => ({
      ...build,
      commit: build.commit ?? "an unknown commit",
    })),
    isAncestor: isAncestorOf(commit),
  });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args[0] === "--newer") {
    const [version, than] = args.slice(1);
    if (version === undefined || than === undefined) throw new Error("--newer <version> <than>");
    const order = compareNext(version, than);
    // Garbage on either side is not newer: NaN fails closed.
    process.exit(order > 0 ? 0 : 1);
  }
  if (args[0] === "--published" || args[0] === "--dist-tag") {
    const [, npmPackage, key] = args;
    if (npmPackage === undefined || key === undefined)
      throw new Error(`${args[0]} <package> <key>`);
    const record = await registryRecord(npmPackage);
    const found =
      args[0] === "--published"
        ? record.versions?.[key] === undefined
          ? ""
          : String(record.versions[key].gitHead ?? "unknown")
        : String(record["dist-tags"]?.[key] ?? "");
    process.stdout.write(found === "" ? "" : `${found}\n`);
    process.exit(0);
  }
  const option = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const [value] = args.splice(index, 2).slice(1);
    if (value === undefined) throw new Error(`${name} needs a value.`);
    return value;
  };
  const stray = option("--stray");
  const npmPackage = option("--npm");
  const packageDirectory = option("--package");
  const run = option("--preview");
  const main = option("--main") ?? "origin/main";
  const commit = args[0] ?? "HEAD";
  if (stray !== undefined) {
    const version = stray.replace(/^v/, "");
    const found = await strayBuildsOf(version, commit, npmPackage);
    for (const build of found) {
      console.error(
        `::error::${build.version} was built from ${build.commit}, which ${stray} would not contain. A server on it would lose that work by upgrading to ${version}. Release from a commit that contains it.`,
      );
    }
    process.exit(found.length > 0 ? 1 : 0);
  }
  if (packageDirectory === undefined) throw new Error("--package <dir> is required.");
  const handedOut = (await nextBuilds(npmPackage)).map((build) => build.version);
  process.stdout.write(
    `${
      run === undefined
        ? nextVersionOf(commit, packageDirectory, handedOut)
        : previewVersionOf(commit, main, run, packageDirectory, handedOut)
    }\n`,
  );
}
