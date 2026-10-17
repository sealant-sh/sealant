import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Evaluator, Lexer, Parser, data } from "@actions/expressions";
import { parse } from "yaml";

// The box's runner VMs keep state between jobs, so a workflow that publishes, or holds a token that
// writes to the repository or its packages, runs every job on a GitHub-hosted runner: a fresh VM.
// Labels are allowed, not denied: a selector such as [linux, x64] reaches the box without naming it.
const PUBLISHING = ["next.yml", "release.yml", "version.yml"];
const HOSTED = /^ubuntu-(latest|[0-9.]+(-arm)?)$/;
const MATRIX = /^\$\{\{ matrix\.[a-z.]+ \}\}$/;

/** Every runner a workflow names: runs-on values and matrix `runner:` entries, in flow or block form. */
export function runnersIn(text) {
  const lines = text.split("\n");
  const runners = [];
  lines.forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    for (const match of line.matchAll(
      /(?:runs-on|runner)"?\s*:\s*("[^"]*"|\$\{\{[^}]*\}\}|\[[^\]]*\]|[^,}#\s][^,}#]*)?/g,
    )) {
      const value = match[1]?.trim();
      if (value === undefined || value === "") {
        // A block sequence or anything else spread over lines: name the runner on one line.
        runners.push({ line: index + 1, labels: [`<multi-line value>`] });
      } else if (value.startsWith("[")) {
        const labels = value
          .slice(1, -1)
          .split(",")
          .map((label) => label.trim().replace(/^"|"$/g, ""));
        runners.push({ line: index + 1, labels });
      } else {
        runners.push({ line: index + 1, labels: [value.replace(/^"|"$/g, "")] });
      }
    }
  });
  return runners;
}

const hosted = ({ labels }) =>
  labels.length === 1 && MATRIX.test(labels[0])
    ? true
    : labels.every((label) => HOSTED.test(label));

test("workflows that publish or hold a write token run only on GitHub-hosted runners", async () => {
  for (const file of PUBLISHING) {
    const text = await readFile(
      new URL(`../../.github/workflows/${file}`, import.meta.url),
      "utf8",
    );
    const runners = runnersIn(text);
    assert.ok(runners.length > 0, `${file} names its runners`);
    for (const runner of runners) {
      assert.ok(hosted(runner), `${file}:${runner.line} asks for ${runner.labels.join(", ")}`);
    }
  }
});

test("the guard refuses every way of naming a box runner", () => {
  const refused = (text) => runnersIn(text).some((runner) => !hosted(runner));
  assert.ok(refused("    runs-on: [self-hosted, box, linux, x64]\n"), "the box labels");
  assert.ok(refused("    runs-on: [linux, x64]\n"), "a selector that names no box label");
  assert.ok(refused("    runs-on: box\n"), "a scalar label");
  assert.ok(
    refused("          - { arch: amd64, runner: [self-hosted, box, linux, x64] }\n"),
    "a matrix row",
  );
  assert.ok(
    refused("          - { arch: amd64, runner: [linux, x64] }\n"),
    "a matrix row selector",
  );
  assert.ok(refused("    runs-on:\n      - linux\n      - x64\n"), "a block sequence");
  assert.ok(
    refused(`          amd64='{"arch":"amd64","runner":["linux","x64"]}'\n`),
    "JSON a step builds",
  );
  assert.ok(
    !refused("    runs-on: ubuntu-24.04\n    runs-on: ${{ matrix.platform.runner }}\n"),
    "hosted",
  );
  assert.ok(
    !refused("          - { arch: arm64, runner: ubuntu-24.04-arm }\n"),
    "a hosted matrix row",
  );
});

/** The text of each top-level job in a workflow, by job id. */
const jobBlocks = (text) =>
  new Map(
    text
      .split(/\n(?=  [a-z0-9-]+:\n)/)
      .map((part) => [part.match(/^ {2}([a-z0-9-]+):\n/)?.[1], part])
      .filter(([job]) => job !== undefined),
  );

