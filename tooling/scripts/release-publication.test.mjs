// release.yml's publishing steps, run as written against stand-in docker and gh commands, a stub
// npm registry and a stub GitHub API; and the job graph they sit in. Ported from sealant-sh/mend
// scripts/release-publication.test.mjs and scripts/release-manifest.test.mjs, for Core's four
// images and two packages.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { githubApi, npmDistTags, registryStandIn, writesIn } from "./fixtures/release-markers.mjs";

const workflows = new URL("../../.github/workflows/", import.meta.url);
const releaseText = readFileSync(new URL("release.yml", workflows), "utf8");
const releaseDocument = parse(releaseText);
const releaseJobs = releaseDocument.jobs;

/** The `run:` of the named step in the named job, as GitHub hands it to bash. */
const stepRun = (job, name) => {
  const step = releaseJobs[job].steps.find((entry) => entry.name === name);
  assert.equal(typeof step?.run, "string", `release.yml ${job} has the step "${name}"`);
  return step.run;
};

const jqDirectory = path.dirname(
  spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim(),
);
const scratch = (t, prefix) => {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const readCalls = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const IMAGES = ["sealant-api", "sealant-worker", "sealant-ssh-gateway", "sealant-web"];
const OWNER = "sealant-ci";
const COMMIT = "f".repeat(40);
const indexOf = (image) => `sha256:${createHash("sha256").update(image).digest("hex")}`;
const repo = (image) => `ghcr.io/${OWNER}/${image}`;
const manifestJson = (version, extra = {}) =>
  JSON.stringify({
    version,
    commit: COMMIT,
    images: Object.fromEntries(IMAGES.map((image) => [image, { index: indexOf(image) }])),
    ...extra,
  });

// --- github-release ---

/** A stand-in gh over the repository's releases, held in a JSON file. */
const ghReleases = `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(process.env.FIXTURE_STATE, "utf8"));
const save = () => writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
if (args[0] === "api" && args[1] === "--paginate" && args[2] === "repos/sealant-sh/sealant/releases?per_page=100") {
  if (state.failList) { console.error("HTTP 502"); process.exit(1); }
  // Two to a page, as --paginate prints them: one array after another.
  for (let at = 0; at < state.releases.length || at === 0; at += 2)
    process.stdout.write(JSON.stringify(state.releases.slice(at, at + 2)));
  process.exit(0);
}
const prefix = "repos/sealant-sh/sealant/releases/";
if (args[0] === "api" && args[1] === "--method" && args[2] === "DELETE" && args[3]?.startsWith(prefix) && args.length === 4) {
  state.releases = state.releases.filter((release) => release.id !== Number(args[3].slice(prefix.length)));
  save(); process.exit(0);
}
if (args[0] === "release" && args[1] === "create") {
  if (state.releases.some((release) => release.tag_name === args[2])) process.exit(79);
  const assets = ["compose.selfhost.yaml", "install.sh"].filter((name) => args.includes(name));
  state.releases.push({ id: 999, tag_name: args[2], draft: false, assets: assets.map((name) => ({ name })) });
  save(); process.exit(0);
}
console.error("stand-in gh: unexpected call " + JSON.stringify(args));
process.exit(79);
`;

const releaseStep = (t, releases, { failList = false } = {}) => {
  const directory = scratch(t, "core-github-release-");
  for (const name of ["bin", "work"]) mkdirSync(path.join(directory, name));
  writeFileSync(path.join(directory, "bin", "gh"), ghReleases);
  chmodSync(path.join(directory, "bin", "gh"), 0o755);
  const calls = path.join(directory, "calls.jsonl");
  const state = path.join(directory, "state.json");
  writeFileSync(calls, "");
  writeFileSync(state, JSON.stringify({ releases, failList }));
  for (const name of ["compose.selfhost.yaml", "install.sh"])
    writeFileSync(path.join(directory, "work", name), `${name} bytes\n`);
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-e",
      "-c",
      stepRun("github-release", "Create the release with compose + installer assets"),
    ],
    {
      cwd: path.join(directory, "work"),
      encoding: "utf8",
      env: {
        PATH: `${path.join(directory, "bin")}:${jqDirectory}:/usr/bin:/bin`,
        FIXTURE_CALLS: calls,
        FIXTURE_STATE: state,
        GITHUB_REF_NAME: "v1.2.3",
        GITHUB_REPOSITORY: "sealant-sh/sealant",
      },
    },
  );
  return {
    ...result,
    calls: readCalls(calls),
    releases: JSON.parse(readFileSync(state, "utf8")).releases,
  };
};
const listed = (id, tag, draft, names) => ({
  id,
  tag_name: tag,
  draft,
  assets: names.map((name) => ({ name })),
});
const listCall = ["api", "--paginate", "repos/sealant-sh/sealant/releases?per_page=100"];
const createCall = [
  "release",
  "create",
  "v1.2.3",
  "compose.selfhost.yaml",
  "install.sh",
  "--generate-notes",
  "--latest=false",
  "--verify-tag",
];
const BOTH = ["compose.selfhost.yaml", "install.sh"];

test("the GitHub release is created with both assets and without becoming latest", (t) => {
  const others = [listed(1, "v1.2.2", false, BOTH), listed(2, "v1.2.1", true, [])];
  const result = releaseStep(t, others);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [listCall, createCall]);
  assert.deepEqual(result.releases.slice(0, 2), others);
});

test("a published release with both assets is a retry that writes nothing", (t) => {
  const releases = [listed(5, "v1.2.3", false, BOTH), listed(6, "v1.2.2", false, BOTH)];
  const result = releaseStep(t, releases);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /published with every asset: a retry changes nothing/);
  assert.deepEqual(result.calls, [listCall]);
});

test("a published release missing an asset fails, naming it, and is never patched", (t) => {
  const result = releaseStep(t, [listed(5, "v1.2.3", false, ["compose.selfhost.yaml"])]);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /::error::published release is missing an asset; cut a new version \(missing: install\.sh\)/,
  );
  assert.deepEqual(result.calls, [listCall]);
});

test("an orphan draft for the tag is deleted, never reused, before the release is created", (t) => {
  const result = releaseStep(t, [
    listed(7, "v1.2.3", true, ["compose.selfhost.yaml"]),
    listed(8, "v1.2.2", true, []),
    listed(9, "v1.2.3", true, []),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    listCall,
    ["api", "--method", "DELETE", "repos/sealant-sh/sealant/releases/7"],
    ["api", "--method", "DELETE", "repos/sealant-sh/sealant/releases/9"],
    createCall,
  ]);
  assert.deepEqual(
    result.releases.map(({ id, draft }) => [id, draft]),
    [
      [8, true],
      [999, false],
    ],
  );
});

test("a failed release listing writes nothing", (t) => {
  const result = releaseStep(t, [], { failList: true });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, [listCall]);
});

test("the assets are downloaded anonymously and compared byte for byte", () => {
  const verify = stepRun("github-release", "Verify anonymous asset downloads");
  assert.match(verify, /releases\/download\/\$GITHUB_REF_NAME\/\$asset/);
  assert.match(verify, /cmp "\$asset" "\$downloads\/\$asset"/);
  assert.doesNotMatch(verify, /GH_TOKEN|authorization/i);
  assert.equal(releaseJobs["github-release"].steps.at(-1).name, "Verify anonymous asset downloads");
});

// --- merge ---

test("merge stages each index under this run's own tag, never :<version>", (t) => {
  const directory = scratch(t, "core-merge-");
  const digests = path.join(directory, "digests");
  for (const name of ["bin", "digests", "tmp"]) mkdirSync(path.join(directory, name));
  const platforms = ["a1".repeat(32), "b2".repeat(32)];
  for (const digest of platforms) writeFileSync(path.join(digests, digest), "");
  const calls = path.join(directory, "calls.jsonl");
  writeFileSync(calls, "");
  writeFileSync(
    path.join(directory, "bin", "docker"),
    `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[2] === "create" && args[3] === "--metadata-file") {
  if (process.env.FAIL_CREATE) process.exit(73);
  writeFileSync(args[4], "{}");
}
process.exit(args[2] === "inspect" && process.env.FAIL_INSPECT ? 74 : 0);
`,
  );
  chmodSync(path.join(directory, "bin", "docker"), 0o755);
  const run = (environment = {}) => {
    writeFileSync(calls, "");
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-e",
        "-c",
        stepRun("merge", "Stage the multi-arch index under this run's tag"),
      ],
      {
        cwd: digests,
        encoding: "utf8",
        env: {
          PATH: `${path.join(directory, "bin")}:/usr/bin:/bin`,
          RUNNER_TEMP: path.join(directory, "tmp"),
          REPOSITORY: repo("sealant-api"),
          GITHUB_RUN_ID: "38923041738",
          GITHUB_RUN_ATTEMPT: "2",
          ...environment,
        },
      },
    );
    return { ...result, calls: readCalls(calls) };
  };
  const staged = run();
  assert.equal(staged.status, 0, staged.stderr);
  assert.deepEqual(staged.calls, [
    [
      "buildx",
      "imagetools",
      "create",
      "--metadata-file",
      path.join(directory, "tmp", "index", "create.json"),
      "--tag",
      `${repo("sealant-api")}:staging-38923041738-2`,
      ...platforms.map((digest) => `${repo("sealant-api")}@sha256:${digest}`),
    ],
    ["buildx", "imagetools", "inspect", `${repo("sealant-api")}:staging-38923041738-2`],
  ]);
  for (const failure of [{ FAIL_CREATE: "1" }, { FAIL_INSPECT: "1" }])
    assert.notEqual(run(failure).status, 0, JSON.stringify(failure));
  // A stray file in the digests artifact is refused before anything is pushed.
  writeFileSync(path.join(digests, "latest"), "");
  const stray = run();
  assert.equal(stray.status, 1);
  assert.match(stray.stdout, /"latest" in the digests artifact is not an image digest/);
  assert.deepEqual(stray.calls, []);
});

