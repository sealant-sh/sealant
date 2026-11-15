#!/usr/bin/env node
// `node tooling/verify/gate.mjs <obligation id>`, from a workflow's `changes` job: whether the jobs
// that map entry gates run. On a pull request the changed files are those of the checked-out merge
// commit against its first parent (the base branch), which needs `fetch-depth: 2`. Any other event
// (a push to main, a dispatch) runs everything. Writes `run=true|false` to $GITHUB_OUTPUT when set.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gateHit } from "./paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [id] = process.argv.slice(2);
if (id === undefined) {
  console.error("usage: gate.mjs <obligation id>");
  process.exit(2);
}
const { obligations } = JSON.parse(
  readFileSync(path.join(root, "tooling/verify/obligations.json"), "utf8"),
);

let run = true;
let why = `${process.env.GITHUB_EVENT_NAME ?? "a local run"}: every job runs`;
if (process.env.GITHUB_EVENT_NAME === "pull_request") {
  const files = execFileSync("git", ["diff", "--name-only", "HEAD^1", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file.length > 0);
  const hit = gateHit(obligations, id, files);
  run = hit !== undefined;
  why = run
    ? `${hit} is covered by ${id}`
    : `none of the ${files.length} changed files is covered by ${id}`;
}
console.log(`${id}: ${run ? "runs" : "skips"} (${why})`);
if (process.env.GITHUB_OUTPUT !== undefined) {
  appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}
