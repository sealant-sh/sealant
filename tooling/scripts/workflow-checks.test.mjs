import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

// Branch protection requires one roll-up result per workflow, not each job by name. A job left out
// of its roll-up's `needs` can be red or still running when a pull request merges.
const ROLL_UPS = { "ci.yml": "checks", "kubernetes-e2e.yml": "e2e checks" };

const rollUpOf = (file) => {
  const { jobs } = parse(
    readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8"),
  );
  const named = Object.entries(jobs).filter(([, job]) => job.name === ROLL_UPS[file]);
  assert.equal(named.length, 1, `${file} has one job named "${ROLL_UPS[file]}"`);
  const [[id, job]] = named;
  return { id, job, others: Object.keys(jobs).filter((other) => other !== id) };
};

for (const file of Object.keys(ROLL_UPS)) {
  test(`${file}'s "${ROLL_UPS[file]}" needs every other job and runs whatever they did`, () => {
    const { job, others } = rollUpOf(file);
    assert.deepEqual([job.needs].flat().toSorted(), others.toSorted());
    // `!cancelled()` would skip the roll-up when the run is cancelled, and a skipped required
    // check counts as passed.
    assert.equal(job.if, "always()");
    for (const skippable of JSON.parse(job.steps[0].env.MAY_SKIP)) {
      assert.ok(others.includes(skippable), `${skippable} in MAY_SKIP is a job of ${file}`);
    }
  });
}

/** Runs a roll-up's gate as the runner does, with `needs` as GitHub serializes it. */
const gate = (step, results, maySkip = step.env.MAY_SKIP) =>
  spawnSync("bash", ["-e", "-c", step.run], {
    env: {
      ...process.env,
      RESULTS: JSON.stringify(
        Object.fromEntries(
          Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }]),
        ),
      ),
      MAY_SKIP: maySkip,
    },
    encoding: "utf8",
  }).status;

for (const file of Object.keys(ROLL_UPS)) {
  test(`${file}'s roll-up passes only when every job succeeded or was allowed to skip`, () => {
    const { job, others } = rollUpOf(file);
    const step = job.steps[0];
    const all = (result) => Object.fromEntries(others.map((other) => [other, result]));
    const [first] = others;
    assert.equal(gate(step, all("success")), 0, "every job succeeded");
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.notEqual(gate(step, { ...all("success"), [first]: result }), 0, `${first} ${result}`);
    }
    assert.equal(
      gate(step, { ...all("success"), [first]: "skipped" }, JSON.stringify([first])),
      0,
      "a job on the allow-list may skip",
    );
    assert.notEqual(gate(step, {}), 0, "no results at all");
  });
}