const workflowText = (file) =>
  readFile(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
const runnerOf = (block) => runnersIn(block).at(0)?.labels.join(", ");

test("pull requests run the unit suite where Next does", async () => {
  const [ci, next] = await Promise.all([workflowText("ci.yml"), workflowText("next.yml")]);
  // The jobs that run the full suite, wherever they are: each must use next.yml test's runner.
  const suite = /\n\s+run: pnpm exec turbo test --force\n/;
  const nextTest = jobBlocks(next).get("test");
  assert.match(nextTest ?? "", suite, "next.yml's test job runs the full suite");
  const prJobs = [...jobBlocks(ci)].filter(([, block]) => suite.test(block));
  assert.ok(prJobs.length > 0, "ci.yml runs the full suite on pull requests");
  for (const [job, block] of prJobs) {
    assert.equal(runnerOf(block), runnerOf(nextTest), `ci.yml ${job} runs the suite elsewhere`);
  }
});

// x86 CI runs on GitHub-hosted runners. The box's runners stay a fallback a person picks by
// dispatching ci.yml or kubernetes-e2e.yml with `runner: box`: no other event may resolve a job's runs-on to the box,
// and no event at all to a Blacksmith runner. runs-on is evaluated per event and input with
// GitHub's own expression library, as workflow-concurrency.test.mjs evaluates the concurrency group.
const BOX = ["self-hosted", "box", "linux", "x64"];

const toData = (v) => {
  if (typeof v === "string") return new data.StringData(v);
  if (typeof v === "boolean") return new data.BooleanData(v);
  if (typeof v === "number") return new data.NumberData(v);
  if (v === null || v === undefined) return new data.Null();
  if (Array.isArray(v)) return new data.Array(...v.map(toData));
  const dictionary = new data.Dictionary();
  for (const [key, entry] of Object.entries(v)) dictionary.add(key, toData(entry));
  return dictionary;
};

const evaluate = (expression, context) => {
  const tree = new Parser(new Lexer(expression).lex().tokens, Object.keys(context), []).parse();
  const result = new Evaluator(tree, toData(context)).evaluate();
  return JSON.parse(JSON.stringify(result, data.replacer));
};

/** The labels a runs-on value resolves to in a context. */
const resolve = (runsOn, context) => {
  const whole = typeof runsOn === "string" && runsOn.match(/^\$\{\{(.+)\}\}$/s);
  const value = whole ? evaluate(whole[1], context) : runsOn;
  const labels = typeof value === "string" ? [value] : Array.isArray(value) ? value : value.labels;
  return [labels].flat().map((label) => {
    const inner = typeof label === "string" && label.match(/^\$\{\{(.+)\}\}$/s);
    return inner ? evaluate(inner[1], context) : label;
  });
};

/** Every matrix row a job runs, or one empty row. */
const matrixRows = (strategy) => {
  const matrix = strategy?.matrix;
  if (matrix === undefined) return [{}];
  assert.equal(typeof matrix, "object", "a matrix built by an expression is not evaluated here");
  let rows = [{}];
  for (const [key, values] of Object.entries(matrix)) {
    if (key === "include" || key === "exclude") continue;
    assert.ok(Array.isArray(values), `matrix.${key} is a literal list`);
    rows = rows.flatMap((row) => values.map((entry) => ({ ...row, [key]: entry })));
  }
  const include = matrix.include ?? [];
  return Object.keys(matrix).some((key) => key !== "include" && key !== "exclude")
    ? [...rows, ...include]
    : include;
};

/**
 * Every (event, inputs) a workflow can run with: each dispatch choice and boolean value, and every
 * other trigger with none.
 */
const runsOf = (workflow) => {
  const on = workflow.on;
  const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
  return events.flatMap((event) => {
    if (event !== "workflow_dispatch") return [{ event, inputs: {} }];
    const inputs = Object.entries(on.workflow_dispatch?.inputs ?? {});
    let choices = [{}];
    for (const [name, input] of inputs) {
      const options =
        input.type === "choice"
          ? input.options
          : input.type === "boolean"
            ? [false, true]
            : [input.default ?? ""];
      choices = choices.flatMap((chosen) =>
        options.map((option) => ({ ...chosen, [name]: option })),
      );
    }
    return choices.map((inputs) => ({ event, inputs }));
  });
};

const workflowFiles = readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter(
  (file) => /\.ya?ml$/.test(file),
);

/** Every runner every job of every workflow resolves to, per event and dispatch input. */
const resolutions = () =>
  workflowFiles.flatMap((file) => {
    const workflow = parse(
      readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8"),
    );
    return runsOf(workflow).flatMap(({ event, inputs }) =>
      Object.entries(workflow.jobs).flatMap(([job, { "runs-on": runsOn, strategy }]) =>
        runsOn === undefined
          ? []
          : matrixRows(strategy).map((matrix) => ({
              file,
              event,
              inputs,
              job,
              labels: resolve(runsOn, { inputs, matrix, github: { event_name: event } }),
            })),
      ),
    );
  });

const isBox = (labels) =>
  labels.length === BOX.length && labels.every((label, i) => label === BOX[i]);

test("only a dispatch with runner: box selects the box, and nothing selects Blacksmith", () => {
  const all = resolutions();
  assert.ok(
    all.some(({ event }) => event === "push"),
    "pushes are evaluated",
  );
  assert.ok(
    all.some(({ event }) => event === "pull_request"),
    "pull requests are evaluated",
  );
  for (const { file, event, inputs, job, labels } of all) {
    const where = `${file} ${job} on ${event} ${JSON.stringify(inputs)} -> ${JSON.stringify(labels)}`;
    assert.ok(!labels.some((label) => /blacksmith/i.test(String(label))), where);
    if (event === "workflow_dispatch" && inputs.runner === "box" && isBox(labels)) continue;
    assert.ok(hosted({ labels }), where);
  }
});

test("x86 CI jobs run on ubuntu-24.04 and go back to the box only when dispatched to it", () => {
  const all = resolutions();
  const on = (file, event, job, inputs = {}) =>
    all
      .filter(
        (run) =>
          run.file === file &&
          run.event === event &&
          run.job === job &&
          JSON.stringify(run.inputs) === JSON.stringify(inputs),
      )
      .map((run) => run.labels);
  for (const event of ["pull_request", "workflow_dispatch"]) {
    const inputs = event === "workflow_dispatch" ? { runner: "ubuntu-24.04" } : {};
    assert.deepEqual(on("ci.yml", event, "lint", inputs), [["ubuntu-24.04"]]);
    assert.deepEqual(on("ci.yml", event, "typecheck", inputs), [["ubuntu-24.04"]]);
    assert.deepEqual(on("ci.yml", event, "arch-native", inputs), [
      ["ubuntu-24.04"],
      ["ubuntu-24.04-arm"],
    ]);
  }
  for (const event of ["pull_request", "push"]) {
    assert.deepEqual(on("kubernetes-e2e.yml", event, "docker"), [["ubuntu-24.04"]]);
    assert.deepEqual(on("kubernetes-e2e.yml", event, "kubernetes"), [["ubuntu-24.04"]]);
  }
  const box = { runner: "box" };
  assert.deepEqual(on("ci.yml", "workflow_dispatch", "lint", box), [BOX]);
  assert.deepEqual(on("ci.yml", "workflow_dispatch", "typecheck", box), [BOX]);
  assert.deepEqual(on("ci.yml", "workflow_dispatch", "arch-native", box), [
    BOX,
    ["ubuntu-24.04-arm"],
  ]);
  const e2eBox = { sealantd_ref: "", runner: "box" };
  assert.deepEqual(on("kubernetes-e2e.yml", "workflow_dispatch", "docker", e2eBox), [BOX]);
  assert.deepEqual(on("kubernetes-e2e.yml", "workflow_dispatch", "kubernetes", e2eBox), [BOX]);
});
