import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { ciJobsFor, loadObligations, matchesAny, owedFor, pullRequestTrigger } from "./plan.mjs";
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

test("a covered Boat custody or removal ledger file owes its model; a docs-only change owes only the pre-PR checks", () => {
  const custody = owedFor(obligations, ["packages/db/src/repositories/boat-runs.ts"]).map(
    (item) => item.id,
  );
  assert.ok(custody.includes("boat-custody:formal:boat-custody"));
  const ledger = owedFor(obligations, ["packages/workspaces/src/worker/capture-drain.ts"]).map(
    (item) => item.id,
  );
  assert.ok(ledger.includes("capture-removal:formal:capture-removal"));
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

// A gated job is the second way CI decides from paths (see obligations.json's $comment). The map
// entry, the workflow's `changes` job, the jobs' conditions and the roll-up's allowed skips must
// name the same jobs, or a job skips that the roll-up then refuses (or worse, allows).
const GATE_CONDITION = "needs.changes.outputs.run == 'true'";
const gated = map.obligations.filter((entry) => entry.gates !== undefined);

test("every gated job runs by its map entry, and its workflow's roll-up allows exactly those skips", () => {
  assert.ok(gated.length > 0, "kubernetes-e2e gates the Kubernetes e2e jobs");
  for (const entry of gated) {
    assert.ok(Array.isArray(entry.paths), `${entry.id} lists its own paths`);
    const { workflow } = workflows.find(({ file }) => file === entry.gates.workflow);
    assert.equal(pullRequestTrigger(workflow)?.paths, undefined, "no workflow-level path filter");
    const runs = workflow.jobs.changes.steps.map((step) => step.run ?? "").join("\n");
    assert.match(runs, new RegExp(`node tooling/verify/gate\\.mjs ${entry.id}\\b`));
    for (const owe of entry.owes.filter((item) => item.ci !== undefined)) {
      assert.equal(owe.ci, workflow.name);
    }
    const conditioned = Object.entries(workflow.jobs)
      .filter(([, job]) => String(job.if ?? "").includes("needs.changes"))
      .map(([id]) => id);
    assert.deepEqual(conditioned.toSorted(), entry.gates.jobs.toSorted());
    for (const id of entry.gates.jobs) {
      assert.equal(workflow.jobs[id].if, GATE_CONDITION, `${id} runs by the gate`);
      assert.ok([workflow.jobs[id].needs].flat().includes("changes"), `${id} needs changes`);
    }
    const rollUp = Object.values(workflow.jobs).find((job) => job.steps?.[0]?.env?.MAY_SKIP);
    assert.deepEqual(
      JSON.parse(rollUp.steps[0].env.MAY_SKIP).toSorted(),
      entry.gates.jobs.toSorted(),
    );
  }
});

test("the plan lists the Kubernetes e2e jobs only when the pull request touches what they cover", () => {
  const named = (files) => ciJobsFor(REPO_ROOT, files).map(({ job }) => job);
  for (const files of [["docs/turbo.md"], ["apps/web/src/routes/index.tsx"]]) {
    assert.ok(!named(files).includes("Docker runtime e2e"), files[0]);
    assert.ok(!named(files).includes("Kubernetes cross-node e2e (kind, generic RWX)"), files[0]);
    assert.ok(named(files).includes("e2e checks"), "the roll-up reports on every pull request");
  }
  const runtime = named(["packages/workspaces/src/sealantd/runtime.ts"]);
  assert.ok(runtime.includes("Docker runtime e2e"));
  assert.ok(runtime.includes("Kubernetes cross-node e2e (kind, generic RWX)"));
});

/** Repo-relative files the given entry files import, transitively, inside the repo's packages. */
const importClosure = (entries) => {
  const packages = new Map();
  for (const base of ["packages", "apps"]) {
    for (const name of readdirSync(path.join(REPO_ROOT, base))) {
      const manifest = path.join(REPO_ROOT, base, name, "package.json");
      if (existsSync(manifest)) {
        const { name: packageName, exports } = JSON.parse(readFileSync(manifest, "utf8"));
        packages.set(packageName, {
          dir: path.join(REPO_ROOT, base, name),
          exports: exports ?? {},
        });
      }
    }
  }
  const file = (candidate) => {
    const bare = candidate.replace(/\.m?js$/, "");
    return [
      candidate,
      `${bare}.ts`,
      `${bare}.mts`,
      `${bare}.tsx`,
      path.join(candidate, "index.ts"),
    ].find((option) => existsSync(option) && statSync(option).isFile());
  };
  const exported = (specifier) => {
    const match = /^(@sealant\/[^/]+)(\/.+)?$/.exec(specifier);
    const target = match === null ? undefined : packages.get(match[1]);
    if (target === undefined) return undefined;
    const key = `.${match[2] ?? ""}`;
    for (const [pattern, value] of Object.entries(target.exports)) {
      const resolved = typeof value === "string" ? value : (value.import ?? value.default);
      const [before, after = ""] = pattern.split("*");
      if (pattern === key) return file(path.join(target.dir, resolved));
      if (pattern.includes("*") && key.startsWith(before) && key.endsWith(after)) {
        const middle = key.slice(before.length, key.length - after.length);
        return file(path.join(target.dir, resolved.replace("*", middle)));
      }
    }
    return undefined;
  };
  const seen = new Set();
  const queue = entries.map((entry) => path.join(REPO_ROOT, entry));
  while (queue.length > 0) {
    const next = queue.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    for (const [, specifier] of readFileSync(next, "utf8").matchAll(
      /(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
    )) {
      const found = specifier.startsWith(".")
        ? file(path.resolve(path.dirname(next), specifier))
        : exported(specifier);
      if (found !== undefined) queue.push(found);
    }
  }
  return [...seen].map((absolute) => path.relative(REPO_ROOT, absolute));
};

/** The files a gated job's steps run: `pnpm --filter <pkg> test:e2e [paths]` and `exec tsx <file>`. */
const filesRunBy = (job) => {
  const runs = [];
  for (const step of job.steps) {
    for (const [, name, verb, rest] of String(step.run ?? "").matchAll(
      /pnpm --filter (@sealant\/[\w-]+) (test:e2e|exec tsx)([^\n]*)/g,
    )) {
      const dir = path.relative(
        REPO_ROOT,
        path.dirname(
          [
            ...["packages", "apps"].flatMap((base) =>
              readdirSync(path.join(REPO_ROOT, base)).map((entry) =>
                path.join(REPO_ROOT, base, entry, "package.json"),
              ),
            ),
          ].find(
            (manifest) =>
              existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name,
          ),
        ),
      );
      const args = rest
        .trim()
        .split(/\s+/)
        .filter((arg) => arg.length > 0 && !arg.startsWith("-"));
      const roots = args.length > 0 ? args : ["src"];
      for (const arg of roots) {
        const target = path.join(REPO_ROOT, dir, arg);
        if (statSync(target).isFile()) runs.push(path.join(dir, arg));
        else {
          for (const found of readdirSync(target, { recursive: true })) {
            if (String(found).endsWith(verb === "test:e2e" ? ".e2e.ts" : ".mts")) {
              runs.push(path.join(dir, arg, String(found)));
            }
          }
        }
      }
    }
  }
  return runs;
};

test("a gated entry's paths cover every file its jobs' suites import", () => {
  for (const entry of gated) {
    const { workflow } = workflows.find(({ file }) => file === entry.gates.workflow);
    const entries = entry.gates.jobs.flatMap((id) => filesRunBy(workflow.jobs[id]));
    assert.ok(entries.length > 5, `${entry.id}'s jobs run suites`);
    const uncovered = importClosure(entries).filter((file) => !matchesAny(file, entry.paths));
    assert.deepEqual(uncovered, [], `${entry.id} leaves files its suites import uncovered`);
  }
});

const formalJobs = (files) =>
  ciJobsFor(REPO_ROOT, files).filter(({ job }) => job.startsWith("Formal models"));

test("the plan lists ci.yml's formal job only when the diff touches a formal model", () => {
  assert.equal(formalJobs(["docs/turbo.md"]).length, 0);
  assert.equal(formalJobs(["packages/db/src/repositories/boat-runs.ts"]).length, 1);
});
