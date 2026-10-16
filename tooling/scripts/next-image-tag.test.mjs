// next.yml's "Tag the multi-arch image" step, run as written, against a stand-in docker over a
// registry held in a JSON file. Absent is buildx's sole not-found line; every other failed read
// fails the step before anything is written, and the read after a create decides its outcome.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/** The `run:` script of the named step in a workflow, its block indentation removed. */
const stepScript = (text, name) => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `next.yml has the step "${name}"`);
  const run = lines.findIndex((line, index) => index > start && /^\s+run: \|$/.test(line));
  assert.ok(run > start, `"${name}" has a run block`);
  const indent = /^ */.exec(lines[run])[0].length + 2;
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && /^ */.exec(line)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
};

const script = stepScript(
  readFileSync(new URL("../../.github/workflows/next.yml", import.meta.url), "utf8"),
  "Tag the multi-arch image",
);

/**
 * The index bytes buildx pushes for `sources`: the manifest list, indented two spaces, as
 * `imagetools create` marshals it. The stand-in prints them on a dry run and pushes them on a create.
 */
const indexBytes = (sources) =>
  JSON.stringify(
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: sources.map((source, index) => ({
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: source.split("@")[1],
        size: 1000 + index,
        platform: { architecture: index === 0 ? "amd64" : "arm64", os: "linux" },
      })),
    },
    null,
    2,
  );

const REPOSITORY = "ghcr.io/sealant-ci/sealant-api-next";
const VERSION = "1.2.3-next.4";
const REF = `${REPOSITORY}:${VERSION}`;
const PLATFORMS = ["a1".repeat(32), "b2".repeat(32)];
const SOURCES = PLATFORMS.map((digest) => `${REPOSITORY}@sha256:${digest}`);
const OURS = `sha256:${createHash("sha256").update(indexBytes(SOURCES)).digest("hex")}`;
const FOREIGN = `sha256:${"e".repeat(64)}`;

/**
 * Runs the step. `tag` is the version tag's digest (absent when undefined). `answers` replace the
 * first reads, in order, with exact stdout, stderr and exit. `onCreate` says what a create does:
 * `land` (the tag gets the pushed index), `other` (another digest lands), and its `exit` code.
 */
const tagStep = (t, { tag, answers = [], onCreate = { land: true } } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), "next-image-tag-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ["bin", "digests", "tmp"]) mkdirSync(path.join(directory, name));
  for (const digest of PLATFORMS) writeFileSync(path.join(directory, "digests", digest), "");
  const calls = path.join(directory, "calls.jsonl");
  const state = path.join(directory, "registry.json");
  const summary = path.join(directory, "summary.md");
  writeFileSync(calls, "");
  writeFileSync(state, JSON.stringify({ tag: tag ?? null, answers, onCreate }));
  writeFileSync(
    path.join(directory, "bin", "docker"),
    `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const indexBytes = ${indexBytes.toString()};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const registry = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => writeFileSync(${JSON.stringify(state)}, JSON.stringify(registry));
const command = args.slice(0, 3).join(" ");
if (command === "buildx imagetools inspect" && args[3] === ${JSON.stringify(REF)} &&
    args.slice(4).join(" ") === "--format {{json .Manifest}}") {
  const answer = registry.answers.shift();
  if (answer !== undefined) {
    save();
    process.stdout.write(answer.stdout ?? "");
    process.stderr.write(answer.stderr ?? "");
    process.exit(answer.exit ?? 1);
  }
  if (registry.tag === null) {
    console.error("ERROR: " + args[3] + ": not found");
    process.exit(1);
  }
  console.log(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", digest: registry.tag }));
  process.exit(0);
}
if (command === "buildx imagetools create" && args[3] === "--dry-run") {
  process.stdout.write(indexBytes(args.slice(4)) + "\\n");
  process.exit(0);
}
if (command === "buildx imagetools create" && args[3] === "--metadata-file" && args[5] === "--tag" &&
    args[6] === ${JSON.stringify(REF)}) {
  const digest = "sha256:" + createHash("sha256").update(indexBytes(args.slice(7))).digest("hex");
  const effect = registry.onCreate;
  if (effect.land) registry.tag = digest;
  if (effect.other) registry.tag = "sha256:" + "f".repeat(64);
  save();
  if ((effect.exit ?? 0) !== 0) {
    console.error("ERROR: failed commit on ref: unexpected status 500");
    process.exit(effect.exit);
  }
  writeFileSync(args[4], JSON.stringify({ "containerimage.descriptor": { digest }, "image.name": args[6] }));
  process.exit(0);
}
console.error("stand-in docker: unexpected call " + JSON.stringify(args));
process.exit(79);
`,
  );
  chmodSync(path.join(directory, "bin", "docker"), 0o755);
  // GitHub's `bash -e {0}` for a run block, without local startup files.
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
    cwd: path.join(directory, "digests"),
    encoding: "utf8",
    env: {
      PATH: `${path.join(directory, "bin")}:${process.env.PATH}`,
      TMPDIR: path.join(directory, "tmp"),
      REPOSITORY,
      VERSION,
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  const recorded = readFileSync(calls, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    tag: JSON.parse(readFileSync(state, "utf8")).tag,
    reads: recorded.filter((args) => args[2] === "inspect").length,
    creates: recorded.filter((args) => args[2] === "create" && args.includes("--tag")),
  };
};

