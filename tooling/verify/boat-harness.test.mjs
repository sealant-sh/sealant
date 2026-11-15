import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { groupsFor, harnessGroups, stateSteps } from "./boat-harness.mjs";
import { REPO_ROOT } from "./repo.mjs";

const groupsOf = (...files) => groupsFor(REPO_ROOT, files).groups.map(({ group }) => group);
const ALL = ["lifecycle", "faults", "daemon", "no-resources"];
const statuses = (state) =>
  Object.fromEntries(
    stateSteps(state, { withTwin: true }).steps.map((step) => [step.id, step.status]),
  );

test("the groups are boat-harness.yml's four, each with a harness file that exists", () => {
  const groups = harnessGroups(REPO_ROOT);
  assert.deepEqual(groups.map(({ group }) => group).toSorted(), ALL.toSorted());
  for (const { file } of groups) assert.ok(existsSync(path.join(REPO_ROOT, file)), file);
});

// A local run of the wrong groups proves nothing about the change; a run of all four costs an hour.
test("a diff needs the groups whose harness files reach what it changed", () => {
  const harness = "packages/workspaces/boat-harness";
  assert.deepEqual(groupsOf("docs/turbo.md"), [], "no harness path");
  assert.deepEqual(
    groupsOf(`${harness}/link-scenario.ts`),
    ["faults"],
    "only faults.harness.ts imports it",
  );
  assert.deepEqual(groupsOf(`${harness}/daemon-scenario.ts`), ["daemon"]);
  assert.deepEqual(
    groupsOf(`${harness}/faults.ts`).toSorted(),
    ALL.toSorted(),
    "every group uses it",
  );
  assert.deepEqual(groupsOf(`${harness}/shared-stop-scenario.ts`).toSorted(), [
    "lifecycle",
    "no-resources",
  ]);
  assert.deepEqual(
    groupsOf("packages/workspaces/src/runtime/boat/vm.ts").toSorted(),
    ALL.toSorted(),
    "product code",
  );
  assert.deepEqual(
    groupsOf(`${harness}/twin/Dockerfile`).toSorted(),
    ALL.toSorted(),
    "the twin image",
  );
  assert.deepEqual(
    groupsOf(`${harness}/reap.test.ts`, `${harness}/README.md`),
    [],
    "unit tests, docs",
  );
});

test("a held lock, a finished run's objects or another deployment's objects block a run", () => {
  const free = {
    lock: { state: "free" },
    leftovers: [],
    foreign: [],
    twin: { tag: "t", cached: false },
  };
  assert.deepEqual(statuses(free), {
    lock: "passed",
    leftovers: "passed",
    foreign: "passed",
    twin: "passed",
  });
  assert.equal(
    statuses({ ...free, lock: { state: "live", run: "ab12" } }).lock,
    "blocked_by_prerequisite",
  );
  assert.equal(
    statuses({ ...free, lock: { state: "stale", run: "ab12" } }).lock,
    "passed",
    "taken over",
  );
  const left = stateSteps({ ...free, leftovers: ["cd34"] }, { withTwin: false });
  assert.equal(
    left.steps.find((step) => step.id === "leftovers").status,
    "blocked_by_prerequisite",
  );
  assert.match(left.next[0], /cleanup\.ts --remove/);
  assert.equal(statuses({ ...free, foreign: ["sealant-gw-x"] }).foreign, "blocked_by_prerequisite");
  assert.equal(stateSteps(null, { withTwin: false }).steps[0].status, "blocked_by_prerequisite");
});
