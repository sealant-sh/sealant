import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isNextVersion,
  nextVersion,
  nextVersionOf,
  planNext,
  previewVersion,
  previewVersionOf,
} from "./next-version.mjs";

test("the base is the next minor of the highest stable tag; N counts from that minor's .0", () => {
  assert.deepEqual(planNext(["v0.38.0", "v0.38.1", "v0.37.2", "cli-v0.9.0", "v0.39.0-next.4"]), {
    base: "0.39.0",
    anchor: "v0.38.0",
  });
  // A patch on top keeps the anchor, so N never goes backwards.
  assert.deepEqual(planNext(["v0.38.0", "v0.38.1", "v0.38.2"]).anchor, "v0.38.0");
  // Numeric order, not string order.
  assert.equal(planNext(["v0.9.0", "v0.10.0"]).base, "0.11.0");
  // A minor whose first release was a patch counts from its lowest tag.
  assert.deepEqual(planNext(["v1.4.1", "v1.4.2"]), { base: "1.5.0", anchor: "v1.4.1" });
  assert.throws(() => planNext(["cli-v0.4.0", ""]), /No stable/);
});

test("versions sort the way the channels are meant to move", () => {
  assert.equal(nextVersion("0.36.0", 12), "0.36.0-next.12");
  assert.equal(previewVersion("0.36.0", 12, 40), "0.36.0-next.12.preview.40");
  assert.throws(() => previewVersion("0.36.0", 12, "0"), /run number/);
  assert.ok(isNextVersion("0.36.0-next.0"));
  assert.ok(!isNextVersion("0.36.0-next.01"));
  assert.ok(!isNextVersion("0.36.0-next.12.preview.4"));
  assert.ok(!isNextVersion("0.36.0-preview.17"));
});

test("a real history: next on main, patches between, previews from a branch", (t) => {
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
  const commit = (message) => git("commit", "--allow-empty", "-q", "-m", message);
  const cwd = process.cwd();
  process.chdir(repo);
  t.after(() => process.chdir(cwd));

  git("init", "-q", "-b", "main");
  commit("one");
  git("tag", "v0.38.0");
  commit("two");
  commit("three");
  assert.equal(nextVersionOf(), "0.39.0-next.2");
  git("tag", "v0.38.1");
  commit("four");
  assert.equal(nextVersionOf(), "0.39.0-next.3");
  assert.equal(nextVersionOf("HEAD~1"), "0.39.0-next.2");

  git("checkout", "-q", "-b", "feature", "HEAD~1");
  commit("feature one");
  commit("feature two");
  // N of the merge base (next.2), not of the branch tip.
  assert.equal(previewVersionOf("HEAD", "main", 7), "0.39.0-next.2.preview.7");

  git("checkout", "-q", "main");
  git("tag", "v0.39.0");
  commit("five");
  assert.equal(nextVersionOf(), "0.40.0-next.1");
  // An old branch keeps the base it was cut from, so it sorts below what main ships now.
  assert.equal(previewVersionOf("feature", "feature", 8), "0.39.0-next.4.preview.8");
});
