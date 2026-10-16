import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The box's runner VMs keep state between jobs, so a workflow that publishes, or holds a token that
// writes to the repository or its packages, runs every job on a GitHub-hosted runner: a fresh VM.
const PUBLISHING = ["next.yml", "release.yml", "version.yml"];

test("workflows that publish or hold a write token never ask for a box runner", async () => {
  for (const file of PUBLISHING) {
    const text = await readFile(
      new URL(`../../.github/workflows/${file}`, import.meta.url),
      "utf8",
    );
    const lines = text.split("\n").filter((line) => !/^\s*#/.test(line));
    for (const line of lines) {
      assert.doesNotMatch(line, /self-hosted|\bbox\b/, `${file}: ${line.trim()}`);
    }
    assert.match(text, /runs-on: ubuntu-24\.04\n/, `${file} runs on GitHub-hosted runners`);
  }
});
