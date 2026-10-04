/**
 * Reading a run's changes must never change git state: the script stages into a throwaway index,
 * and the repository's own index keeps its exact bytes — partial staging included. Run for real
 * against git in a temporary repository.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

const readWith = (dir: string, env: NodeJS.ProcessEnv) =>
  execFileSync("sh", ["-c", workingTreeChangesScript()], { cwd: dir, encoding: "utf8", env });

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

  it("keeps a refreshed copy of the index, so the next reading rehashes nothing it need not", async () => {
    const dir = await repo();
    const temp = await mkdtemp(path.join(tmpdir(), "sealant-keep-"));
    dirs.push(temp);
    const env = { ...process.env, TMPDIR: temp };
    const read = () =>
      splitWorkingTreeChanges(
        execFileSync("sh", ["-c", workingTreeChangesScript()], { cwd: dir, encoding: "utf8", env }),
      );
    // An index whose stat data no longer matches the files: each file rewritten with the same
    // bytes through a rename (a new inode), as a restore that lays files down after git wrote the
    // index leaves it. git must then rehash every file each time it reads that index.
    git(dir, "add", "b.txt");
    for (const name of ["a.txt", "b.txt"]) {
      const file = path.join(dir, name);
      await writeFile(`${file}.tmp`, await readFile(file));
      await rename(`${file}.tmp`, file);
    }
    const indexPath = path.join(dir, ".git", "index");
    const before = await readFile(indexPath);
    const inodes = (index: string) =>
      execFileSync("git", ["ls-files", "--debug"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, GIT_INDEX_FILE: index },
      })
        .split("\n")
        .filter((line) => line.trim().startsWith("dev:"))
        .map((line) => Number(/ino:\s*(\d+)/.exec(line)?.[1]));
    const onDisk = await Promise.all(
      ["a.txt", "b.txt"].map(async (name) => (await stat(path.join(dir, name))).ino),
    );
    // b.txt's bytes are what the index holds (a.txt carries an unstaged edit, which is hashed
    // whatever its stat data says).
    expect(inodes(indexPath)[1]).not.toBe(onDisk[1]);

    const first = read();
    const kept = (await readdir(temp)).filter((name) => name.startsWith("sealant-index-"));
    expect(kept).toHaveLength(1);
    // Same entries as the repository's index, with b.txt's stat data as it is now.
    expect(inodes(path.join(temp, kept[0] ?? ""))[1]).toBe(onDisk[1]);
    expect(read()).toEqual(first);
    expect(first.nameStatus.trim().split("\n").toSorted()).toEqual([
      "A\tc.txt",
      "M\ta.txt",
      "M\tb.txt",
    ]);
    // The repository's own index was never written.
    expect((await readFile(indexPath)).equals(before)).toBe(true);

    // Once the repository's index changes, the next reading starts from it, and the old copy goes.
    await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(dir, "ignored.txt"), "forced\n");
    git(dir, "add", "-f", "ignored.txt");
    expect(read().nameStatus).toContain("A\tignored.txt");
    const keptNow = (await readdir(temp)).filter((name) => name.startsWith("sealant-index-"));
    expect(keptNow).toHaveLength(1);
    expect(keptNow[0]).not.toBe(kept[0]);
  });

  /** A directory of PATH shims put in front of the real tools, and the environment to run with. */
  const shims = async (temp: string, scripts: Record<string, string>) => {
    const bin = await mkdtemp(path.join(tmpdir(), "sealant-shims-"));
    dirs.push(bin);
    for (const [name, body] of Object.entries(scripts)) {
      const real = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
      await writeFile(path.join(bin, name), `#!/bin/sh\nREAL=${real}\n${body}\n`, { mode: 0o755 });
    }
    return { ...process.env, TMPDIR: temp, PATH: `${bin}:${process.env.PATH ?? ""}` };
  };

  it("never keeps an index replaced between its checksum and its copy under the other's key", async () => {
    const dir = await repo();
    const temp = await mkdtemp(path.join(tmpdir(), "sealant-keep-"));
    dirs.push(temp);
    const indexPath = path.join(dir, ".git", "index");
    // Index A holds a force-added ignored file; index B, the same tree without it.
    await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(dir, "ignored.txt"), "forced\n");
    git(dir, "add", "-f", "ignored.txt");
    const indexA = await readFile(indexPath);
    git(dir, "rm", "-q", "--cached", "ignored.txt");
    const indexB = path.join(temp, "index-b");
    await writeFile(indexB, await readFile(indexPath));
    await writeFile(indexPath, indexA);
    // The index is replaced by B right after the reading checksums what it read as A.
    const env = await shims(temp, {
      cksum: [
        'n=$(cat "$TMPDIR/.calls" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$TMPDIR/.calls"',
        '"$REAL" "$@"; code=$?',
        `[ "$n" = 2 ] && cp "${indexB}" "${indexPath}"`,
        "exit $code",
      ].join("\n"),
    });
    readWith(dir, env);
    // A again: the reading must see A's force-added file, from the cache or not.
    await writeFile(indexPath, indexA);
    const plain = { ...process.env, TMPDIR: temp };
    expect(splitWorkingTreeChanges(readWith(dir, plain)).nameStatus).toContain("A\tignored.txt");
    expect(splitWorkingTreeChanges(readWith(dir, plain)).nameStatus).toContain("A\tignored.txt");
  });

  it("falls back to the repository's index when a kept copy goes while it is being read", async () => {
    const dir = await repo();
    const temp = await mkdtemp(path.join(tmpdir(), "sealant-keep-"));
    dirs.push(temp);
    const plain = { ...process.env, TMPDIR: temp };
    const first = readWith(dir, plain);
    expect((await readdir(temp)).some((name) => name.startsWith("sealant-index-"))).toBe(true);
    // Another reader's cleanup removes the kept copy just as this one copies it.
    const env = await shims(temp, {
      cp: [
        'for a in "$@"; do case "$a" in */sealant-index-*-*) rm -f "$a" ;; esac; done',
        'exec "$REAL" "$@"',
      ].join("\n"),
    });
    const second = execFileSync("sh", ["-c", workingTreeChangesScript()], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    expect(second).toBe(first);
    expect(splitWorkingTreeChanges(second).nameStatus.trim().split("\n").toSorted()).toEqual([
      "A\tc.txt",
      "M\ta.txt",
      "M\tb.txt",
    ]);
  });

  it("uses no kept copy whose bytes are not the ones it is named for", async () => {
    const dir = await repo();
    const temp = await mkdtemp(path.join(tmpdir(), "sealant-keep-"));
    dirs.push(temp);
    const plain = { ...process.env, TMPDIR: temp };
    const first = readWith(dir, plain);
    const [kept] = (await readdir(temp)).filter((name) => name.startsWith("sealant-index-"));
    await writeFile(path.join(temp, kept ?? "missing"), "not an index");
    expect(readWith(dir, plain)).toBe(first);
  });

  it("still reports an edit of the same size made in the same second as the reading before it", async () => {
    // git trusts an entry's stat data only when the file is older than the index file itself; a
    // kept copy stamped "now" made the refreshed entry look settled (review round 3, F1).
    const dir = await repo();
    const temp = await mkdtemp(path.join(tmpdir(), "sealant-keep-"));
    dirs.push(temp);
    const plain = { ...process.env, TMPDIR: temp };
    await writeFile(path.join(dir, "foo.txt"), "aaaa\n");
    git(dir, "add", "foo.txt");
    git(dir, "commit", "-qm", "foo");
    const foo = path.join(dir, "foo.txt");
    let tried = 0;
    for (;;) {
      tried += 1;
      // Start at the top of a second, so the rewrite, the reading and the edit share it.
      await new Promise((resolve) => setTimeout(resolve, 1_000 - (Date.now() % 1_000) + 10));
      const second = Math.floor(Date.now() / 1_000);
      await writeFile(foo, "aaaa\n");
      readWith(dir, plain);
      await writeFile(foo, "bbbb\n");
      const sameSecond = Math.floor((await stat(foo)).mtimeMs / 1_000) === second;
      if (sameSecond || tried >= 3) {
        expect(sameSecond).toBe(true);
        break;
      }
      await writeFile(foo, "aaaa\n");
    }
    // The next readings come in a later second, from the kept copy.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(splitWorkingTreeChanges(readWith(dir, plain)).nameStatus).toContain("M\tfoo.txt");
    expect(splitWorkingTreeChanges(readWith(dir, plain)).nameStatus).toContain("M\tfoo.txt");
  });

  it("exits nonzero, never an empty change, when staging the working tree fails", async () => {
    const dir = await repo();
    const temp = await mkdtemp(path.join(tmpdir(), "sealant-keep-"));
    dirs.push(temp);
    const locked = path.join(dir, "locked.txt");
    await writeFile(locked, "secret\n");
    await chmod(locked, 0o000);
    try {
      await readFile(locked);
      // Permission bits do not bind this process (root): nothing to show here.
      return;
    } catch {
      // Unreadable, as intended.
    }
    expect(() => readWith(dir, { ...process.env, TMPDIR: temp })).toThrow();
    await chmod(locked, 0o644);
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