// --- finalize-images ---

/**
 * finalize-images' step as written, against a stand-in docker over a registry held in a JSON file:
 * `tags` maps a reference to its digest, `unreadable` lists references whose read fails for a
 * reason other than not found, and `onCreate` says what a create does: `land` (the tag gets the
 * source's digest), `other` (another digest lands), `vanish` (the tag becomes unreadable), with an
 * optional exit code. `answers` replaces a reference's read with exact stdout, stderr and exit
 * (only its first read, with `once`).
 */
const finalize = (
  t,
  { tags = {}, unreadable = [], onCreate = {}, manifest = {}, answers = {} } = {},
) => {
  const directory = scratch(t, "core-finalize-");
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const calls = path.join(directory, "calls.jsonl");
  const state = path.join(directory, "registry.json");
  writeFileSync(calls, "");
  writeFileSync(state, JSON.stringify({ tags, unreadable, onCreate, answers }));
  writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const registry = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => writeFileSync(${JSON.stringify(state)}, JSON.stringify(registry));
if (args.slice(0, 3).join(" ") === "buildx imagetools inspect" && args[4] === "--format") {
  const ref = args[3];
  const answer = registry.answers[ref];
  if (answer !== undefined) {
    if (answer.once) {
      delete registry.answers[ref];
      save();
    }
    process.stdout.write(answer.stdout ?? "");
    process.stderr.write(answer.stderr ?? "");
    process.exit(answer.exit ?? 1);
  }
  if (registry.unreadable.includes(ref)) {
    console.error("ERROR: failed to do request: Head \\"https://ghcr.io/v2/x\\": unauthorized");
    process.exit(1);
  }
  if (!(ref in registry.tags)) { console.error("ERROR: " + ref + ": not found"); process.exit(1); }
  console.log(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", digest: registry.tags[ref] }));
  process.exit(0);
}
if (args.slice(0, 4).join(" ") === "buildx imagetools create --tag" && args.length === 6) {
  const [target, source] = args.slice(4);
  const effect = registry.onCreate[target] ?? { land: true };
  if (effect.land) registry.tags[target] = source.split("@")[1];
  if (effect.other) registry.tags[target] = "sha256:" + "e".repeat(64);
  if (effect.vanish) registry.unreadable.push(target);
  save();
  process.exit(effect.exit ?? 0);
}
process.exit(79);
`,
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  const file = path.join(directory, "release-manifest.json");
  writeFileSync(file, manifestJson("1.2.3", manifest));
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-e",
      "-c",
      stepRun("finalize-images", "Publish each accepted index as its version"),
    ],
    {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${jqDirectory}:/usr/bin:/bin`,
        RUNNER_TEMP: directory,
        GITHUB_SHA: COMMIT,
        GITHUB_REPOSITORY_OWNER: OWNER,
        GITHUB_STEP_SUMMARY: path.join(directory, "summary.md"),
        MANIFEST: file,
        VERSION: "1.2.3",
      },
    },
  );
  return {
    ...result,
    output: result.stdout + result.stderr,
    registry: JSON.parse(readFileSync(state, "utf8")),
    calls: readCalls(calls),
  };
};
const finalRef = (image) => `${repo(image)}:1.2.3`;
const ours = Object.fromEntries(IMAGES.map((image) => [finalRef(image), indexOf(image)]));
const creates = (result) => result.calls.filter((args) => args[2] === "create");

test("finalize creates each absent :<version> from the accepted index, after reading every one", (t) => {
  const result = finalize(t);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(
    creates(result),
    IMAGES.map((image) => [
      "buildx",
      "imagetools",
      "create",
      "--tag",
      finalRef(image),
      `${repo(image)}@${indexOf(image)}`,
    ]),
  );
  for (const image of IMAGES) assert.equal(result.registry.tags[finalRef(image)], indexOf(image));
  const firstCreate = result.calls.findIndex((args) => args[2] === "create");
  assert.equal(firstCreate, IMAGES.length, "every tag is read before any is written");
});

