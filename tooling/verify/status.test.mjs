import assert from "node:assert/strict";
import test from "node:test";

import { makeResult } from "./result.mjs";
import { judge, toMarkdown } from "./status.mjs";

const sha = "c".repeat(40);
const head = { sha, branch: "b", dirty: false, base: "origin/main", mergeBase: "d".repeat(40) };
const owed = [
  {
    id: "pre-pr:tests",
    kind: "tests",
    why: "w",
    status: "owed",
    command: "pnpm verify check",
    proof: "check",
  },
];
const checkResult = (overrides, status = "passed") => ({
  file: ".verify/results/check.json",
  result: makeResult({
    verb: "check",
    head: { ...head, ...overrides },
    startedAt: new Date(),
    steps: [{ id: "tests", title: "t", status }],
    proves: ["check"],
  }),
});
const judgeWith = (latest, items = owed) =>
  judge({ owed: items, latest, head, implemented: new Set(["plan", "check", "status"]) });

test("only a passing result for this exact commit, from a clean tree, discharges an obligation", () => {
  assert.equal(judgeWith([checkResult({})])[0].status, "passed");
  assert.equal(judgeWith([checkResult({ dirty: true })])[0].status, "skipped");
  assert.equal(judgeWith([checkResult({ sha: "e".repeat(40) })])[0].status, "skipped");
  assert.equal(judgeWith([checkResult({}, "skipped")])[0].status, "skipped");
  assert.equal(judgeWith([])[0].status, "skipped");
});

test("an obligation whose verb does not exist yet says so, and an external one needs an observer", () => {
  const [db, live] = judgeWith(
    [],
    [
      {
        id: "x:tests:boat-catalog",
        kind: "tests",
        why: "w",
        status: "owed",
        proof: "db:boat-catalog",
      },
      { id: "y:external", kind: "external", why: "w", status: "owed", proof: "runtime:boat-live" },
    ],
  );
  assert.equal(db.status, "not_implemented");
  assert.equal(live.status, "requires_external_observer");
});

test("the receipt has one line per obligation, ticked only when passed, with its evidence", () => {
  const markdown = toMarkdown({ head, judged: judgeWith([checkResult({})]) });
  assert.match(
    markdown,
    /^- \[x\] \*\*pre-pr:tests\*\*: passed \(`\.verify\/results\/check\.json`\)/m,
  );
});
