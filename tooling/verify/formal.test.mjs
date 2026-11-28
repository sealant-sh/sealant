import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  driftGuard,
  driftSinceSync,
  fetchCommit,
  formalAreas,
  obligationPaths,
  parseCoverage,
  touchedAreas,
} from "./formal.mjs";
import { loadObligations } from "./plan.mjs";
import { REPO_ROOT } from "./repo.mjs";

/** A git repository with one model, `docs/formal/m`, covering `src/covered.ts`, at sync `base`. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "verify-formal-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  mkdirSync(path.join(root, "docs/formal/m"), { recursive: true });
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/covered.ts"), "1\n");
  writeFileSync(path.join(root, "docs/formal/m/Model.tla"), "---- MODULE Model ----\n");
  writeFileSync(path.join(root, "docs/formal/m/COVERAGE"), "sync base\npath src/covered.ts\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const mergeBase = git("rev-parse", "HEAD");
  const [area] = formalAreas(root);
  return {
    root,
    git,
    area,
    mergeBase,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the drift guard fails covered code that moved alone, and passes it with its model or sync", () => {
  const { root, area, mergeBase, cleanup } = fixture();
  try {
    const guard = (files) => driftGuard({ root, area, mergeBase, files }).status;
    assert.equal(guard(["src/covered.ts"]), "failed", "covered code alone");
    assert.equal(guard(["src/covered.ts", "docs/formal/m/Model.tla"]), "passed", "with the model");
    assert.equal(guard(["README.md"]), "passed", "no covered code");
    // COVERAGE changing without its sync line (a new path, say) is not the model moving.
    assert.equal(
      guard(["src/covered.ts", "docs/formal/m/COVERAGE"]),
      "failed",
      "COVERAGE, same sync",
    );
    writeFileSync(
      path.join(root, "docs/formal/m/COVERAGE"),
      `sync ${mergeBase}\npath src/covered.ts\n`,
    );
    const moved = formalAreas(root)[0];
    assert.equal(
      driftGuard({
        root,
        area: moved,
        mergeBase,
        files: ["src/covered.ts", "docs/formal/m/COVERAGE"],
      }).status,
      "passed",
      "sync moved",
    );
  } finally {
    cleanup();
  }
});

test("a COVERAGE line that is neither sync nor path is refused, not ignored", () => {
  assert.deepEqual(parseCoverage("# c\nsync abc\n\npath a/b.ts\n"), {
    sync: "abc",
    paths: ["a/b.ts"],
  });
  assert.equal(parseCoverage("path a.ts\n"), null);
  assert.throws(() => parseCoverage("sync abc\npaths a.ts\n"));
  assert.throws(() => parseCoverage("sync abc\npath a.ts b.ts\n"));
});

test("every model's covered files exist, and the map owes each model exactly for its COVERAGE", () => {
  const areas = formalAreas(REPO_ROOT);
  assert.ok(areas.some((area) => area.area === "boat-custody"));
  const map = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "tooling/verify/obligations.json"), "utf8"),
  );
  const obligations = loadObligations(REPO_ROOT);
  for (const area of areas) {
    for (const file of area.coverage.paths) {
      assert.doesNotThrow(() => readFileSync(path.join(REPO_ROOT, file)), `${file} is covered`);
    }
    const readers = map.obligations.filter((entry) => entry.pathsFrom?.formal === area.area);
    assert.equal(readers.length, 1, `${area.area} has one obligation reading its COVERAGE`);
    const owed = obligations.find((entry) => entry.id === readers[0].id);
    for (const file of area.coverage.paths) assert.ok(touchedAreas([area], [file]).length === 1);
    assert.deepEqual(owed.paths, obligationPaths(area));
  }
});

test("a change to the checker every model runs on owes every model", () => {
  const areas = formalAreas(REPO_ROOT);
  for (const file of [
    "docs/formal/tlx.sh",
    "docs/formal/checker.sh",
    ".github/actions/tlx/action.yml",
  ]) {
    assert.deepEqual(touchedAreas(areas, [file]), areas, file);
  }
  assert.deepEqual(touchedAreas(areas, ["docs/formal/README.md"]), []);
});

/** The area as its COVERAGE reads after `sync` is set to `sync` in the working tree. */
function withSync(root, sync) {
  writeFileSync(path.join(root, "docs/formal/m/COVERAGE"), `sync ${sync}\npath src/covered.ts\n`);
  return formalAreas(root)[0];
}