test("finalize is done when :<version> already names this run's index: a rerun of failed jobs", (t) => {
  const result = finalize(t, { tags: ours });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(creates(result), []);
  assert.match(result.output, /is already this run's sha256:/);
});

test("finalize completes a partial finalize: matching tags stay, absent ones are created", (t) => {
  const result = finalize(t, {
    tags: {
      [finalRef("sealant-api")]: indexOf("sealant-api"),
      [finalRef("sealant-worker")]: indexOf("sealant-worker"),
    },
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(
    creates(result).map((args) => args[4]),
    [finalRef("sealant-ssh-gateway"), finalRef("sealant-web")],
  );
});

test("finalize refuses a version that exists at another digest, before writing any tag", (t) => {
  const result = finalize(t, { tags: { [finalRef("sealant-web")]: `sha256:${"e".repeat(64)}` } });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /::error::.*sealant-web:1\.2\.3 exists at sha256:e{64}.*is spent: cut a new one/,
  );
  assert.deepEqual(creates(result), []);
});

test("finalize fails without writing on a read that is not a not-found", (t) => {
  const result = finalize(t, { unreadable: [finalRef("sealant-worker")] });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /::error::Could not read .*sealant-worker:1\.2\.3; nothing was written/,
  );
  assert.deepEqual(creates(result), []);
});

test("finalize reads absent only from buildx's sole not-found line, and fails on anything else", (t) => {
  const ref = finalRef("sealant-api");
  for (const [label, answer] of [
    [
      "mixed lines",
      { stderr: `ERROR: ${ref}: not found\nERROR: unauthorized: authentication required\n` },
    ],
    ["an error before it", { stderr: `WARNING: retrying\nERROR: ${ref}: not found\n` }],
    ["a changed format", { stderr: `error: ${ref}: not found\n` }],
    ["another reference", { stderr: `ERROR: ${ref}-other: not found\n` }],
    ["output beside it", { stdout: "{}\n", stderr: `ERROR: ${ref}: not found\n` }],
    ["a digest that is not one", { stdout: '{"digest":"latest"}\n', exit: 0 }],
  ]) {
    const result = finalize(t, { answers: { [ref]: answer } });
    assert.equal(result.status, 1, label);
    assert.match(
      result.output,
      /sealant-api:1\.2\.3 (answered without a digest|; nothing was written)|Could not read .*sealant-api:1\.2\.3; nothing was written/,
      label,
    );
    assert.deepEqual(creates(result), [], label);
  }
  // The exact sole line, however many trailing newlines, is absent: the tag is created.
  const result = finalize(t, {
    answers: { [ref]: { stderr: `ERROR: ${ref}: not found\n\n`, once: true } },
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(creates(result).length, IMAGES.length);
  assert.deepEqual(creates(result)[0].slice(4), [
    ref,
    `${repo("sealant-api")}@${indexOf("sealant-api")}`,
  ]);
});

test("finalize: a create that reported an error but left this run's digest is a success", (t) => {
  const result = finalize(t, { onCreate: { [finalRef("sealant-api")]: { land: true, exit: 1 } } });
  assert.equal(result.status, 0, result.output);
  assert.match(
    result.output,
    /::warning::The create reported exit 1, but .*sealant-api:1\.2\.3 resolves to/,
  );
  assert.equal(creates(result).length, IMAGES.length);
});

test("finalize refuses when the tag shows another digest after its create", (t) => {
  const result = finalize(t, { onCreate: { [finalRef("sealant-worker")]: { other: true } } });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /sealant-worker:1\.2\.3 resolves to sha256:e{64} after the create.*is spent/,
  );
  // Nothing after the refusal is written.
  assert.deepEqual(
    creates(result).map((args) => args[4]),
    [finalRef("sealant-api"), finalRef("sealant-worker")],
  );
});

test("finalize fails when the tag is unreadable, or still absent, after its create", (t) => {
  const vanished = finalize(t, { onCreate: { [finalRef("sealant-api")]: { vanish: true } } });
  assert.equal(vanished.status, 1);
  assert.match(vanished.output, /sealant-api:1\.2\.3 is unreadable after the create/);
  const missing = finalize(t, { onCreate: { [finalRef("sealant-api")]: { exit: 1 } } });
  assert.equal(missing.status, 1);
  assert.match(missing.output, /sealant-api:1\.2\.3 does not exist after the create \(exit 1\)/);
});

test("finalize refuses another release's manifest or a missing index, writing nothing", (t) => {
  for (const manifest of [{ version: "1.2.2" }, { commit: "a".repeat(40) }, { images: {} }]) {
    const result = finalize(t, { manifest });
    assert.equal(result.status, 1, JSON.stringify(manifest));
    assert.deepEqual(creates(result), []);
  }
});

// --- promote ---

/**
 * promote's step as written, against a stand-in docker and gh over a fixture registry, a stub npm
 * dist-tags endpoint (`npm.packages` maps each package to its dist-tags), a stub GitHub API and the
 * real jq. `labels` are each ghcr :latest's version labels.
 */
const promote = async (
  t,
  {
    version = "1.2.3",
    tags = {},
    manifest = {},
    npm = {},
    github = {},
    labels = {},
    unreadable = [],
    environment = {},
  } = {},
) => {
  const directory = scratch(t, "core-promote-");
  const registry = registryStandIn(directory, { tags, versions: labels, unreadable });
  const npmStub = await npmDistTags(t, npm);
  const githubStub = await githubApi(t, github);
  const file = path.join(directory, "release-manifest.json");
  writeFileSync(file, manifestJson(version, manifest));
  const child = spawn(
    "bash",
    ["--noprofile", "--norc", "-e", "-c", stepRun("promote", "Move latest to this release")],
    {
      env: {
        PATH: `${registry.bin}:${process.env.PATH}`,
        HOME: directory,
        GITHUB_REF_NAME: `v${version}`,
        GITHUB_SHA: COMMIT,
        GITHUB_REPOSITORY: "sealant-sh/sealant",
        GITHUB_REPOSITORY_OWNER: OWNER,
        GITHUB_API_URL: githubStub.url,
        NPM_CONFIG_REGISTRY: npmStub.url,
        MANIFEST: file,
        VERSION: version,
        // The step's retries without their production waits; a test below holds the default.
        RELEASE_TEST_RETRY_MS: "1",
        ...environment,
      },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((done) => child.on("close", done));
  return {
    status,
    output,
    calls: registry.calls(),
    writes: writesIn(registry.calls()),
    registry: registry.registry(),
  };
};

const atVersion = (version) =>
  Object.fromEntries(IMAGES.map((image) => [`${repo(image)}:${version}`, indexOf(image)]));
const latestAt = (
  version,
  digest = (image) => `sha256:${createHash("sha256").update(`old ${image}`).digest("hex")}`,
) => ({
  tags: Object.fromEntries(IMAGES.map((image) => [`${repo(image)}:latest`, digest(image)])),
  labels: Object.fromEntries(IMAGES.map((image) => [`${repo(image)}:latest`, version])),
});
const bothPackages = (tags) => ({
  packages: { "@sealant/api-contracts": tags, "@sealant/sdk": tags },
});
const promotion = (image) => [
  "docker",
  "buildx",
  "imagetools",
  "create",
  "--tag",
  `${repo(image)}:latest`,
  `${repo(image)}@${indexOf(image)}`,
];
const releaseEdit = ["gh", "release", "edit", "v1.2.3", "--repo", "sealant-sh/sealant", "--latest"];
const settled = (old) => ({
  tags: { ...atVersion("1.2.3"), ...old.tags },
  labels: old.labels,
  npm: bothPackages({ latest: "1.2.2", next: "1.3.0-next.4" }),
  github: { latest: "v1.2.2" },
});

test("above the floor, every :latest moves to the manifest's index, every read first, GitHub latest last", async (t) => {
  const result = await promote(t, settled(latestAt("1.2.2")));
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.writes, [...IMAGES.map(promotion), releaseEdit]);
  const firstWrite = result.calls.findIndex((call) => writesIn([call]).length > 0);
  assert.ok(
    result.calls.slice(firstWrite).every((call) => writesIn([call]).length > 0),
    "no read after the first write",
  );
  assert.match(result.output, /Stable floor: 1\.2\.2 /);
  // No :X.Y is read or written.
  assert.ok(result.calls.every((call) => !call.some((arg) => String(arg).endsWith(":1.2"))));
  // No marker at all is no floor.
  const fresh = await promote(t, { tags: atVersion("1.2.3") });
  assert.equal(fresh.status, 0, fresh.output);
  assert.match(fresh.output, /Stable floor: none; 1\.2\.3 may publish/);
  assert.deepEqual(fresh.writes, [...IMAGES.map(promotion), releaseEdit]);
});

test("a higher floor from any one marker refuses the promotion and moves nothing", async (t) => {
  const old = latestAt("1.2.2");
  const base = settled(old);
  for (const [marker, change, named] of [
    [
      "the SDK's npm latest",
      {
        npm: {
          packages: {
            "@sealant/api-contracts": { latest: "1.2.2" },
            "@sealant/sdk": { latest: "1.3.0" },
          },
        },
      },
      /npm:@sealant\/sdk@latest/,
    ],
    [
      "the contracts' npm latest",
      {
        npm: {
          packages: {
            "@sealant/api-contracts": { latest: "1.3.0" },
            "@sealant/sdk": { latest: "1.2.2" },
          },
        },
      },
      /npm:@sealant\/api-contracts@latest/,
    ],
    ["GitHub's latest release", { github: { latest: "v1.10.0" } }, /github:sealant-sh\/sealant/],
    [
      "one image's :latest",
      { labels: { ...old.labels, [`${repo("sealant-web")}:latest`]: "2.0.0" } },
      /ghcr\.io\/sealant-ci\/sealant-web:latest/,
    ],
  ]) {
    const result = await promote(t, { ...base, ...change });
    assert.equal(result.status, 1, marker);
    assert.match(result.output, /is below the stable floor/, marker);
    assert.match(result.output, named, marker);
    assert.match(result.output, /backport such as 0\.38\.2 after 0\.39\.0 is refused on purpose/);
    assert.deepEqual(result.writes, [], marker);
  }
});

test("mixed markers: the highest one is the floor, compared as numbers", async (t) => {
  const old = latestAt("1.2.2");
  const result = await promote(t, {
    ...settled(old),
    labels: { ...old.labels, [`${repo("sealant-worker")}:latest`]: "1.10.0" },
    npm: bothPackages({ latest: "1.9.0" }),
    github: { latest: "v1.2.10" },
  });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /below the stable floor 1\.10\.0 \(ghcr\.io\/sealant-ci\/sealant-worker:latest\)/,
  );
  assert.deepEqual(result.writes, []);
});

test("at the floor, a retry moves only the :latest not yet this run's index", async (t) => {
  // sealant-api's :latest moved in an earlier attempt; the others did not.
  const result = await promote(t, {
    tags: {
      ...atVersion("1.2.3"),
      [`${repo("sealant-api")}:latest`]: indexOf("sealant-api"),
      [`${repo("sealant-worker")}:latest`]: `sha256:${"a".repeat(64)}`,
    },
    labels: {
      [`${repo("sealant-api")}:latest`]: "1.2.3",
      [`${repo("sealant-worker")}:latest`]: "1.2.2",
    },
    npm: bothPackages({ latest: "1.2.3" }),
    github: { latest: "v1.2.2" },
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1\.2\.3 may retry/);
  assert.deepEqual(result.writes, [
    promotion("sealant-worker"),
    promotion("sealant-ssh-gateway"),
    promotion("sealant-web"),
    releaseEdit,
  ]);
});

test("an unreadable marker fails the promotion, writing nothing", async (t) => {
  const old = latestAt("1.2.2");
  for (const [label, change, problem] of [
    ["npm answers 500", { npm: { status: 500 } }, /the registry answered 500/],
    [
      "a package npm does not know",
      { npm: { packages: { "@sealant/sdk": { latest: "1.2.2" } } } },
      /the registry answered 404/,
    ],
    ["GitHub answers 500", { github: { status: 500 } }, /GitHub answered 500/],
    ["GitHub answers 403", { github: { status: 403 } }, /GitHub answered 403/],
    [
      "a :latest unreadable",
      { unreadable: [`${repo("sealant-worker")}:latest`] },
      /Could not read ghcr\.io\/sealant-ci\/sealant-worker:latest/,
    ],
  ]) {
    const result = await promote(t, { ...settled(old), ...change });
    assert.equal(result.status, 1, label);
    assert.match(result.output, problem, label);
    assert.deepEqual(result.writes, [], label);
  }
});

/** Markers present but malformed: each fails the floor, never reads as absent or as the version it starts with. */
const MALFORMED = [
  [
    "a label with trailing text",
    { label: "1.2.2 invalid" },
    /sealant-api:latest carries no single plain/,
  ],
  [
    "a label with a trailing newline",
    { label: "1.2.2\n" },
    /sealant-api:latest carries no single plain/,
  ],
  ["a label not X.Y.Z", { label: "latest" }, /sealant-api:latest carries no single plain/],
  [
    "platforms that disagree",
    { label: ["1.2.2", "1.2.1"] },
    /carries no single plain X\.Y\.Z org\.opencontainers\.image\.version/,
  ],
  [
    "a missing label",
    { label: null },
    /carries no single plain X\.Y\.Z org\.opencontainers\.image\.version/,
  ],
  ["a GitHub tag of only v", { github: "v" }, /tagged "v", not vX\.Y\.Z/],
  ["a GitHub tag without v", { github: "1.2.2" }, /tagged "1\.2\.2", not vX\.Y\.Z/],
  ["a GitHub tag not X.Y.Z", { github: "v1.2" }, /tagged "v1\.2", not vX\.Y\.Z/],
  ["a GitHub tag that is not a string", { github: 5 }, /tagged 5, not vX\.Y\.Z/],
  ["npm latest a prerelease", { npm: { latest: "1.3.0-next.2" } }, /not a plain X\.Y\.Z/],
  ["npm latest null", { npm: { latest: null } }, /latest is null, not a plain/],
  ["npm latest empty", { npm: { latest: "" } }, /latest is "", not a plain/],
  ["npm latest not a string", { npm: { latest: 122 } }, /latest is 122, not a plain/],
  ["npm dist-tags a list", { npm: [] }, /dist-tags is not a JSON object/],
  ["npm dist-tags not an object", { npm: "1.2.2" }, /dist-tags is not a JSON object/],
  // Past 9 digits a part could overflow Bash's 64-bit arithmetic: refused as not plain.
  [
    "a part past 64 bits",
    { label: "9223372036854775808.0.0" },
    /sealant-api:latest carries no single plain/,
  ],
  ["a part of 10 digits", { github: "v1234567890.0.0" }, /not vX\.Y\.Z/],
  ["an npm part of 10 digits", { npm: { latest: "1234567890.0.0" } }, /not a plain/],
];

test("a present marker that is malformed fails the promotion, writing nothing", async (t) => {
  const old = latestAt("1.2.2");
  for (const [label, { label: imageLabel, github, npm }, problem] of MALFORMED) {
    const result = await promote(t, {
      ...settled(old),
      labels:
        imageLabel === undefined
          ? old.labels
          : { ...old.labels, [`${repo("sealant-api")}:latest`]: imageLabel },
      npm: {
        packages: {
          "@sealant/api-contracts": { latest: "1.2.2" },
          "@sealant/sdk": npm ?? { latest: "1.2.2" },
        },
      },
      github: { latest: github ?? "v1.2.2" },
    });
    assert.equal(result.status, 1, label);
    assert.match(result.output, problem, label);
    assert.deepEqual(result.writes, [], label);
  }
  // The largest part accepted still compares as a number, above the release.
  const top = await promote(t, {
    ...settled(old),
    labels: { ...old.labels, [`${repo("sealant-web")}:latest`]: "999999999.0.0" },
  });
  assert.equal(top.status, 1);
  assert.match(top.output, /below the stable floor 999999999\.0\.0/);
  assert.deepEqual(top.writes, []);
});

test("a :<version> that moved since acceptance, or another release's manifest, moves nothing", async (t) => {
  const moved = await promote(t, {
    tags: { ...atVersion("1.2.3"), [`${repo("sealant-web")}:1.2.3`]: `sha256:${"e".repeat(64)}` },
  });
  assert.equal(moved.status, 1);
  assert.match(moved.output, /resolves to sha256:e{64}, not .*latest stays/);
  assert.deepEqual(moved.writes, []);
  const missing = await promote(t, { tags: {} });
  assert.equal(missing.status, 1);
  assert.match(missing.output, /sealant-api:1\.2\.3 resolves to nothing/);
  assert.deepEqual(missing.writes, []);
  for (const manifest of [{ version: "1.2.2" }, { commit: "a".repeat(40) }, { images: {} }]) {
    const refused = await promote(t, { tags: atVersion("1.2.3"), manifest });
    assert.equal(refused.status, 1, JSON.stringify(manifest));
    assert.deepEqual(refused.writes, []);
  }
});

// --- the retry delays (sealant-sh/mend #1033) ---

const RETRY_MS = 1500;
const delaySteps = () => ({
  npm: stepRun("npm", "Publish to npm"),
  promote: stepRun("promote", "Move latest to this release"),
});
const occurrences = (text, pattern) => text.match(new RegExp(pattern, "g"))?.length ?? 0;
const preambleOf = (run) => run.slice(0, run.indexOf("# --- floor ---"));
const runPreamble = (run, environment) =>
  spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", preambleOf(run)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...environment },
  });

// release-overrides.test.mjs keeps every workflow from setting the override.
test("every retry waits the production delay by default", () => {
  // Every retry wait in release.yml reads the override with the production delay as its default.
  const retry = `setTimeout(resolve, attempt * Number(process.env.RELEASE_TEST_RETRY_MS || ${RETRY_MS}))`;
  assert.equal(
    occurrences(releaseText, retry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    occurrences(releaseText, "setTimeout\\("),
  );
  assert.ok(occurrences(releaseText, "setTimeout\\(") >= 2);
  for (const run of Object.values(delaySteps()))
    assert.ok(run.includes(`echo "retry backoff: production (${RETRY_MS} ms × attempt)"`));
});

test("each step with retried reads logs the delay it runs with, once, before anything else", () => {
  for (const [name, run] of Object.entries(delaySteps())) {
    const production = runPreamble(run, {});
    assert.equal(production.status, 0, `${name}: ${production.stderr}`);
    assert.match(production.stdout, /^retry backoff: production \(1500 ms × attempt\)$/m, name);
    assert.equal(occurrences(production.stdout, "retry backoff"), 1, name);
    const overridden = runPreamble(run, { RELEASE_TEST_RETRY_MS: "7" });
    assert.equal(overridden.status, 0, `${name}: ${overridden.stderr}`);
    assert.match(overridden.stdout, /^retry backoff: overridden to 7 ms × attempt$/m, name);
    // A value that is not a number of milliseconds fails the step, and is not echoed.
    const garbage = runPreamble(run, { RELEASE_TEST_RETRY_MS: "1500; secret-token" });
    assert.notEqual(garbage.status, 0, name);
    assert.match(
      garbage.stdout,
      /RELEASE_TEST_RETRY_MS is not a whole number of milliseconds/,
      name,
    );
    assert.doesNotMatch(garbage.stdout + garbage.stderr, /secret-token/, name);
  }
});

test("the promote step, run whole, logs the production delay when no test overrides it", async (t) => {
  const result = await promote(t, {
    tags: atVersion("1.2.3"),
    environment: { RELEASE_TEST_RETRY_MS: "" },
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(occurrences(result.output, "retry backoff: production \\(1500 ms × attempt\\)"), 1);
  assert.doesNotMatch(result.output, /overridden/);
});

// --- acceptance on the staged bytes ---

/**
 * A stand-in docker for the smoke: pulls by digest record the pull and answer `id` from the image
 * IDs in `ids` (by reference); `docker compose ps` and `docker inspect` answer from `running`
 * (service → {image ID, name}); image labels come from `labels` (image ID → version).
 */
const smokeDocker = (directory, { ids = {}, running = {}, labels = {} }) => {
  const calls = path.join(directory, "calls.jsonl");
  writeFileSync(calls, "");
  mkdirSync(path.join(directory, "bin"), { recursive: true });
  writeFileSync(
    path.join(directory, "bin", "docker"),
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const ids = ${JSON.stringify(ids)}, running = ${JSON.stringify(running)}, labels = ${JSON.stringify(labels)};
if (args[0] === "pull" || args[0] === "tag") process.exit(0);
if (args[0] === "image" && args[1] === "inspect" && args[3] === "--format" && args[4] === "{{.Id}}") {
  console.log(ids[args[2]]); process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect" && args[4]?.includes("org.opencontainers.image.version")) {
  console.log(labels[args[2]] ?? ""); process.exit(0);
}
if (args[0] === "compose" && args.includes("ps")) {
  const service = args.at(-1);
  if (running[service]) console.log("container-" + service);
  process.exit(0);
}
if (args[0] === "inspect") {
  const service = args[1].replace(/^container-/, "");
  console.log(running[service].id + " " + running[service].name); process.exit(0);
}
console.error("stand-in docker: unexpected call " + JSON.stringify(args));
process.exit(79);
`,
  );
  chmodSync(path.join(directory, "bin", "docker"), 0o755);
  return calls;
};

test("each smoke leg pulls its own arch's digests from the manifest and tags only the IDs it pulled", (t) => {
  const directory = scratch(t, "core-smoke-pull-");
  const platforms = Object.fromEntries(
    IMAGES.map((image) => [
      image,
      { amd64: indexOf(`${image}/amd64`), arm64: indexOf(`${image}/arm64`) },
    ]),
  );
  const file = path.join(directory, "release-manifest.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: "1.2.3",
      commit: COMMIT,
      images: Object.fromEntries(
        IMAGES.map((image) => [image, { index: indexOf(image), platforms: platforms[image] }]),
      ),
      packages: Object.fromEntries(
        ["@sealant/api-contracts", "@sealant/sdk"].map((name) => {
          const digest = createHash("sha512").update(name).digest();
          return [
            name,
            {
              file: `${name.slice(1).replace("/", "-")}-1.2.3.tgz`,
              sha512: digest.toString("hex"),
              integrity: `sha512-${digest.toString("base64")}`,
            },
          ];
        }),
      ),
    }),
  );
  const pull = stepRun("selfhost-smoke", "Pull this run's images by digest");
  for (const [arch, runner] of [
    ["amd64", "X64"],
    ["arm64", "ARM64"],
  ]) {
    const ids = Object.fromEntries(
      IMAGES.map((image) => [
        `${repo(image)}@${platforms[image][arch]}`,
        indexOf(`id ${image} ${arch}`),
      ]),
    );
    const calls = smokeDocker(directory, { ids });
    const idsFile = path.join(directory, `ids-${arch}`);
    const run = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", pull], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      env: {
        PATH: `${path.join(directory, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        RUNNER_ARCH: runner,
        ARCH: arch,
        NAMESPACE: `ghcr.io/${OWNER}`,
        MANIFEST: file,
        VERSION: "1.2.3",
        IDS: idsFile,
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      readCalls(calls),
      IMAGES.flatMap((image) => {
        const source = `${repo(image)}@${platforms[image][arch]}`;
        return [
          ["pull", source],
          ["image", "inspect", source, "--format", "{{.Id}}"],
          ["tag", ids[source], `${repo(image)}:1.2.3`],
        ];
      }),
    );
    assert.equal(
      readFileSync(idsFile, "utf8"),
      IMAGES.map((image) => `${image} ${indexOf(`id ${image} ${arch}`)}\n`).join(""),
    );
    // A leg on the other arch's runner refuses before it pulls anything.
    const crossed = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", pull], {
      encoding: "utf8",
      env: {
        PATH: `${path.join(directory, "bin")}:/usr/bin:/bin`,
        RUNNER_ARCH: runner === "X64" ? "ARM64" : "X64",
        ARCH: arch,
        IDS: idsFile,
      },
    });
    assert.equal(crossed.status, 1);
    assert.match(crossed.stdout, /was asked to accept/);
  }
  assert.deepEqual(
    releaseJobs["selfhost-smoke"].strategy.matrix.platform.map((entry) => entry.arch),
    ["amd64", "arm64"],
  );
  const install = releaseJobs["selfhost-smoke"].steps.find(
    (entry) => entry.name === "Run installer against this run's images",
  );
  assert.equal(install.env.SEALANT_VERSION, "${{ needs.release.outputs.version }}");
});

test("the smoke fails unless every service runs the image ID it pulled by digest", (t) => {
  const assertion = stepRun(
    "selfhost-smoke",
    "Assert each service runs the image pulled by digest",
  );
  const services = {
    "sealant-api": "api",
    "sealant-worker": "worker",
    "sealant-ssh-gateway": "ssh-gateway",
    "sealant-web": "web",
  };
  const pulled = Object.fromEntries(IMAGES.map((image) => [image, indexOf(`pulled ${image}`)]));
  const healthy = Object.fromEntries(
    IMAGES.map((image) => [services[image], { id: pulled[image], name: `${repo(image)}:1.2.3` }]),
  );
  const labels = Object.fromEntries(IMAGES.map((image) => [pulled[image], "1.2.3"]));
  const run = (state) => {
    const directory = scratch(t, "core-smoke-assert-");
    smokeDocker(directory, state);
    const ids = path.join(directory, "ids");
    writeFileSync(ids, IMAGES.map((image) => `${image} ${pulled[image]}\n`).join(""));
    return spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", assertion], {
      encoding: "utf8",
      env: {
        PATH: `${path.join(directory, "bin")}:/usr/bin:/bin`,
        HOME: directory,
        NAMESPACE: `ghcr.io/${OWNER}`,
        VERSION: "1.2.3",
        IDS: ids,
      },
    });
  };
  const good = run({ running: healthy, labels });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.equal(occurrences(good.stdout, "as pulled by digest"), 4);
  // A stale local tag ran in place of the pulled image (Astra round 1, finding 2).
  const stale = run({
    running: {
      ...healthy,
      worker: { id: indexOf("stale"), name: `${repo("sealant-worker")}:1.2.3` },
    },
    labels: { ...labels, [indexOf("stale")]: "1.2.3" },
  });
  assert.equal(stale.status, 1);
  assert.match(
    stale.stdout,
    /::error::worker runs sha256:[0-9a-f]{64} .* not .*the image pulled by digest/,
  );
  // The pulled image under another name, another version's label, or a service not running.
  for (const [label, state] of [
    [
      "another name",
      {
        running: {
          ...healthy,
          web: { id: pulled["sealant-web"], name: `${repo("sealant-web")}:latest` },
        },
        labels,
      },
    ],
    [
      "another label",
      { running: healthy, labels: { ...labels, [pulled["sealant-api"]]: "1.2.2" } },
    ],
    ["no container", { running: { ...healthy, "ssh-gateway": undefined }, labels }],
  ]) {
    const result = run(state);
    assert.equal(result.status, 1, label);
  }
});

