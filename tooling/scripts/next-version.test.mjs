import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  changesetLevels,
  compareNext,
  highestStableTag,
  isNextVersion,
  nextVersion,
  nextVersionOf,
  planNext,
  previewVersion,
  previewVersionOf,
  strayNextBuilds,
} from "./next-version.mjs";

const changeset = (entries) =>
  `---\n${entries.map(([name, level]) => `"${name}": ${level}`).join("\n")}\n---\n\nWhat changed.\n`;

test("the base is the larger of what the changesets imply and what was already handed out", () => {
  const plan = (changesets, packageVersion = "0.36.0", handedOut = []) =>
    planNext({
      tags: ["v0.35.1", "v0.36.0", "cli-v0.9.0", "v0.37.0-next.4", ""],
      names: ["@sealant/sdk", "@sealant/api-contracts"],
      changesets,
      packageVersion,
      handedOut,
    }).base;
  assert.equal(plan([]), "0.36.1");
  assert.equal(plan([changeset([["@sealant/sdk", "patch"]])]), "0.36.1");
  // Any minor in the package's fixed group wins over patches.
  assert.equal(
    plan([
      changeset([["@sealant/sdk", "patch"]]),
      changeset([["@sealant/api-contracts", "minor"]]),
    ]),
    "0.37.0",
  );
  assert.equal(plan([changeset([["@sealant/sdk", "major"]])]), "1.0.0");
  // Another package's changeset does not count.
  assert.equal(plan([changeset([["@sealant/workspaces", "minor"]])]), "0.36.1");
  // After the Version Packages merge and before the tag, the bumped package version.
  assert.equal(plan([], "0.37.0"), "0.37.0");
  // A base already handed out above the last tag holds, whatever the changesets say now.
  assert.equal(plan([], "0.36.0", ["0.37.0-next.3120"]), "0.37.0");
  // Builds at or below the last tag no longer count.
  assert.equal(plan([], "0.36.0", ["0.36.0-next.3000", "0.35.2-next.10"]), "0.36.1");
  assert.equal(highestStableTag(["v0.9.0", "v0.10.0", "v0.10.0-next.3"]), "v0.10.0");
  assert.throws(() => planNext({ tags: ["cli-v0.4.0"], names: [], changesets: [] }), /No stable/);
});

test("changeset frontmatter is read the way changesets writes it", () => {
  assert.deepEqual(changesetLevels(`---\n'@sealant/mend': minor\n"@sealant/sdk": patch\n---\nx`), [
    { name: "@sealant/mend", level: "minor" },
    { name: "@sealant/sdk", level: "patch" },
  ]);
  assert.deepEqual(changesetLevels("no frontmatter"), []);
});

test("versions sort the way the channels are meant to move", () => {
  assert.equal(nextVersion("0.36.0", 3120), "0.36.0-next.3120");
  assert.equal(previewVersion("0.36.0", 12, 40), "0.36.0-next.12.preview.40");
  assert.throws(() => previewVersion("0.36.0", 12, "0"), /run number/);
  assert.ok(isNextVersion("0.36.0-next.0"));
  assert.ok(!isNextVersion("0.36.0-next.01"));
  assert.ok(!isNextVersion("0.36.0-next.12.preview.4"));
  assert.ok(!isNextVersion("0.36.0-preview.17"));
  assert.ok(compareNext("0.36.1-next.9", "0.37.0-next.2") < 0);
  assert.ok(compareNext("0.36.0-next.10", "0.36.0-next.9") > 0);
  assert.ok(compareNext("0.36.0-next.99", "0.36.0") < 0);
});

test("a stable release refuses next builds it would leave out", () => {
  const builds = [
    { version: "0.36.0-next.60", commit: "a" },
    { version: "0.36.0-next.64", commit: "d" },
    { version: "0.36.1-next.2", commit: "e" },
  ];
  assert.deepEqual(
    strayNextBuilds({ version: "0.36.0", builds, isAncestor: (commit) => commit === "a" }),
    [{ version: "0.36.0-next.64", commit: "d" }],
  );
});

const home = process.cwd();

