import assert from "node:assert/strict";
import test from "node:test";

import { decodeResult, EXIT_CODES, makeResult, STATUSES, worstStatus } from "./result.mjs";

const head = {
  sha: "a".repeat(40),
  branch: "b",
  dirty: false,
  base: "origin/main",
  mergeBase: null,
};
const step = (status) => ({ id: status, title: status, status });

test("a verb's status is the worst of its steps, in the shared order", () => {
  // Each status beats every status after it, so a skip can never roll up into a pass.
  for (const [rank, worse] of STATUSES.entries()) {
    for (const better of STATUSES.slice(rank + 1)) {
      assert.equal(worstStatus([better, worse, better]), worse, `${worse} over ${better}`);
    }
  }
  assert.equal(worstStatus([]), "passed");
  assert.equal(
    makeResult({
      verb: "check",
      head,
      startedAt: new Date(),
      steps: [step("passed"), step("skipped")],
    }).status,
    "skipped",
  );
});

test("only passed exits 0; skipped and its kind exit 4, never 0", () => {
  assert.deepEqual(Object.fromEntries(STATUSES.map((status) => [status, EXIT_CODES[status]])), {
    failed: 1,
    blocked_by_prerequisite: 3,
    skipped: 4,
    not_implemented: 4,
    requires_external_observer: 4,
    evidence_withheld: 4,
    passed: 0,
  });
  assert.equal(EXIT_CODES.usage, 2);
});

test("a result that names no commit, or a status outside the contract, is refused", () => {
  const valid = makeResult({ verb: "plan", head, startedAt: new Date(), steps: [step("passed")] });
  assert.doesNotThrow(() => decodeResult(valid));
  assert.throws(() => decodeResult({ ...valid, head: { ...head, sha: undefined } }));
  assert.throws(() => decodeResult({ ...valid, status: "ok" }));
  assert.throws(() => decodeResult({ ...valid, steps: [{ ...step("passed"), status: "green" }] }));
});