// The running-image check is a shell step, not a script with its own tests: break it for one
// service at a time and the smoke must fail, naming that service and no other.
test("the smoke fails, naming the service, when one service runs another image or version", (t) => {
  const assertion = stepRun(
    "selfhost-smoke",
    "Assert each service runs the image pulled by digest",
  );
  const services = {
    "sealant-api": "api",
    "sealant-worker": "worker",
    "sealant-ssh-gateway": "ssh-gateway",
    "sealant-web": "web",
  };
  // The IDs the pull (or, on a dry run, the load) step recorded.
  const recorded = Object.fromEntries(IMAGES.map((image) => [image, indexOf(`recorded ${image}`)]));
  const running = Object.fromEntries(
    IMAGES.map((image) => [services[image], { id: recorded[image], name: `${repo(image)}:1.2.3` }]),
  );
  const labels = Object.fromEntries(IMAGES.map((image) => [recorded[image], "1.2.3"]));
  const run = (state) => {
    const directory = scratch(t, "core-smoke-mutation-");
    smokeDocker(directory, state);
    const ids = path.join(directory, "ids");
    writeFileSync(ids, IMAGES.map((image) => `${image} ${recorded[image]}\n`).join(""));
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", assertion], {
      encoding: "utf8",
      env: {
        PATH: `${path.join(directory, "bin")}:/usr/bin:/bin`,
        HOME: directory,
        NAMESPACE: `ghcr.io/${OWNER}`,
        VERSION: "1.2.3",
        IDS: ids,
      },
    });
    return {
      ...result,
      errors: result.stdout.split("\n").filter((line) => line.startsWith("::error::")),
    };
  };
  const intact = run({ running, labels });
  assert.equal(intact.status, 0, intact.stdout + intact.stderr);
  assert.deepEqual(intact.errors, []);
  for (const image of IMAGES) {
    const service = services[image];
    // A container running another image ID than the one recorded, under the expected name and label.
    const other = indexOf(`other ${image}`);
    const swapped = run({
      running: { ...running, [service]: { id: other, name: `${repo(image)}:1.2.3` } },
      labels: { ...labels, [other]: "1.2.3" },
    });
    assert.equal(swapped.status, 1, `${service}: another image ID`);
    assert.equal(swapped.errors.length, 1, `${service}: ${swapped.errors.join(" | ")}`);
    assert.ok(
      swapped.errors[0].startsWith(`::error::${service} runs ${other} `),
      swapped.errors[0],
    );
    assert.ok(swapped.errors[0].includes(`not ${recorded[image]}`), swapped.errors[0]);
    // The recorded image, carrying another version's label.
    const relabelled = run({ running, labels: { ...labels, [recorded[image]]: "1.2.2" } });
    assert.equal(relabelled.status, 1, `${service}: another version label`);
    assert.equal(relabelled.errors.length, 1, `${service}: ${relabelled.errors.join(" | ")}`);
    assert.ok(relabelled.errors[0].startsWith(`::error::${service} runs `), relabelled.errors[0]);
    assert.ok(relabelled.errors[0].includes("version 1.2.2"), relabelled.errors[0]);
    // The other three services are still checked, and pass.
    assert.equal(occurrences(relabelled.stdout, "as pulled by digest"), 3, service);
  }
});

