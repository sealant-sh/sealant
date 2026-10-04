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

test("the base is what the pending changesets would release", () => {
  const plan = (changesets, packageVersion = "0.36.0") =>
    planNext({
      tags: ["v0.35.1", "v0.36.0", "cli-v0.9.0", "v0.37.0-next.4", ""],
      names: ["@sealant/sdk", "@sealant/api-contracts"],
      changesets,
      packageVersion,
    });
  assert.deepEqual(plan([]), { base: "0.36.1", anchor: "v0.36.0" });
  assert.equal(plan([changeset([["@sealant/sdk", "patch"]])]).base, "0.36.1");
  // Any minor in the package's fixed group wins over patches.
  assert.equal(
    plan([changeset([["@sealant/sdk", "patch"]]), changeset([["@sealant/api-contracts", "minor"]])])
      .base,
    "0.37.0",
  );
  assert.equal(plan([changeset([["@sealant/sdk", "major"]])]).base, "1.0.0");
  // Another package's changeset does not count.
  assert.equal(plan([changeset([["@sealant/workspaces", "minor"]])]).base, "0.36.1");
  // After the Version Packages merge and before the tag, the bumped package version is the base.
  assert.equal(plan([], "0.37.0").base, "0.37.0");
  assert.equal(plan([changeset([["@sealant/sdk", "patch"]])], "0.37.0").base, "0.37.0");
  // Numeric order, not string order.
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
  assert.equal(nextVersion("0.36.0", 12), "0.36.0-next.12");
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

test("a real history: patches, a minor, the Version Packages merge, a tag, a preview", (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "next-version-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
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
  const commit = (message) => {
    git("add", "-A");
    git("commit", "--allow-empty", "-q", "-m", message);
  };
  const setVersion = (version) =>
    write("apps/cli/package.json", JSON.stringify({ name: "@sealant/mend", version }));
  const cwd = process.cwd();
  process.chdir(repo);
  t.after(() => process.chdir(cwd));
  const version = (ref = "HEAD") => nextVersionOf(ref, "apps/cli");

  git("init", "-q", "-b", "main");
  write(".changeset/config.json", "{}");
  write(".changeset/README.md", "not a changeset");
  setVersion("0.36.0");
  commit("release 0.36.0");
  git("tag", "v0.36.0");

  // A patch after 0.36.0 leads to 0.36.1.
  write(".changeset/fix-stop.md", changeset([["@sealant/mend", "patch"]]));
  commit("fix stop");
  commit("docs");
  const patch = version();
  assert.equal(patch, "0.36.1-next.2");

  // A minor changeset moves the base to 0.37.0, and the version only goes up.
  write(".changeset/model-picker.md", changeset([["@sealant/mend", "minor"]]));
  commit("model picker");
  const minor = version();
  assert.equal(minor, "0.37.0-next.3");
  assert.ok(compareNext(minor, patch) > 0);

  // A branch cut here, built as a preview, sorts after this commit's next build.
  git("checkout", "-q", "-b", "feature");
  commit("feature one");
  assert.equal(previewVersionOf("HEAD", "main", 7, "apps/cli"), "0.37.0-next.3.preview.7");
  git("checkout", "-q", "main");

  // The Version Packages merge consumes the changesets and keeps the base.
  unlinkSync(path.join(repo, ".changeset/fix-stop.md"));
  unlinkSync(path.join(repo, ".changeset/model-picker.md"));
  setVersion("0.37.0");
  commit("chore: version packages");
  const versioned = version();
  assert.equal(versioned, "0.37.0-next.4");
  assert.ok(compareNext(versioned, minor) > 0);

  // The tag starts the next base above it.
  git("tag", "v0.37.0");
  commit("after the release");
  assert.equal(version(), "0.37.1-next.1");
  assert.ok(compareNext(version(), "0.37.0") > 0);
  // An older commit still computes from what it contains.
  assert.equal(version("HEAD~2"), "0.37.0-next.3");

  // A shallow clone would count too few commits: refused.
  const shallow = mkdtempSync(path.join(tmpdir(), "next-version-shallow-"));
  t.after(() => rmSync(shallow, { recursive: true, force: true }));
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallow]);
  process.chdir(shallow);
  assert.throws(() => nextVersionOf("HEAD", "apps/cli"), /shallow clone/);
});
