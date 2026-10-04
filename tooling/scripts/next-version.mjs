#!/usr/bin/env node
// The version a commit on main gets on the `next` channel (ADR 0015 in sealant-sh/mend,
// docs/adr/0015-next-channel.md):
//
//   X.(Y+1).0-next.N            N = commits reachable from the commit and not from vX.Y.0
//   X.(Y+1).0-next.N.preview.R  a preview build: N of the branch's merge base with main, R the run
//
// vX.Y.Z is the highest stable tag the commit contains. N counts from the minor's first release,
// not from the latest patch, so a patch release (0.38.2) never makes N smaller: every later commit
// on main gets a higher version than every earlier one. A preview sorts after the `next` of its
// merge base and before the next commit's, so a box can move between the two channels in order.
//
// The same file lives in sealant-sh/mend and sealant-sh/sealantd (scripts/) and sealant-sh/sealant
// (tooling/scripts/). Keep them identical.
//
//   node next-version.mjs [commit]                       # default HEAD
//   node next-version.mjs --preview <run> --main <ref> [commit]
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NEXT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-next\.(0|[1-9]\d*)$/;

/** The stable tags among `tags`, as numbers, highest first. */
export const stableTags = (tags) =>
  tags
    .map((tag) => {
      const match = STABLE_TAG.exec(tag);
      return match === null ? null : { tag, parts: match.slice(1, 4).map(Number) };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);

/**
 * The next minor of the highest stable tag, and the tag N counts from: that minor's first release
 * (normally vX.Y.0).
 */
export const planNext = (tags) => {
  const stable = stableTags(tags);
  const highest = stable[0];
  if (highest === undefined) {
    throw new Error("No stable vX.Y.Z tag is reachable from this commit.");
  }
  const [major, minor] = highest.parts;
  const sameMinor = stable.filter((entry) => entry.parts[0] === major && entry.parts[1] === minor);
  const anchor = sameMinor[sameMinor.length - 1];
  return { base: `${major}.${minor + 1}.0`, anchor: anchor.tag };
};

export const nextVersion = (base, count) => `${base}-next.${count}`;

export const previewVersion = (base, count, run) => {
  if (!/^[1-9]\d*$/.test(String(run))) throw new Error(`"${run}" is not a run number.`);
  return `${base}-next.${count}.preview.${run}`;
};

export const isNextVersion = (version) => NEXT_VERSION.test(version);

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** The `next` version of `commit` in the repository in the current directory. */
export const nextVersionOf = (commit = "HEAD") => {
  const { base, anchor } = planNext(git(["tag", "--merged", commit, "--list", "v*"]).split("\n"));
  return nextVersion(base, Number(git(["rev-list", "--count", `${anchor}..${commit}`])));
};

/** The preview version of `commit`: N of its merge base with `main`. */
export const previewVersionOf = (commit, main, run) => {
  const mergeBase = git(["merge-base", commit, main]);
  const { base, anchor } = planNext(
    git(["tag", "--merged", mergeBase, "--list", "v*"]).split("\n"),
  );
  return previewVersion(base, Number(git(["rev-list", "--count", `${anchor}..${mergeBase}`])), run);
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
  const run = option("--preview");
  const main = option("--main") ?? "origin/main";
  const commit = args[0] ?? "HEAD";
  process.stdout.write(
    `${run === undefined ? nextVersionOf(commit) : previewVersionOf(commit, main, run)}\n`,
  );
}
