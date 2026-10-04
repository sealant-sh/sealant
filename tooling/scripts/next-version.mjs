#!/usr/bin/env node
// The version a commit on main gets on the `next` channel (ADR 0015 in sealant-sh/mend,
// docs/adr/0015-next-channel.md):
//
//   B-next.N            B = the version the next Version Packages pull request would produce
//   B-next.N.preview.R  a preview build: B and N of the branch's merge base with main, R the run
//
// B is what changesets would release from the commit: the highest stable tag vX.Y.Z bumped by the
// largest pending changeset of the released package (or its `fixed` group). Patches only give
// X.Y.(Z+1), any minor X.(Y+1).0, any major (X+1).0.0, none X.Y.(Z+1). Once the Version Packages
// pull request has merged, the package's own version (already bumped, not yet tagged) is B. N
// counts the commits since vX.Y.Z.
//
// Every later commit on main gets a higher version than every earlier one. Between two tags
// pending changesets only accumulate, so the bump only grows, and the Version Packages pull request
// replaces them with exactly the version they produce. N grows with every commit. A new tag
// vX.Y.Z equals the B before it, and everything after it starts above X.Y.Z.
//
// The same file lives in sealant-sh/mend and sealant-sh/sealantd (scripts/) and sealant-sh/sealant
// (tooling/scripts/). Keep them identical.
//
//   node next-version.mjs --package <dir> [commit]                    # default HEAD
//   node next-version.mjs --package <dir> --preview <run> --main <ref> [commit]
//   node next-version.mjs --stray vX.Y.Z [--npm <package>] [commit]   # exit 1 when there are any
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NEXT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-next\.(0|[1-9]\d*)$/;
const LEVELS = ["patch", "minor", "major"];

const parts = (version) => version.split(/[.-]/).slice(0, 3).map(Number);

/** Semver order of two X.Y.Z versions. */
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

/**
 * The base B and the tag N counts from. `names` are the released package and its `fixed` group;
 * `changesets` the pending changeset files' text; `packageVersion` the released package's version.
 */
export const planNext = ({ tags, names, changesets, packageVersion }) => {
  const anchor = highestStableTag(tags);
  if (anchor === undefined) throw new Error("No stable vX.Y.Z tag is reachable from this commit.");
  const released = anchor.slice(1);
  const level = changesets
    .flatMap(changesetLevels)
    .filter((entry) => names.includes(entry.name))
    .reduce((highest, entry) => Math.max(highest, LEVELS.indexOf(entry.level)), 0);
  const bumped = bump(released, LEVELS[level]);
  const versioned = packageVersion !== undefined && compareCore(packageVersion, released) > 0;
  const base = versioned && compareCore(packageVersion, bumped) > 0 ? packageVersion : bumped;
  return { base: parts(base).join("."), anchor };
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

const planAt = (commit, packageDirectory) => {
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
  });
};

/** The `next` version of `commit` in the repository in the current directory. */
export const nextVersionOf = (commit, packageDirectory) => {
  const { base, anchor } = planAt(commit, packageDirectory);
  return nextVersion(base, Number(git(["rev-list", "--count", `${anchor}..${commit}`])));
};

/** The preview version of `commit`: B and N of its merge base with `main`. */
export const previewVersionOf = (commit, main, run, packageDirectory) => {
  refuseShallow();
  const mergeBase = git(["merge-base", commit, main]);
  const { base, anchor } = planAt(mergeBase, packageDirectory);
  return previewVersion(base, Number(git(["rev-list", "--count", `${anchor}..${mergeBase}`])), run);
};

/** Every `next` build of `version`: its git tags, and its npm versions when `npmPackage` is set. */
export const nextBuildsOf = async (version, npmPackage) => {
  const builds = git(["tag", "--list", `v${version}-next.*`])
    .split("\n")
    .filter(Boolean)
    .map((tag) => ({ version: tag.slice(1), commit: git(["rev-list", "-n", "1", tag]) }));
  if (npmPackage !== undefined) {
    const response = await fetch(`https://registry.npmjs.org/${npmPackage.replace("/", "%2f")}`);
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`npm answered ${response.status} for ${npmPackage}.`);
      const { versions = {} } = await response.json();
      for (const [published, manifest] of Object.entries(versions)) {
        if (!published.startsWith(`${version}-next.`)) continue;
        if (typeof manifest.gitHead !== "string") {
          throw new Error(
            `${npmPackage}@${published} records no gitHead, so its commit is unknown.`,
          );
        }
        builds.push({ version: published, commit: manifest.gitHead });
      }
    }
  }
  return builds;
};

const isAncestorOf = (commit) => (candidate) => {
  try {
    git(["merge-base", "--is-ancestor", candidate, commit]);
    return true;
  } catch {
    return false;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
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
    refuseShallow();
    const version = stray.replace(/^v/, "");
    const found = strayNextBuilds({
      version,
      builds: await nextBuildsOf(version, npmPackage),
      isAncestor: isAncestorOf(commit),
    });
    for (const build of found) {
      console.error(
        `::error::${build.version} was built from ${build.commit}, which ${stray} would not contain. A server on it would lose that work by upgrading to ${version}. Release from a commit that contains it.`,
      );
    }
    process.exit(found.length > 0 ? 1 : 0);
  }
  if (packageDirectory === undefined) throw new Error("--package <dir> is required.");
  process.stdout.write(
    `${
      run === undefined
        ? nextVersionOf(commit, packageDirectory)
        : previewVersionOf(commit, main, run, packageDirectory)
    }\n`,
  );
}