test("a moved sync must be a full SHA this branch reaches, or the squash merge loses it", () => {
  const { root, git, mergeBase, cleanup } = fixture();
  try {
    const guard = (sync) =>
      driftGuard({
        root,
        area: withSync(root, sync),
        mergeBase,
        files: ["src/covered.ts", "docs/formal/m/COVERAGE"],
      });
    // A commit of the branch: main or the pull request's last head keeps it.
    writeFileSync(path.join(root, "src/covered.ts"), "2\n");
    git("commit", "-q", "-am", "the change the model was read against");
    const branchCommit = git("rev-parse", "HEAD");
    assert.equal(guard(branchCommit).status, "passed", "a commit on this branch");
    assert.equal(guard(mergeBase).status, "passed", "a commit on main");

    const short = guard(branchCommit.slice(0, 10));
    assert.equal(short.status, "failed", "a short SHA");
    assert.match(short.detail, /full 40-character SHA/);

    // The rebase replaces the commit: the old one is on no branch the merge leaves behind.
    git("commit", "-q", "--amend", "-m", "the same change, rebased");
    const replaced = guard(branchCommit);
    assert.equal(replaced.status, "failed", "a commit a rebase replaced");
    assert.match(replaced.detail, /does not reach/);
    assert.match(replaced.detail, /re-point it after every rebase/);

    // The guard holds even when the model changed too, and even with no covered file changed.
    assert.equal(
      driftGuard({
        root,
        area: withSync(root, branchCommit),
        mergeBase,
        files: ["docs/formal/m/COVERAGE"],
      }).status,
      "failed",
      "only COVERAGE changed",
    );
  } finally {
    cleanup();
  }
});

test("drift names the model and why when its sync commit cannot be read, instead of throwing", () => {
  const { root, cleanup } = fixture();
  try {
    const gone = "f86ab004e2a723cf8a65650f4bea0b4e97a74c9d";
    const behind = driftSinceSync(root, withSync(root, gone));
    assert.equal(behind.files, null);
    assert.match(behind.detail, new RegExp(`^m's sync commit ${gone} is not in this clone`));
    assert.match(behind.detail, /squash merge/);
    assert.match(behind.detail, /docs\/formal\/m\/COVERAGE/);
  } finally {
    cleanup();
  }
});

test("a sync commit only a merged pull request's ref holds is fetched from origin by SHA", () => {
  const { root, git, cleanup } = fixture();
  const clone = mkdtempSync(path.join(tmpdir(), "verify-formal-clone-"));
  try {
    // The pull request's head, then its branch deleted: only refs/pull/1/head reaches it.
    git("checkout", "-q", "-b", "feature");
    writeFileSync(path.join(root, "src/covered.ts"), "2\n");
    git("commit", "-q", "-am", "feature");
    const head = git("rev-parse", "HEAD");
    git("update-ref", "refs/pull/1/head", head);
    git("checkout", "-q", "-");
    git("branch", "-q", "-D", "feature");
    execFileSync("git", ["clone", "-q", "--no-local", root, clone]);
    assert.throws(() =>
      execFileSync("git", ["cat-file", "-e", `${head}^{commit}`], { cwd: clone, stdio: "ignore" }),
    );
    assert.equal(fetchCommit(clone, head), true);
    const area = { ...formalAreas(clone)[0], coverage: { sync: head, paths: ["src/covered.ts"] } };
    assert.deepEqual(driftSinceSync(clone, area).files, ["src/covered.ts"]);
  } finally {
    rmSync(clone, { recursive: true, force: true });
    cleanup();
  }
});