test("acceptance passes only when the smoke on both arches and the workspace e2e passed", () => {
  const gate = releaseJobs.acceptance;
  assert.deepEqual(gate.needs, ["release", "selfhost-smoke", "workspace-e2e"]);
  assert.deepEqual(gate.permissions, {});
  const [step] = gate.steps;
  assert.equal(step.env.SMOKE, "${{ needs.selfhost-smoke.result }}");
  assert.equal(step.env.WORKSPACE, "${{ needs.workspace-e2e.result }}");
  const run = (SMOKE, WORKSPACE) =>
    spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
      env: { PATH: "/usr/bin:/bin", SMOKE, WORKSPACE },
    }).status;
  assert.equal(run("success", "success"), 0);
  for (const [smoke, workspace] of [
    ["failure", "success"],
    ["success", "failure"],
    ["skipped", "success"],
    ["success", "cancelled"],
    ["", ""],
  ])
    assert.equal(run(smoke, workspace), 1, `${smoke} ${workspace}`);
});

// --- the early backport refusal ---

test("pins refuses, early, a stable tag below the highest stable tag", (t) => {
  const step = stepRun("pins", "Refuse a stable tag below the highest stable tag");
  const directory = scratch(t, "core-release-tags-");
  const gh = (refs) =>
    writeFileSync(path.join(directory, "gh"), `#!/bin/sh\nprintf '%s\\n' ${refs.join(" ")}\n`, {
      mode: 0o755,
    });
  gh([
    "refs/tags/v0.9.0",
    "refs/tags/v0.38.1",
    "refs/tags/v0.39.0-next.9",
    "refs/tags/v1.0.0-rc.1",
    "refs/tags/v0.37.4",
  ]);
  const run = (version) =>
    spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step], {
      encoding: "utf8",
      env: {
        PATH: `${directory}:/usr/bin:/bin`,
        VERSION: version,
        GITHUB_REPOSITORY: "sealant-sh/sealant",
      },
    });
  // Compared as numbers: 0.38.1 is the highest stable tag, above 0.9.0 and 0.37.4.
  const backport = run("0.37.5");
  assert.equal(backport.status, 1);
  assert.match(backport.stdout, /v0\.37\.5 is below v0\.38\.1, the highest stable tag/);
  assert.equal(run("0.10.0").status, 1);
  for (const version of ["0.38.1", "0.38.2", "0.39.0", "1.0.0"])
    assert.equal(run(version).status, 0, version);
});

