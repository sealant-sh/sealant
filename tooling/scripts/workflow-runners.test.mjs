import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("pull requests run the unit suite where Next does", async () => {
  const read = (file) =>
    readFile(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
  const [ci, next] = await Promise.all([read("ci.yml"), read("next.yml")]);
  // The jobs that run the full suite, wherever they are: each must use next.yml test's runner.
  const runnerOf = (block) => runnersIn(block).at(0)?.labels.join(", ");
  const suite = /\n\s+run: pnpm exec turbo test --force\n/;
  const nextTest = jobBlocks(next).get("test");
  assert.match(nextTest ?? "", suite, "next.yml's test job runs the full suite");
  const prJobs = [...jobBlocks(ci)].filter(([, block]) => suite.test(block));
  assert.ok(prJobs.length > 0, "ci.yml runs the full suite on pull requests");
  for (const [job, block] of prJobs) {
    assert.equal(runnerOf(block), runnerOf(nextTest), `ci.yml ${job} runs the suite elsewhere`);
  }
});
