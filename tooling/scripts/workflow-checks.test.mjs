import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// The Version workflow approves the Version Packages PR's held pull_request runs, so its required
// checks run. A fake `gh` serves the PR and its runs through the step's real `--jq` filters (with
// jq, which gh's filters match here) and records each approval.
const approveStep = () => {
  const { jobs } = parse(
    readFileSync(new URL("../../.github/workflows/version.yml", import.meta.url), "utf8"),
  );
  return jobs["approve-checks"].steps[0];
};

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
jq_arg() { while [ $# -gt 0 ]; do [ "$1" = --jq ] && { printf '%s' "$2"; return; }; shift; done; }
case "$1 $2" in
  "pr view") jq -r "$(jq_arg "$@")" "$FAKE_DIR/pr.json" ;;
  "api -X") echo "$4" >>"$FAKE_DIR/approved" ;;
  api*) jq -r "$(jq_arg "$@")" "$FAKE_DIR/runs.json" ;;
  *) exit 64 ;;
esac
`;

const HEAD = "f".repeat(40);
const run = (id, workflow, conclusion, actor = "github-actions[bot]") => ({
  id,
  path: `.github/workflows/${workflow}`,
  head_branch: "changeset-release/main",
  conclusion,
  actor: { login: actor },
});

const approve = (runs) => {
  const dir = mkdtempSync(join(tmpdir(), "approve-checks-"));
  writeFileSync(join(dir, "gh"), FAKE_GH, { mode: 0o755 });
  writeFileSync(
    join(dir, "pr.json"),
    JSON.stringify({ headRefName: "changeset-release/main", headRefOid: HEAD }),
  );
  writeFileSync(join(dir, "runs.json"), JSON.stringify({ workflow_runs: runs }));
  const step = approveStep();
  const { status } = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_DIR: dir,
      GH_REPO: "sealant-sh/sealant",
      PR: "404",
      TRIES: "2",
      POLL_SECONDS: "0",
    },
    encoding: "utf8",
  });
  const approved = existsSync(join(dir, "approved"))
    ? readFileSync(join(dir, "approved"), "utf8").trim().split("\n")
    : [];
  rmSync(dir, { recursive: true });
  return { status, approved };
};

test("Version approves only the held CI and Kubernetes e2e runs its own push created", () => {
  assert.deepEqual(
    approve([
      run(3, "boat-harness.yml", "action_required"),
      run(2, "kubernetes-e2e.yml", null),
      run(1, "ci.yml", "action_required"),
    ]),
    { status: 0, approved: ["repos/sealant-sh/sealant/actions/runs/1/approve"] },
  );
});

test("Version approves no held run that someone else triggered", () => {
  const { status, approved } = approve([
    run(2, "kubernetes-e2e.yml", null),
    run(1, "ci.yml", "action_required", "someone"),
  ]);
  assert.notEqual(status, 0);
  assert.deepEqual(approved, []);
});

test("Version fails when a required workflow never starts a run on the head", () => {
  assert.deepEqual(approve([run(1, "ci.yml", "action_required")]), {
    status: 1,
    approved: ["repos/sealant-sh/sealant/actions/runs/1/approve"],
  });
});