// --- the graph ---

/** A job that publishes or writes: an environment, or any write permission. */
const writes = (definition) =>
  definition.environment !== undefined ||
  Object.values(definition.permissions ?? {}).some((level) => level === "write");
const CHANNEL = { group: "sealant-release-channel", "cancel-in-progress": false, queue: "max" };

test("finalize, npm and promote queue on one release channel lock; nothing else holds it", () => {
  for (const [name, definition] of Object.entries(releaseJobs)) {
    if (["finalize-images", "npm", "promote"].includes(name))
      assert.deepEqual(definition.concurrency, CHANNEL, name);
    else assert.equal(definition.concurrency, undefined, name);
  }
  assert.equal(releaseDocument.concurrency, undefined, "the lock is per job, not per run");
  // Every job that writes is one of the known publishers, or a build or merge that writes staging.
  assert.deepEqual(
    Object.entries(releaseJobs)
      .filter(([, definition]) => writes(definition))
      .map(([name]) => name)
      .toSorted(),
    ["build", "finalize-images", "github-release", "merge", "npm", "promote"],
  );
  assert.deepEqual(releaseDocument.permissions, { contents: "read" });
});

test("only finalize writes :<version>, only promote writes :latest, and nothing writes :X.Y", () => {
  const registryWrites = [];
  for (const [name, definition] of Object.entries(releaseJobs))
    for (const entry of definition.steps ?? []) {
      for (const line of (entry.run ?? "").replace(/\\\n\s*/g, " ").split("\n"))
        if (/imagetools create|docker push|skopeo copy/.test(line) && !/^\s*echo /.test(line))
          registryWrites.push({ at: name, line: line.trim(), entry });
      if (/push=true/.test(entry.with?.outputs ?? ""))
        registryWrites.push({ at: name, line: entry.with.outputs });
      // No metadata-action, which tagged :<version>, :X.Y and :latest together before acceptance.
      assert.doesNotMatch(entry.uses ?? "", /metadata-action/, name);
    }
  // archive-merge writes only to the registry it starts on loopback, inside the job.
  const loopback = registryWrites.filter(({ at }) => at === "archive-merge");
  assert.ok(loopback.length >= 2);
  for (const { entry } of loopback)
    assert.equal(entry.env.REPOSITORY, "127.0.0.1:5000/${{ matrix.image }}");
  for (const name of ["archive-build", "archive-merge"]) {
    assert.deepEqual(releaseJobs[name].permissions, { contents: "read" }, name);
    for (const step of releaseJobs[name].steps)
      assert.doesNotMatch(step.uses ?? "", /login-action/, name);
  }
  assert.match(
    releaseJobs["archive-build"].steps.find((step) => step.id === "build").with.outputs,
    /^type=docker,dest=/,
  );
  const ghcr = registryWrites.filter(({ at }) => at !== "archive-merge");
  registryWrites.length = 0;
  registryWrites.push(...ghcr);
  const tagged = (pattern) =>
    registryWrites.filter(({ line }) => pattern.test(line)).map(({ at }) => at);
  assert.deepEqual(tagged(/:\$VERSION"/), ["finalize-images"]);
  assert.deepEqual(tagged(/:latest"/), ["promote"]);
  assert.deepEqual(tagged(/:\$tag"/), ["merge"]);
  for (const { line } of registryWrites.filter(({ at }) => at === "build"))
    assert.match(line, /push-by-digest=true/);
  assert.deepEqual(registryWrites.map(({ at }) => at).toSorted(), [
    "build",
    "finalize-images",
    "merge",
    "promote",
  ]);
  assert.doesNotMatch(releaseText, /major\}\}\.\{\{minor|pattern=\{\{/);
  // GitHub's latest release moves only in promote, after every :latest, and is created not latest.
  const edits = Object.entries(releaseJobs).filter(([, d]) =>
    (d.steps ?? []).some((s) => /gh release edit/.test(s.run ?? "")),
  );
  assert.deepEqual(
    edits.map(([name]) => name),
    ["promote"],
  );
  const promoteRun = stepRun("promote", "Move latest to this release");
  assert.ok(
    promoteRun.lastIndexOf("gh release edit") > promoteRun.lastIndexOf("imagetools create"),
  );
  assert.match(
    stepRun("github-release", "Create the release with compose + installer assets"),
    /--latest=false/,
  );
});

test("promote reads the floor inside the lock, before any write", () => {
  const run = stepRun("promote", "Move latest to this release");
  const body = run.slice(run.indexOf("# --- end floor ---"));
  const floor = body.indexOf('floor=$(stable_floor "$GITHUB_REPOSITORY_OWNER")');
  const guard = body.indexOf('guard=$(stable_guard "$VERSION" "$floor")');
  assert.ok(floor > 0 && guard > floor);
  assert.ok(body.indexOf("docker buildx imagetools create") > guard);
  assert.ok(body.lastIndexOf("tag_digest ") < body.indexOf("docker buildx imagetools create"));
  assert.match(run, /FLOOR_PACKAGES=\(@sealant\/api-contracts @sealant\/sdk\)/);
  assert.match(run, /FLOOR_IMAGES=\(sealant-api sealant-worker sealant-ssh-gateway sealant-web\)/);
});

test("every publisher waits for acceptance, and promote for npm and the GitHub release", () => {
  const above = (name, seen = new Set()) => {
    for (const need of [releaseJobs[name].needs ?? []].flat())
      if (!seen.has(need)) above(need, seen.add(need));
    return seen;
  };
  for (const name of ["finalize-images", "npm", "github-release", "promote"])
    assert.ok(above(name).has("acceptance"), name);
  assert.ok(
    ["npm", "github-release", "finalize-images"].every((name) => above("promote").has(name)),
  );
  for (const name of ["npm", "github-release"]) assert.ok(above(name).has("finalize-images"), name);
  // npm waits for acceptance itself, and the GitHub release for npm.
  assert.ok(releaseJobs.npm.needs.includes("acceptance"));
  assert.ok(above("github-release").has("npm"));
  assert.ok(above("release-manifest").has("pack"));
});

/** The `# --- floor ---` block a step carries. */
const floorOf = (run) =>
  run.slice(run.indexOf("# --- floor ---"), run.indexOf("# --- end floor ---"));

test("npm and promote carry one floor, byte for byte, and read it before they write", () => {
  const npm = stepRun("npm", "Publish to npm");
  const promoteRun = stepRun("promote", "Move latest to this release");
  assert.ok(floorOf(npm).length > 1000);
  assert.equal(floorOf(npm), floorOf(promoteRun));
  const body = npm.slice(npm.indexOf("# --- end republish ---"));
  const floor = body.indexOf('floor=$(stable_floor "$GITHUB_REPOSITORY_OWNER")');
  const guard = body.indexOf('guard=$(stable_guard "$VERSION" "$floor")');
  assert.ok(floor > 0 && guard > floor);
  assert.ok(body.indexOf("publish_release ") > guard);
  assert.match(body, /if \[\[ \$guard == retry \]\]; then flags\+=\(--verify-only\); fi/);
});

/** Actions a job holding an id-token may use: none checks out or runs repository code. */
const CREDENTIAL_ACTIONS = /^actions\/(setup-node|download-artifact)@[0-9a-f]{40}$/;
/** Commands that install dependencies, run a build tool or run a repository file. */
const BUILDS =
  /\b(pnpm|npx|yarn|tsgo|tsc|tsx|turbo|esbuild|vite|make|cargo)\b|\bnpm (install|ci|i|run|exec|rebuild|test|start|pack)\b|\bnode (?!-e\b)\S|\bdocker (build|buildx build)\b/;

test("no job holding an id-token checks out, installs dependencies or runs a build tool", () => {
  let holders = 0;
  for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
    const { jobs = {}, permissions = {} } =
      parse(readFileSync(new URL(file, workflows), "utf8")) ?? {};
    assert.notEqual(permissions["id-token"], "write", `${file} grants an id-token to every job`);
    for (const [name, definition] of Object.entries(jobs)) {
      if (definition.permissions?.["id-token"] !== "write") continue;
      holders += 1;
      for (const step of definition.steps ?? []) {
        if (step.uses !== undefined) assert.match(step.uses, CREDENTIAL_ACTIONS, `${file} ${name}`);
        // Comments aside, which name what the job does not do.
        const code = (step.run ?? "").replace(/^\s*(#|echo ).*$/gm, "");
        // next.yml's republish block repacks with `npm pack --ignore-scripts`, which runs no package
        // code; release.yml's never repacks.
        const allowed = file === "next.yml" ? code.replace(/npm pack --ignore-scripts/g, "") : code;
        assert.doesNotMatch(allowed, BUILDS, `${file} ${name} ${step.name ?? step.uses}`);
      }
    }
  }
  assert.equal(holders, 2, "next.yml's publish and release.yml's npm hold the only id-tokens");
  // The guard itself catches what the old stable npm job did.
  for (const line of [
    "pnpm install --frozen-lockfile --ignore-scripts",
    'pnpm --filter "@sealant/sdk" run build',
    "npm ci",
    "node tooling/scripts/release-manifest.mjs digest",
    "npx tsc",
    "docker build -f apps/api/Dockerfile .",
  ])
    assert.match(line, BUILDS, line);
  for (const line of [
    "npm publish x.tgz --tag latest",
    "npm view a dist.integrity",
    "node -e 'x'",
    "npm config get registry",
    'docker buildx imagetools inspect "$1"',
  ])
    assert.doesNotMatch(line, BUILDS, line);
  const npm = stepRun("npm", "Publish to npm");
  assert.match(npm, /npm publish "\$tarball" --tag latest --access public --ignore-scripts "\$@"/);
  assert.doesNotMatch(npm, /npm pack|writeFileSync|rebuild_tarball|publish_rebuilt/);
  assert.deepEqual(
    releaseJobs.npm.steps
      .filter((step) => step.uses?.startsWith("actions/download-artifact@"))
      .map((step) => step.with),
    [
      { name: "npm-tarballs", path: "npm" },
      { name: "release-manifest", path: "release" },
    ],
  );
  assert.deepEqual(releaseJobs.npm.permissions, { "id-token": "write" });
  assert.equal(releaseJobs.npm.environment, "release");
  // pack builds with no credential at all.
  assert.deepEqual(releaseJobs.pack.permissions, { contents: "read" });
  assert.equal(
    releaseJobs.pack.steps.find((step) => step.name === "Checkout").with["persist-credentials"],
    false,
  );
});

// GitHub's rule: a job whose `if` names no status function runs only if every job above it, however
// far up, succeeded; a skipped job counts as not succeeded. `fail` names jobs that fail when they run.
const callsStatusFunction = (condition) =>
  /\b(always|cancelled|success|failure)\s*\(\s*\)/.test(
    String(condition ?? "").replace(/'(?:[^']|'')*'/g, "''"),
  );
const simulateRun = ({ graph = releaseJobs, event = "push", fail = [] } = {}) => {
  const needsOf = (name) => [graph[name].needs ?? []].flat();
  const ancestors = (name, seen = new Set()) => {
    for (const need of needsOf(name)) if (!seen.has(need)) ancestors(need, seen.add(need));
    return seen;
  };
  const result = {};
  const pending = new Set(Object.keys(graph));
  while (pending.size > 0) {
    const ready = [...pending].filter((name) => needsOf(name).every((need) => need in result));
    assert.ok(ready.length > 0, "the workflow's needs form a cycle");
    for (const name of ready) {
      let expression = (graph[name].if ?? "").replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
      if (!callsStatusFunction(expression))
        expression = expression === "" ? "success()" : `success() && (${expression})`;
      const allAbove = [...ancestors(name)].every((job) => result[job] === "success");
      const script = expression
        .replace(/!cancelled\(\)/g, "true")
        .replace(/always\(\)/g, "true")
        .replace(/success\(\)/g, String(allAbove))
        .replace(
          /failure\(\)/g,
          String([...ancestors(name)].some((job) => result[job] === "failure")),
        )
        .replace(/inputs\.dry_run/g, JSON.stringify(event === "workflow_dispatch"))
        .replace(/github\.event_name/g, JSON.stringify(event))
        .replace(/github\.repository/g, JSON.stringify("sealant-sh/sealant"))
        .replace(/needs\.([\w-]+)\.outputs\.([\w-]+)/g, (_, need, output) =>
          JSON.stringify(simulatedOutput(need, output, event)),
        )
        .replace(/needs\.([\w-]+)\.result/g, (_, need) => JSON.stringify(result[need]))
        .replace(/!=/g, "!==")
        .replace(/(?<![!=])==/g, "===");
      const runs = Function(`"use strict"; return (${script});`)();
      if (!runs) result[name] = "skipped";
      else if (fail.includes(name)) result[name] = "failure";
      else if (name === "acceptance" && graph === releaseJobs)
        result[name] = acceptanceOutcome(result);
      else result[name] = "success";
      pending.delete(name);
    }
  }
  return result;
};
/** The acceptance job's step as written, given what the smoke and the e2e did. */
const acceptanceOutcome = (result) =>
  spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", releaseJobs.acceptance.steps[0].run], {
    env: {
      PATH: "/usr/bin:/bin",
      SMOKE: result["selfhost-smoke"],
      WORKSPACE: result["workspace-e2e"],
    },
  }).status === 0
    ? "success"
    : "failure";
/** What a job that ran reports, for the outputs job conditions read. */
const simulatedOutput = (job, output, event) => {
  if (output === "target") return event === "push" ? "ghcr" : "archive";
  return "";
};
const PUBLISHERS = ["finalize-images", "npm", "github-release", "promote"];

test("a tag push runs every publisher after acceptance; a failed acceptance runs none of them", () => {
  const push = simulateRun();
  for (const name of Object.keys(releaseJobs))
    assert.equal(push[name], name.startsWith("archive-") ? "skipped" : "success", name);
  for (const failed of [
    "selfhost-smoke",
    "workspace-e2e",
    "release-manifest",
    "merge",
    "build",
    "pins",
    "pack",
    "acceptance",
  ]) {
    const run = simulateRun({ fail: [failed] });
    for (const name of PUBLISHERS)
      assert.equal(run[name], "skipped", `${name} after ${failed} failed`);
  }
  // Each publisher stops the ones after it.
  const finalizeFailed = simulateRun({ fail: ["finalize-images"] });
  for (const name of ["npm", "github-release", "promote"])
    assert.equal(finalizeFailed[name], "skipped", name);
  // The GitHub release waits for npm.
  const npmFailed = simulateRun({ fail: ["npm"] });
  assert.equal(npmFailed["github-release"], "skipped");
  assert.equal(simulateRun({ fail: ["pack"] }).npm, "skipped");
  for (const failed of ["npm", "github-release"])
    assert.equal(simulateRun({ fail: [failed] }).promote, "skipped", failed);
});

test("a dry-run dispatch builds to archives and accepts them, and runs nothing that publishes", () => {
  const dispatch = simulateRun({ event: "workflow_dispatch" });
  for (const name of [
    "archive-build",
    "archive-merge",
    "pack",
    "release-manifest",
    "selfhost-smoke",
    "workspace-e2e",
    "acceptance",
  ])
    assert.equal(dispatch[name], "success", name);
  for (const name of ["build", "merge", ...PUBLISHERS])
    assert.equal(dispatch[name], "skipped", name);
  // A failed archive leg fails acceptance there too.
  const failed = simulateRun({ event: "workflow_dispatch", fail: ["archive-merge"] });
  assert.equal(failed["selfhost-smoke"], "skipped");
  assert.equal(failed.acceptance, "failure");
  // Every job that writes, holds an environment or could mint an id-token is skipped on a dispatch.
  const writers = Object.entries(releaseJobs).filter(([, definition]) => writes(definition));
  assert.deepEqual(writers.map(([name]) => name).toSorted(), [
    "build",
    "finalize-images",
    "github-release",
    "merge",
    "npm",
    "promote",
  ]);
  for (const [name] of writers) assert.equal(dispatch[name], "skipped", name);
  // And on a push the archive jobs, which hold nothing, never run.
  const push = simulateRun();
  for (const name of ["archive-build", "archive-merge"]) assert.equal(push[name], "skipped", name);
  // Nothing in this workflow can delete or rewrite artifacts or runs.
  for (const [name, definition] of Object.entries(releaseJobs))
    assert.notEqual(definition.permissions?.actions, "write", name);
});

test("every job that publishes runs only on a tag push, building only to GHCR", () => {
  for (const name of ["build", "merge"])
    assert.equal(releaseJobs[name].if, "needs.release.outputs.target == 'ghcr'", name);
  for (const name of PUBLISHERS)
    assert.match(
      releaseJobs[name].if,
      /^\$\{\{ !cancelled\(\) && github\.event_name == 'push' && /,
      name,
    );
});

// The same rule across every workflow. A job whose `if` names no status function is skipped when
// any job above it was. Each such job below a job that can be skipped is listed here with why that
// skip is also this job's; a new one fails until someone has looked.
const SKIPPED_TOGETHER = new Map([
  ["release.yml merge", "same target as build above it"],
  ["release.yml archive-merge", "same target as archive-build above it"],
  // next.yml: plan skips only outside sealant-sh/sealant, and the rest only when it decides not to publish.
  ["next.yml image", "plan skips only on a fork; publish is plan's decision"],
  ["next.yml test", "plan skips only on a fork; publish is plan's decision"],
  ["next.yml workspace-e2e", "plan skips only on a fork; publish is plan's decision"],
  ["next.yml image-tag", "skipped exactly when plan decided not to publish"],
  ["next.yml pack", "skipped exactly when plan decided not to publish"],
  ["next.yml publish", "skipped exactly when plan decided not to publish"],
]);

test("no workflow job is skipped behind a job its own path expected to skip, unless reviewed", () => {
  const exposed = [];
  for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
    const { jobs: all = {} } = parse(readFileSync(new URL(file, workflows), "utf8")) ?? {};
    const needsOf = (name) => [all[name]?.needs ?? []].flat();
    const ancestors = (name, seen = new Set()) => {
      for (const need of needsOf(name)) if (!seen.has(need)) ancestors(need, seen.add(need));
      return seen;
    };
    for (const [name, job] of Object.entries(all)) {
      if (callsStatusFunction(job.if)) continue;
      if ([...ancestors(name)].some((above) => all[above]?.if !== undefined))
        exposed.push(`${file} ${name}`);
    }
  }
  assert.deepEqual(exposed.toSorted(), [...SKIPPED_TOGETHER.keys()].toSorted());
  assert.equal(callsStatusFunction("inputs.dry_run && 'always()' != ''"), false);
  assert.equal(callsStatusFunction("${{ !cancelled() && github.event_name == 'push' }}"), true);
  assert.equal(callsStatusFunction(undefined), false);
});

// --- the dry run ---

const resolveStep = releaseJobs.release.steps.find((step) => step.id === "resolve");
/** The release job's resolve step as written, in a checkout whose packages/sdk is at `sdk`. */
const resolve = (t, environment, sdk = "0.38.1") => {
  const directory = scratch(t, "core-release-resolve-");
  mkdirSync(path.join(directory, "packages/sdk"), { recursive: true });
  writeFileSync(
    path.join(directory, "packages/sdk/package.json"),
    JSON.stringify({ name: "@sealant/sdk", version: sdk }),
  );
  const output = path.join(directory, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", resolveStep.run], {
    cwd: directory,
    encoding: "utf8",
    env: {
      PATH: `${jqDirectory}:/usr/bin:/bin`,
      GITHUB_RUN_ID: "38700000001",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_OUTPUT: output,
      ...environment,
    },
  });
  const values = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=")),
  );
  return { status: result.status, output: result.stdout + result.stderr, ...values };
};

test("a dispatch is a dry run or nothing, and its version is always derived from the run", (t) => {
  assert.deepEqual(releaseDocument.on.workflow_dispatch.inputs, {
    dry_run: {
      description: "Build, accept and check a release without publishing anything",
      required: true,
      type: "boolean",
    },
  });
  assert.equal(resolveStep.env.DRY_RUN, "${{ inputs.dry_run }}");
  const dispatch = {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/feature",
    GITHUB_REF_NAME: "feature",
  };
  const dry = resolve(t, { ...dispatch, DRY_RUN: "true" });
  assert.equal(dry.status, 0, dry.output);
  assert.equal(dry.version, "0.38.1-dryrun.38700000001.2");
  assert.equal(dry.target, "archive");
  // Nothing the dispatcher controls names the version: not the ref, not a tag-shaped ref name.
  assert.equal(
    resolve(t, {
      ...dispatch,
      DRY_RUN: "true",
      GITHUB_REF: "refs/tags/v0.39.0",
      GITHUB_REF_NAME: "v0.39.0",
      VERSION: "0.39.0",
    }).version,
    "0.38.1-dryrun.38700000001.2",
  );
  // An SDK version that is not X.Y.Z gives no version at all.
  for (const sdk of ["0.39.0-next.4", "", "0.39"]) {
    const refused = resolve(t, { ...dispatch, DRY_RUN: "true" }, sdk);
    assert.equal(refused.status, 1, sdk);
    assert.equal(refused.version, undefined, sdk);
  }
  for (const value of ["false", "", "1"]) {
    const refused = resolve(t, { ...dispatch, DRY_RUN: value });
    assert.equal(refused.status, 1, value);
    assert.match(refused.output, /only dry-runs a release/);
    assert.equal(refused.version, undefined);
  }
  const tag = resolve(t, {
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/tags/v0.39.0",
    GITHUB_REF_NAME: "v0.39.0",
  });
  assert.deepEqual([tag.status, tag.version, tag.target], [0, "0.39.0", "ghcr"]);
  assert.equal(
    resolve(t, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REF_NAME: "main",
    }).status,
    1,
  );
  assert.equal(resolve(t, { GITHUB_EVENT_NAME: "schedule" }).status, 1);
});

test("a dry-run-shaped tag is refused before anything builds; a push only ever builds to GHCR", (t) => {
  for (const name of [
    "v0.38.1-dryrun.38700000001.1",
    "v0.0.0-dryrun.9.1",
    "v0.39.0-next.4.dryrun.1.1",
  ]) {
    const pushed = resolve(t, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: `refs/tags/${name}`,
      GITHUB_REF_NAME: name,
    });
    assert.equal(pushed.status, 1, name);
    assert.match(pushed.output, /is a dry-run version; a dry run is a dispatch, never a tag/);
    assert.equal(pushed.version, undefined);
    assert.equal(pushed.target, undefined);
  }
  assert.match(resolveStep.run, /push\/ghcr \| workflow_dispatch\/archive\) ;;/);
  // Every job below takes the version and target from this job, and nowhere else.
  assert.doesNotMatch(releaseText, /needs\.pins\.outputs|inputs\.version/);
});

const REFUSE = "Refuse a version that is not this tag's release";

test("every job that publishes first refuses a dry-run version, from the input or from the tag", () => {
  const writers = Object.entries(releaseJobs).filter(([, definition]) => writes(definition));
  for (const [name, definition] of writers) {
    assert.equal(definition.steps[0].name, REFUSE, name);
    assert.deepEqual(
      definition.steps[0].env,
      { VERSION: "${{ needs.release.outputs.version }}" },
      name,
    );
    assert.ok(definition.needs.includes("release"), name);
  }
  const run = (GITHUB_EVENT_NAME, GITHUB_REF_NAME, VERSION) =>
    spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", releaseJobs.npm.steps[0].run], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", GITHUB_EVENT_NAME, GITHUB_REF_NAME, VERSION },
    });
  assert.equal(run("push", "v0.39.0", "0.39.0").status, 0);
  for (const [event, ref, version] of [
    // A dry run's version, however it arrived: derived on a dispatch, or from a pushed tag.
    ["workflow_dispatch", "main", "0.38.1-dryrun.38700000001.1"],
    ["push", "v0.38.1-dryrun.38700000001.1", "0.38.1-dryrun.38700000001.1"],
    // A plain version that is not this run's tag, or a release version on a dispatch.
    ["push", "v0.39.0", "0.38.1-dryrun.38700000001.1"],
    ["workflow_dispatch", "v0.39.0", "0.39.0"],
    ["push", "v0.39.1", "0.39.0"],
    ["push", "v0.39.0-next.4", "0.39.0-next.4"],
    ["push", "v", ""],
  ]) {
    const refused = run(event, ref, version);
    assert.equal(refused.status, 1, `${event} ${ref} ${version}`);
    assert.match(refused.stdout, /not a plain X\.Y\.Z release of its own tag/);
  }
  // Every copy of the step is the same.
  for (const [name, definition] of writers)
    assert.equal(definition.steps[0].run, releaseJobs.npm.steps[0].run, name);
});

