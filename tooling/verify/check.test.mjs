import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { classifySkips, loadAllowedSkips, runTestsStep } from "./check.mjs";
import { REPO_ROOT } from "./repo.mjs";

const FIXTURE = "tooling/verify/fixtures/skips/gated.fixture.mjs";
const allowFixture = [
  {
    files: [FIXTURE],
    gate: ["VERIFY_FIXTURE_GATE"],
    suite: "fixture",
    allowedIn: ["check"],
    reason: "test fixture",
  },
];

/** Runs the fixture suite through vitest with the verify reporter, as `verify check` runs tests. */
const runFixture = ({ env = {}, allowedSkips = [], owedSuites = [] } = {}) =>
  runTestsStep({
    root: REPO_ROOT,
    id: "tests",
    title: "fixture",
    argv: [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--config",
      "tooling/verify/fixtures/skips/vitest.config.mjs",
    ],
    env,
    logFile: path.join(mkdtempSync(path.join(tmpdir(), "verify-check-test-")), "tests.log"),
    context: "check",
    owedSuites,
    allowedSkips,
    echo: false,
  });

test("a suite that skips itself makes the step skipped, naming the test and why", async () => {
  const { step } = await runFixture();
  assert.equal(step.status, "skipped");
  assert.deepEqual(step.skipped, [
    {
      name: "gated > runs only with VERIFY_FIXTURE_GATE",
      file: FIXTURE,
      gate: "unlisted in tooling/verify/allowed-skips.json",
    },
  ]);
});

test("the same suite passes once its gate is set, and an allowed skip passes unless it is owed", async () => {
  assert.equal((await runFixture({ env: { VERIFY_FIXTURE_GATE: "on" } })).step.status, "passed");
  assert.equal((await runFixture({ allowedSkips: allowFixture })).step.status, "passed");
  const owed = await runFixture({ allowedSkips: allowFixture, owedSuites: ["fixture"] });
  assert.equal(owed.step.status, "skipped");
  assert.equal(owed.step.skipped[0].gate, "VERIFY_FIXTURE_GATE");
});

test("a failing run is failed even when tests also skipped", async () => {
  const { step } = await runFixture({ env: { VERIFY_FIXTURE_GATE: "off" } });
  assert.equal(step.status, "failed");
});

test("the Boat catalog and retention cases are refused when the diff owes boat-catalog", () => {
  const allowedSkips = loadAllowedSkips(REPO_ROOT);
  const tests = [
    "catalog.db.test.ts",
    "retention.db.test.ts",
    "../../runtime/boat/allocation.db.test.ts",
  ].map((file) => ({
    file: path.join(REPO_ROOT, "packages/workspaces/src/images/boat", file),
    name: "a case",
    state: "skipped",
  }));
  const owed = classifySkips({
    root: REPO_ROOT,
    tests,
    allowedSkips,
    context: "check",
    owedSuites: ["boat-catalog"],
  });
  assert.deepEqual(
    owed.refused.map(({ gate }) => gate),
    [
      "SEALANT_BOAT_CATALOG_TEST_DATABASE_URL + SEALANT_BOAT_RUNTIME_BUNDLE",
      "SEALANT_TEST_DATABASE_URL + SEALANT_BOAT_RUNTIME_BUNDLE",
    ],
  );
  assert.deepEqual(
    owed.allowed.map(({ suite }) => suite),
    ["database"],
  );
  const unowed = classifySkips({
    root: REPO_ROOT,
    tests,
    allowedSkips,
    context: "check",
    owedSuites: [],
  });
  assert.equal(unowed.refused.length, 0);
  const elsewhere = classifySkips({
    root: REPO_ROOT,
    tests,
    allowedSkips,
    context: "db",
    owedSuites: [],
  });
  assert.equal(elsewhere.refused.length, 3, "no skip is allowed outside the verbs an entry names");
});
