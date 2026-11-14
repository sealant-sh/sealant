// What `pnpm verify` reads from git, and how it runs a step's command with its output in a log.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const lines = (text) => text.split("\n").filter((line) => line !== "");

/**
 * The commit a result is about: its SHA, branch, whether the tree differs from it, and its merge
 * base with `base` (null when `base` is not a ref here, such as a clone without origin).
 */
export function readHead(root, base = "origin/main") {
  const sha = git(root, ["rev-parse", "HEAD"]);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let mergeBase = null;
  try {
    mergeBase = git(root, ["merge-base", "HEAD", base]);
  } catch {
    mergeBase = null;
  }
  return {
    sha,
    branch: branch === "HEAD" ? null : branch,
    dirty: git(root, ["status", "--porcelain"]) !== "",
    base,
    mergeBase,
  };
}

/**
 * Every path this branch changes against its merge base: committed, staged, unstaged and untracked.
 * A rename counts as both its old and its new path, since a change to either can owe something.
 */
export function changedFiles(root, mergeBase) {
  const committedAndTracked = lines(git(root, ["diff", "--name-only", "--no-renames", mergeBase]));
  const untracked = lines(git(root, ["ls-files", "--others", "--exclude-standard"]));
  return [...new Set([...committedAndTracked, ...untracked])].toSorted();
}

/**
 * Runs `argv` from `cwd`, teeing its output to `logFile` and to stderr (the human-readable stream),
 * and resolves with its exit code. A command that cannot start resolves with 127.
 */
export function runLogged({ argv, cwd, env, logFile, echo = true }) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile);
  log.write(`$ ${argv.join(" ")}\n`);
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const forward = (chunk) => {
      log.write(chunk);
      if (echo) process.stderr.write(chunk);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    // A child that cannot start emits `error` and may still emit `close`: settle on the first.
    let settled = false;
    const settle = (text, code) => {
      if (settled) return;
      settled = true;
      log.end(text, () => resolve(code));
    };
    child.on("error", (error) => settle(`\n${error.message}\n`, 127));
    child.on("close", (code, signal) =>
      settle(signal === null ? "" : `\nkilled by ${signal}\n`, code ?? 1),
    );
  });
}