test("pins checks a dry-run version only on a dispatch building to archives", (t) => {
  const step = releaseJobs.pins.steps.find(
    (entry) => entry.name === "Refuse a prerelease tag or a prerelease sealantd",
  );
  const directory = scratch(t, "core-release-pins-step-");
  const calls = path.join(directory, "calls");
  // A stand-in node: the step's argv is what matters; the script has its own tests.
  writeFileSync(
    path.join(directory, "node"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(calls)}\n`,
    { mode: 0o755 },
  );
  const run = (GITHUB_EVENT_NAME, TARGET, VERSION) => {
    writeFileSync(calls, "");
    const status = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
      env: { PATH: `${directory}:/usr/bin:/bin`, GITHUB_EVENT_NAME, TARGET, VERSION },
    }).status;
    return { status, argv: readFileSync(calls, "utf8").trim() };
  };
  assert.deepEqual(run("push", "ghcr", "0.39.0"), {
    status: 0,
    argv: "tooling/scripts/check-release-pins.mjs v0.39.0",
  });
  assert.deepEqual(run("workflow_dispatch", "archive", "0.38.1-dryrun.1.1"), {
    status: 0,
    argv: "tooling/scripts/check-release-pins.mjs --dry-run v0.38.1-dryrun.1.1",
  });
  assert.deepEqual(run("workflow_dispatch", "ghcr", "0.38.1-dryrun.1.1"), { status: 1, argv: "" });
  // A push never relaxes the pins, whatever the target says.
  assert.equal(
    run("push", "archive", "0.39.0").argv,
    "tooling/scripts/check-release-pins.mjs v0.39.0",
  );
  // The stray check reads the X.Y.Z a dry run stamps; the backport check runs on a tag push only.
  assert.match(
    stepRun("pins", "Refuse a release that leaves out one of its next builds"),
    /--stray "v\$\{VERSION%%-\*\}"/,
  );
  assert.equal(
    releaseJobs.pins.steps.find(
      (entry) => entry.name === "Refuse a stable tag below the highest stable tag",
    ).if,
    "github.event_name == 'push'",
  );
});
