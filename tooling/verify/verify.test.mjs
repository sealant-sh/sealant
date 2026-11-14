import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeResult, EXIT_CODES } from "./result.mjs";

const CLI = fileURLToPath(new URL("verify.mjs", import.meta.url));
const verify = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

// `verify check` is not run here (it runs the repo's whole lint, typecheck and test suite); its
// result is built by the same makeResult, which validates, and check.test.mjs covers its steps.
test("every verb prints one result on stdout with --json, valid against the schema, with its exit code", () => {
  const cases = [
    [["plan", "--files", "packages/workspaces/src/images/boat/catalog.ts", "--json"], 0, "passed"],
    // Its status depends on this checkout's tree; its exit code must follow it.
    [["status", "--base", "HEAD", "--json"], undefined, undefined],
    ...["db", "formal", "stack", "runtime", "boat-harness", "evidence"].map((verb) => [
      [verb, "--json"],
      4,
      "not_implemented",
    ]),
  ];
  for (const [args, code, status] of cases) {
    const run = verify(...args);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `${args[0]} prints exactly one document`);
    const result = decodeResult(JSON.parse(lines[0]));
    assert.equal(result.verb, args[0]);
    assert.equal(result.status, status ?? result.status);
    assert.equal(run.status, code ?? EXIT_CODES[result.status], `${args.join(" ")}: ${run.stderr}`);
  }
});

test("no verb, or help, lists the verbs; a wrong verb or option is a usage error", () => {
  for (const args of [[], ["help"]]) {
    const run = verify(...args);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /^ {2}check {2}/m);
  }
  assert.equal(verify("deploy").status, 2);
  assert.equal(verify("check", "--files", "x").status, 2);
  assert.equal(verify("plan", "--nope").status, 2);
});
