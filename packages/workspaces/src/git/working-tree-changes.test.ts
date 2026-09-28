/**
 * Reading a run's changes must never change git state: the script stages into a throwaway index,
 * and the repository's own index keeps its exact bytes — partial staging included. Run for real
 * against git in a temporary repository.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { splitWorkingTreeChanges, workingTreeChangesScript } from "./working-tree-changes.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });

const runScript = (cwd: string, script: string) =>
  execFileSync("sh", ["-c", script], { cwd, encoding: "utf8" });

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const repo = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sealant-changes-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  await writeFile(path.join(dir, "a.txt"), "one\n");
  await writeFile(path.join(dir, "b.txt"), "two\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  // The user's git state: b.txt staged, a.txt edited but deliberately NOT staged, c.txt new.
  await writeFile(path.join(dir, "b.txt"), "two staged\n");
  git(dir, "add", "b.txt");
  await writeFile(path.join(dir, "a.txt"), "one edited\n");
  await writeFile(path.join(dir, "c.txt"), "new\n");
  return dir;
};

describe("workingTreeChangesScript", () => {
  it("reports every change without writing the repository's index", async () => {
    const dir = await repo();
    const indexPath = path.join(dir, ".git", "index");
    const before = await readFile(indexPath);
    const stagedBefore = git(dir, "diff", "--cached", "--name-only");

    const { diff, nameStatus } = splitWorkingTreeChanges(
      runScript(dir, workingTreeChangesScript()),
    );

    expect(diff).toContain("+one edited");
    expect(diff).toContain("+two staged");
    expect(diff).toContain("+new");
    expect(nameStatus.trim().split("\n").toSorted()).toEqual(["A\tc.txt", "M\ta.txt", "M\tb.txt"]);
    // The user's index: byte-identical, and still stages only b.txt.
    expect((await readFile(indexPath)).equals(before)).toBe(true);
    expect(git(dir, "diff", "--cached", "--name-only")).toBe(stagedBefore);
    expect(git(dir, "status", "--porcelain").split("\n").filter(Boolean).toSorted()).toEqual([
      " M a.txt",
      "?? c.txt",
      "M  b.txt",
    ]);
  });

  it("prints nothing outside a repository", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sealant-norepo-"));
    dirs.push(dir);
    expect(splitWorkingTreeChanges(runScript(dir, workingTreeChangesScript()))).toEqual({
      diff: "",
      nameStatus: "",
    });
  });

  it("the previous capture (git add -A on the real index) restaged the user's index", async () => {
    // Documents the defect this replaced: the old command rewrote the index it read from.
    const dir = await repo();
    const indexPath = path.join(dir, ".git", "index");
    const before = await readFile(indexPath);
    runScript(dir, "git add -A >/dev/null 2>&1; git --no-pager diff --cached >/dev/null");
    expect((await readFile(indexPath)).equals(before)).toBe(false);
  });
});