/** A throwaway repository with Mend's layout: apps/cli/package.json and .changeset/. */
const repository = (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "next-version-"));
  const cwd = home;
  process.chdir(repo);
  t.after(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).trim();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  const remove = (file) => unlinkSync(path.join(repo, file));
  const commit = (message) => {
    git("add", "-A");
    git("commit", "--allow-empty", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const setVersion = (version) =>
    write("apps/cli/package.json", JSON.stringify({ name: "@sealant/mend", version }));
  git("init", "-q", "-b", "main");
  write(".changeset/config.json", "{}");
  write(".changeset/README.md", "not a changeset");
  return { repo, git, write, remove, commit, setVersion };
};

test("the reviewed histories: a minor before a patch's tag, a reverted minor, a tag, a preview", (t) => {
  const r = repository(t);
  const published = [];
  const publish = () => {
    const version = nextVersionOf("HEAD", "apps/cli", published);
    const last = published.at(-1);
    if (last !== undefined) assert.ok(compareNext(version, last) > 0, `${version} after ${last}`);
    published.push(version);
    return version;
  };
  r.setVersion("0.36.0");
  r.commit("release 0.36.0");
  r.git("tag", "v0.36.0");

  r.write(".changeset/fix.md", changeset([["@sealant/mend", "patch"]]));
  r.commit("fix");
  assert.equal(publish(), "0.36.1-next.2");

  // The patch's Version Packages merge.
  r.remove(".changeset/fix.md");
  r.setVersion("0.36.1");
  const versionCommit = r.commit("chore: version packages");
  assert.equal(publish(), "0.36.1-next.3");

  // A minor lands before the tag.
  r.write(".changeset/feature.md", changeset([["@sealant/mend", "minor"]]));
  r.commit("feature");
  assert.equal(publish(), "0.37.0-next.4");
  r.commit("another");
  assert.equal(publish(), "0.37.0-next.5");

  // The tag goes on the Version Packages commit, behind HEAD: nothing restarts.
  r.git("tag", "v0.36.1", versionCommit);
  r.commit("after the tag");
  assert.equal(publish(), "0.37.0-next.6");

  // The minor's changeset is reverted: the base already handed out holds.
  r.remove(".changeset/feature.md");
  r.commit("revert feature");
  assert.equal(publish(), "0.37.0-next.7");

  // A preview of this commit sorts after its next build.
  r.git("checkout", "-q", "-b", "feature");
  r.commit("feature one");
  assert.equal(
    previewVersionOf("HEAD", "main", 7, "apps/cli", published),
    "0.37.0-next.7.preview.7",
  );
  r.git("checkout", "-q", "main");

  // A shallow clone would count too few commits: refused.
  const shallow = mkdtempSync(path.join(tmpdir(), "next-version-shallow-"));
  t.after(() => rmSync(shallow, { recursive: true, force: true }));
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${r.repo}`, shallow]);
  process.chdir(shallow);
  assert.throws(() => nextVersionOf("HEAD", "apps/cli"), /shallow clone/);
  process.chdir(r.repo);
});

test("every generated history publishes strictly increasing versions", (t) => {
  const levels = ["patch", "minor", "major"];
  const bump = (version, level) => {
    const [a, b, c] = version.split(".").map(Number);
    return level === "major"
      ? `${a + 1}.0.0`
      : level === "minor"
        ? `${a}.${b + 1}.0`
        : `${a}.${b}.${c + 1}`;
  };
  // A small deterministic generator, so a failure names a reproducible seed.
  const random = (seed) => () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const seen = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const r = repository(t);
    const pick = random(seed);
    let tagged = "0.36.0";
    let version = tagged;
    let changesets = new Map();
    let counter = 0;
    let versionPr;
    r.setVersion(version);
    r.commit("release");
    r.git("tag", `v${tagged}`);
    const published = [];
    const steps = [];
    for (let step = 0; step < 24; step += 1) {
      const roll = pick();
      let op;
      if (roll < 0.22) {
        op = "patch";
        const file = `.changeset/c${(counter += 1)}.md`;
        r.write(file, changeset([["@sealant/mend", "patch"]]));
        changesets.set(file, "patch");
      } else if (roll < 0.36) {
        op = "minor";
        const file = `.changeset/c${(counter += 1)}.md`;
        r.write(file, changeset([["@sealant/mend", "minor"]]));
        changesets.set(file, "minor");
      } else if (roll < 0.46) {
        op = "revert a minor changeset";
        const minor = [...changesets].find(([, level]) => level === "minor");
        if (minor !== undefined) {
          r.remove(minor[0]);
          changesets.delete(minor[0]);
        }
      } else if (roll < 0.62 && changesets.size > 0 && versionPr === undefined) {
        op = "version packages";
        const level = [...changesets.values()].reduce(
          (top, value) => Math.max(top, levels.indexOf(value)),
          0,
        );
        const before = { version, changesets: new Map(changesets) };
        version = bump(tagged, levels[level]);
        for (const file of changesets.keys()) r.remove(file);
        changesets = new Map();
        r.setVersion(version);
        versionPr = { before, version };
      } else if (roll < 0.7 && versionPr !== undefined) {
        op = "revert the version packages merge";
        version = versionPr.before.version;
        changesets = versionPr.before.changesets;
        for (const [file, level] of changesets)
          r.write(file, changeset([["@sealant/mend", level]]));
        r.setVersion(version);
        versionPr = undefined;
      } else if (roll < 0.86 && versionPr !== undefined && versionPr.commit !== undefined) {
        // The tag goes on the Version Packages commit, which may be behind HEAD by now.
        op = `tag v${versionPr.version}`;
        r.git("tag", `v${versionPr.version}`, versionPr.commit);
        tagged = versionPr.version;
        versionPr = undefined;
      } else {
        op = "plain";
      }
      seen.add(op.startsWith("tag ") ? "tag" : op);
      const sha = r.commit(op);
      if (op === "version packages") versionPr.commit = sha;
      const next = nextVersionOf("HEAD", "apps/cli", published);
      steps.push(`${op} → ${next}`);
      const last = published.at(-1);
      if (last !== undefined) {
        assert.ok(compareNext(next, last) > 0, `seed ${seed}:\n${steps.join("\n")}`);
      }
      published.push(next);
    }
  }
  // The histories cover every move the scheme has to survive.
  assert.deepEqual([...seen].sort(), [
    "minor",
    "patch",
    "plain",
    "revert a minor changeset",
    "revert the version packages merge",
    "tag",
    "version packages",
  ]);
});
