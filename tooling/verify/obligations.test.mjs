import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { ciJobsFor, loadObligations, owedFor, pullRequestTrigger } from "./plan.mjs";
import { REPO_ROOT } from "./repo.mjs";

const workflows = readdirSync(path.join(REPO_ROOT, ".github/workflows"))
  .filter((file) => file.endsWith(".yml"))
  .map((file) => ({
    file,
    workflow: parse(readFileSync(path.join(REPO_ROOT, ".github/workflows", file), "utf8")),
  }));
const map = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "tooling/verify/obligations.json"), "utf8"),
);
const obligations = loadObligations(REPO_ROOT);

// CI decides from paths in exactly one way: a workflow's pull_request path filter. The map reads
// those filters (`pathsFrom`) rather than copying them, so they cannot drift; this test makes sure
// no path-filtered workflow is left out of the map, and no map entry names a filter that is gone.
test("every path-filtered pull-request workflow is an obligation that reads its filter", () => {
  const filtered = workflows.filter(
    ({ workflow }) => pullRequestTrigger(workflow)?.paths !== undefined,
  );
  assert.ok(filtered.length > 0, "boat-harness.yml at least is path-filtered");
  for (const { file, workflow } of filtered) {
    const readers = map.obligations.filter((entry) => entry.pathsFrom?.workflow === file);
    assert.equal(readers.length, 1, `${file} has one obligation with pathsFrom`);
    const [reader] = readers;
    const resolved = obligations.find((entry) => entry.id === reader.id);
    assert.deepEqual(resolved.paths, pullRequestTrigger(workflow).paths);
    for (const owe of reader.owes.filter((item) => item.ci !== undefined)) {
      assert.equal(owe.ci, workflow.name, `${reader.id} names ${file}'s workflow`);
    }
  }
  assert.equal(
    workflows.filter(({ workflow }) => pullRequestTrigger(workflow)?.pathsIgnore !== undefined)
      .length,
    0,
    "paths-ignore is not read by the map yet; teach plan.mjs before adding one",
  );
});

test("a change to a Boat image file owes the catalog suite, the harness and nothing for the web", () => {
  const ids = owedFor(obligations, ["packages/workspaces/src/images/boat/catalog.ts"]).map(
    (item) => item.id,
  );
  assert.ok(ids.includes("boat-catalog:tests:boat-catalog"));
  assert.ok(
    ids.includes("boat-harness:harness:boat"),
    "boat-harness.yml's filter covers images/boat",
  );
  assert.ok(ids.includes("pre-pr:tests"));
  assert.ok(!ids.some((id) => id.startsWith("web-ui")));
});

test("a covered Boat custody file owes the model; a docs-only change owes only the pre-PR checks", () => {
  const custody = owedFor(obligations, ["packages/db/src/repositories/boat-runs.ts"]).map(
    (item) => item.id,
  );
  assert.ok(custody.includes("boat-custody:formal:boat-custody"));
  assert.deepEqual(
    owedFor(obligations, ["docs/turbo.md"]).map((item) => item.id),
    ["pre-pr:tests"],
  );
});

const jobsOf = (files) => ciJobsFor(REPO_ROOT, files).map(({ workflow }) => workflow);

test("the plan lists the Boat harness jobs only when its path filter matches", () => {
  assert.ok(!jobsOf(["docs/turbo.md"]).includes("Boat harness"));
  assert.ok(jobsOf(["docs/turbo.md"]).includes("CI"), "CI runs on every pull request");
  assert.ok(jobsOf(["packages/workspaces/boat-harness/up.ts"]).includes("Boat harness"));
});