test("an exact not-found creates the tag at this run's index, then confirms it", (t) => {
  const result = tagStep(t);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.creates.length, 1);
  assert.deepEqual(result.creates[0].toSpliced(4, 1), [
    "buildx",
    "imagetools",
    "create",
    "--metadata-file",
    "--tag",
    REF,
    ...SOURCES,
  ]);
  assert.equal(result.tag, OURS);
  assert.equal(result.reads, 2, "one read before the create and one after");
  assert.match(result.output, new RegExp(`${REF} is ${OURS}\\.`));
  // The sole not-found line, however many trailing newlines, is still absent.
  const trailing = tagStep(t, { answers: [{ stderr: `ERROR: ${REF}: not found\n\n\n` }] });
  assert.equal(trailing.status, 0, trailing.output);
  assert.equal(trailing.creates.length, 1);
});

test("a tag already at this run's index is done, with no create", (t) => {
  const result = tagStep(t, { tag: OURS });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.creates, []);
  assert.match(result.output, /is already this run's sha256:[0-9a-f]{64}\./);
});

test("a tag at another digest is refused, with no create", (t) => {
  const result = tagStep(t, { tag: FOREIGN });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    new RegExp(`::error::${REF} exists at ${FOREIGN}, not ${OURS}.*Version ${VERSION} is spent`),
  );
  assert.deepEqual(result.creates, []);
  assert.equal(result.tag, FOREIGN);
});

test("an authorization error is a failed read, with no create", (t) => {
  const result = tagStep(t, {
    tag: FOREIGN,
    answers: [
      {
        stderr:
          "ERROR: failed to authorize: failed to fetch oauth token: unexpected status from GET request to https://ghcr.io/token: 401 Unauthorized\n",
      },
    ],
  });
  assert.equal(result.status, 1);
  assert.match(result.output, /401 Unauthorized/);
  assert.match(result.output, new RegExp(`::error::Could not read ${REF}; nothing was written\\.`));
  assert.deepEqual(result.creates, []);
  assert.equal(result.tag, FOREIGN);
});

test("absent is read only from buildx's sole not-found line", (t) => {
  for (const [label, answer] of [
    [
      "not found beside another error",
      { stderr: `ERROR: ${REF}: not found\nERROR: unauthorized: authentication required\n` },
    ],
    ["a line before it", { stderr: `WARNING: retrying\nERROR: ${REF}: not found\n` }],
    ["a changed format: lower case", { stderr: `error: ${REF}: not found\n` }],
    ["a changed format: manifest unknown", { stderr: `ERROR: ${REF}: manifest unknown\n` }],
    ["a changed format: reference first", { stderr: `ERROR: not found: ${REF}\n` }],
    ["another reference", { stderr: `ERROR: ${REF}-other: not found\n` }],
    ["output beside it", { stdout: "{}\n", stderr: `ERROR: ${REF}: not found\n` }],
    ["a success without a digest", { stdout: "{}\n", exit: 0 }],
  ]) {
    const result = tagStep(t, { answers: [answer] });
    assert.equal(result.status, 1, label);
    assert.match(result.output, /::error::/, label);
    assert.deepEqual(result.creates, [], label);
    assert.equal(result.tag, null, label);
  }
});

test("a create that errors but lands this run's index passes, with a warning", (t) => {
  const result = tagStep(t, { onCreate: { land: true, exit: 1 } });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.creates.length, 1);
  assert.equal(result.tag, OURS);
  assert.match(
    result.output,
    new RegExp(`::warning::The create reported exit 1, but ${REF} resolves to ${OURS}`),
  );
});

test("a create that errors and leaves the tag absent fails", (t) => {
  const result = tagStep(t, { onCreate: { exit: 1 } });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    new RegExp(`::error::${REF} does not exist after the create \\(exit 1\\)`),
  );
});

test("after the create, an unreadable or foreign tag fails", (t) => {
  const unreadable = tagStep(t, {
    answers: [{ stderr: `ERROR: ${REF}: not found\n` }, { stderr: "ERROR: i/o timeout\n" }],
  });
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.output, new RegExp(`::error::${REF} is unreadable after the create`));
  const foreign = tagStep(t, { onCreate: { other: true } });
  assert.equal(foreign.status, 1);
  assert.match(
    foreign.output,
    new RegExp(`::error::${REF} resolves to sha256:f{64} after the create`),
  );
});
