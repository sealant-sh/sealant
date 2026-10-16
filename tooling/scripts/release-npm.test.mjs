// release.yml's npm job, run as written: its floor and republish blocks against a stub npm registry
// on 127.0.0.1, a stub GitHub API and a stand-in docker, with the tarballs crafted the ways three
// reviews found to fool a check of the tarball as built; and normalize-npm-tarball.mjs, which the
// pack job runs and whose --check the job carries written out. Ported from sealant-sh/mend
// scripts/republish.test.mjs, for Core's two packages. (republish.test.mjs is next.yml's.)
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { parse } from "yaml";

import { githubApi, registryStandIn } from "./fixtures/release-markers.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
const npmStep = () =>
  parse(workflow).jobs.npm.steps.find((entry) => entry.name === "Publish to npm").run;
// npm's bundled pacote by default; REPUBLISH_TEST_PACOTE runs the same tests against another one.
const PACOTE =
  process.env.REPUBLISH_TEST_PACOTE ??
  path.join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "npm/node_modules/pacote",
  );

/** The `# --- <name> ---` block of the npm step, unindented. */
const section = (text, name) => {
  const begin = text.indexOf(`# --- ${name} ---`);
  const end = text.indexOf(`# --- end ${name} ---`, begin);
  assert.ok(begin >= 0 && end > begin, `the npm step carries the ${name} block`);
  return text.slice(begin, end);
};
/** The floor block (it defines registry_get), then the republish block. */
const block = [section(npmStep(), "floor"), section(npmStep(), "republish")].join("\n");

/** A ustar archive of `entries` (name → text), names as given, so any path trick can be written. */
const tarGz = (entries) => {
  const blocks = [];
  for (const [name, text] of entries) {
    const content = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = [...header].reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
};

const CONTRACTS = "@sealant/api-contracts";
const SDK = "@sealant/sdk";
const PACKAGES = [CONTRACTS, SDK];
const COMMIT = "c0ffee";
const VERSION = "1.3.0";
/** A normalized manifest, as normalize-npm-tarball.mjs writes one; `extra` adds what it would drop. */
const manifest = (name, version, extra = {}) =>
  JSON.stringify({
    name,
    version,
    type: "module",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    files: ["dist"],
    ...(name === SDK ? { dependencies: { [CONTRACTS]: version } } : {}),
    gitHead: COMMIT,
    publishConfig: { access: "public" },
    ...extra,
  });
const goodEntries = (name, version = VERSION, extra = {}) => [
  ["package/package.json", manifest(name, version, extra)],
  ["package/dist/index.js", "export {};\n"],
  ["package/dist/index.d.ts", "export {};\n"],
];
const sha512 = (bytes) => createHash("sha512").update(bytes).digest();
const integrityOf = (bytes) => `sha512-${sha512(bytes).toString("base64")}`;
const tarballName = (name, version) => `${name.slice(1).replace("/", "-")}-${version}.tgz`;

/**
 * A stub registry: GET packument and dist-tags, PUT publish, PUT dist-tag. It keeps each published
 * tarball's bytes; `forgeIntegrity` serves another dist.integrity than the one npm sent, as a
 * registry that changed the bytes would.
 */
const registry = async (t, seed = {}, { forgeIntegrity = false } = {}) => {
  const packages = new Map(Object.entries(structuredClone(seed)));
  const log = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = decodeURIComponent(request.url ?? "");
      const tagMatch = /^\/-\/package\/(.+)\/dist-tags\/([^/]+)$/.exec(url);
      if (request.method === "PUT" && tagMatch !== null) {
        packages.get(tagMatch[1])["dist-tags"][tagMatch[2]] = JSON.parse(body);
        log.push({ distTag: tagMatch[2], version: JSON.parse(body) });
        response.writeHead(200).end("{}");
        return;
      }
      const tagsMatch = /^\/-\/package\/(.+)\/dist-tags$/.exec(url);
      if (request.method === "GET" && tagsMatch !== null) {
        const record = packages.get(tagsMatch[1]);
        if (record === undefined) response.writeHead(404).end("{}");
        else
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(record["dist-tags"]));
        return;
      }
      const name = url.slice(1);
      if (request.method === "GET") {
        const record = packages.get(name);
        if (record === undefined) response.writeHead(404).end("{}");
        else
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(record));
        return;
      }
      if (request.method === "PUT") {
        const published = JSON.parse(body);
        const record = packages.get(name) ?? { name, versions: {}, "dist-tags": {} };
        if (forgeIntegrity)
          for (const entry of Object.values(published.versions))
            entry.dist.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
        Object.assign(record.versions, published.versions);
        Object.assign(record["dist-tags"], published["dist-tags"]);
        const [version] = Object.keys(published.versions);
        packages.set(name, record);
        log.push({
          name,
          publish: version,
          distTags: published["dist-tags"],
          manifest: published.versions[version],
          bytes: Buffer.from(Object.values(published["_attachments"])[0].data, "base64"),
        });
        response.writeHead(201).end("{}");
        return;
      }
      response.writeHead(405).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/`, log, packages };
};

/** Both packages at `latest` 1.2.2, plus `versions` (name → {version → record}). */
const seeded = (versions = {}, distTags = { latest: "1.2.2" }) =>
  Object.fromEntries(
    PACKAGES.map((name) => [
      name,
      {
        name,
        versions: { "1.2.2": { gitHead: "older" }, ...versions[name] },
        "dist-tags": { ...distTags },
      },
    ]),
  );

/**
 * This run's artifacts in `directory`: npm/ holding a tarball of each package (`entries` by name
 * replaces one), release/ the manifest recording them (`record` overrides its fields); `tamper`
 * replaces one tarball's bytes after the manifest recorded them; `artifact` adds files to npm/.
 */
const artifacts = (
  directory,
  { version = VERSION, entries = {}, record = {}, tamper = {}, artifact = {} } = {},
) => {
  for (const dir of ["npm", "release"]) mkdirSync(path.join(directory, dir));
  const bytes = {};
  const packages = {};
  for (const name of PACKAGES) {
    bytes[name] = tarGz(entries[name] ?? goodEntries(name, version));
    const digest = sha512(bytes[name]);
    packages[name] = {
      file: tarballName(name, version),
      sha512: digest.toString("hex"),
      integrity: `sha512-${digest.toString("base64")}`,
    };
    writeFileSync(
      path.join(directory, "npm", tarballName(name, version)),
      tamper[name] === undefined ? bytes[name] : tarGz(tamper[name]),
    );
  }
  for (const [file, text] of Object.entries(artifact))
    writeFileSync(path.join(directory, "npm", file), text);
  writeFileSync(
    path.join(directory, "release", "release-manifest.json"),
    JSON.stringify({ version, commit: COMMIT, packages, ...record }),
  );
  return bytes;
};

const npmEnvironment = (directory, stub) => {
  const npmrc = path.join(directory, "npmrc");
  writeFileSync(npmrc, `${stub.url.replace("http:", "")}:_authToken=test\n`);
  return {
    REPUBLISH_TEST_PACOTE: PACOTE,
    REPUBLISH_TEST_WAIT: "0",
    RELEASE_TEST_RETRY_MS: "1",
    NPM_CONFIG_REGISTRY: stub.url,
    NPM_CONFIG_USERCONFIG: npmrc,
  };
};
const collect = async (child) => {
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  return { status, output };
};

/** publish_release over this run's artifacts, against the stub; `verify` passes --verify-only. */
const publish = async (t, stub, { verify = false, version = VERSION, ...options } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), "core-release-npm-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = artifacts(directory, { version, ...options });
  const script = `set -euo pipefail\n${block}\npublish_release ${verify ? "--verify-only " : ""}"$@"`;
  const child = spawn(
    "bash",
    ["-c", script, "republish", `${directory}/npm`, `${directory}/release`, version, COMMIT],
    { cwd: directory, env: { ...process.env, ...npmEnvironment(directory, stub) } },
  );
  return { ...(await collect(child)), bytes };
};

test("both tarballs are published under latest as they are, the contracts first, and read back", async (t) => {
  const stub = await registry(t, seeded());
  const { status, output, bytes } = await publish(t, stub);
  assert.equal(status, 0, output);
  assert.deepEqual(
    stub.log.map(({ name, publish: version, distTags }) => [name, version, distTags]),
    [
      [CONTRACTS, VERSION, { latest: VERSION }],
      [SDK, VERSION, { latest: VERSION }],
    ],
  );
  // Not repacked: the registry received the bytes the manifest recorded.
  for (const [at, name] of PACKAGES.entries()) {
    assert.deepEqual(stub.log[at].bytes, bytes[name]);
    assert.equal(stub.log[at].manifest.dist.integrity, integrityOf(bytes[name]));
    assert.equal(stub.log[at].manifest.gitHead, COMMIT);
  }
  assert.equal((output.match(/published with the integrity this run packed/g) ?? []).length, 2);
});

test("a tarball whose sha512 is not the manifest's is refused before npm publishes either", async (t) => {
  const stub = await registry(t, seeded());
  const result = await publish(t, stub, {
    tamper: { [SDK]: [...goodEntries(SDK), ["package/dist/extra.js", "evil();\n"]] },
  });
  assert.notEqual(result.status, 0, result.output);
  assert.match(
    result.output,
    /sealant-sdk-1\.3\.0\.tgz has another sha512 than the release manifest records/,
  );
  assert.equal(stub.log.length, 0);
});

test("a release manifest of another version, commit, file or package set is refused before npm runs", async (t) => {
  for (const [record, problem] of [
    [{ version: "1.2.9" }, /is for 1\.2\.9, not 1\.3\.0/],
    [{ commit: "beef" }, /is from beef, not c0ffee/],
    [
      { packages: { [CONTRACTS]: { file: "other.tgz", sha512: "0", integrity: "sha512-x" } } },
      /names other\.tgz for @sealant\/api-contracts/,
    ],
    [{ packages: {} }, /names undefined for @sealant\/api-contracts/],
  ]) {
    const stub = await registry(t, seeded());
    const result = await publish(t, stub, { record });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, problem);
    assert.equal(stub.log.length, 0);
  }
});

test("a registry serving another integrity after the publish is an incident", async (t) => {
  const stub = await registry(t, seeded(), { forgeIntegrity: true });
  const result = await publish(t, stub);
  assert.notEqual(result.status, 0, result.output);
  assert.match(
    result.output,
    /::error::INCIDENT: @sealant\/api-contracts@1\.3\.0 .*Do not republish: deprecate/,
  );
  // The job stops at the first incident: the SDK is not published over it.
  assert.deepEqual(
    stub.log.map(({ name }) => name),
    [CONTRACTS],
  );
});

test("a tarball that is not normalized is refused, never rewritten: tag, scripts, publishConfig, .npmrc, binding.gyp", async (t) => {
  for (const [entries, problem] of [
    [goodEntries(SDK, VERSION, { tag: "next" }), /it keeps tag/],
    [
      goodEntries(SDK, VERSION, { scripts: { prepublishOnly: "pnpm run build" } }),
      /it keeps scripts/,
    ],
    [
      goodEntries(SDK, VERSION, { devDependencies: { "@sealant/typescript": "0.0.0" } }),
      /it keeps devDependencies/,
    ],
    [
      goodEntries(SDK, VERSION, {
        publishConfig: { access: "public", registry: "https://evil.example/" },
      }),
      /publishConfig holds more than access/,
    ],
    [
      [...goodEntries(SDK), ["package/dist/.npmrc", "registry=https://evil.example/\n"]],
      /it holds dist\/\.npmrc/,
    ],
    [[...goodEntries(SDK), ["package/binding.gyp", "{ 'targets': [] }"]], /binding\.gyp/],
    [goodEntries(SDK, VERSION, { gitHead: "forged" }), /gitHead forged, not c0ffee/],
    [goodEntries(SDK, "1.3.1"), /version 1\.3\.1, not 1\.3\.0/],
  ]) {
    const stub = await registry(t, seeded());
    const result = await publish(t, stub, { entries: { [SDK]: entries } });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, problem);
    // Both are checked before either publishes.
    assert.equal(stub.log.length, 0);
  }
});

test("the SDK depends on the contracts at exactly this version, never a range, alias or workspace", async (t) => {
  for (const spec of ["^1.3.0", "workspace:*", "1.2.2", `npm:${CONTRACTS}-next@1.3.0`]) {
    const stub = await registry(t, seeded());
    const result = await publish(t, stub, {
      entries: { [SDK]: goodEntries(SDK, VERSION, { dependencies: { [CONTRACTS]: spec } }) },
    });
    assert.notEqual(result.status, 0, spec);
    assert.match(result.output, /@sealant\/api-contracts/, spec);
    assert.equal(stub.log.length, 0, spec);
  }
});

test("a dry-run or prerelease version is refused by the publisher", async (t) => {
  for (const version of ["1.3.0-dryrun.38931186422.1", "1.3.0-next.4"]) {
    const stub = await registry(t, seeded());
    const result = await publish(t, stub, {
      version,
      entries: Object.fromEntries(PACKAGES.map((name) => [name, goodEntries(name, version)])),
    });
    assert.notEqual(result.status, 0, version);
    assert.match(result.output, /is not a latest version/, version);
    assert.equal(stub.log.length, 0, version);
  }
});

test("an artifact holding anything but the expected tarballs is refused before npm runs", async (t) => {
  for (const [file, text] of [
    [".npmrc", "https-proxy=http://127.0.0.1:9/\nstrict-ssl=false\n"],
    ["extra.tgz", "x"],
  ]) {
    const stub = await registry(t, seeded());
    const result = await publish(t, stub, { artifact: { [file]: text } });
    assert.notEqual(result.status, 0, file);
    assert.match(result.output, /more than the expected tarballs/);
    assert.equal(stub.log.length, 0);
  }
});

test("a version already published from this commit is done once its integrity checks; from another, refused", async (t) => {
  const bytes = Object.fromEntries(PACKAGES.map((name) => [name, tarGz(goodEntries(name))]));
  const ours = (name) => ({
    [VERSION]: { gitHead: COMMIT, dist: { integrity: integrityOf(bytes[name]) } },
  });
  const done = await registry(t, seeded({ [CONTRACTS]: ours(CONTRACTS), [SDK]: ours(SDK) }));
  const again = await publish(t, done);
  assert.equal(again.status, 0, again.output);
  assert.equal(done.log.length, 0);
  const other = await registry(t, seeded({ [CONTRACTS]: { [VERSION]: { gitHead: "elsewhere" } } }));
  const refused = await publish(t, other);
  assert.notEqual(refused.status, 0);
  assert.match(refused.output, /@sealant\/api-contracts@1\.3\.0 was published from elsewhere/);
  assert.equal(other.log.length, 0);
});

test("a registry failure stops the job instead of being read as nothing published", async (t) => {
  const stub = await registry(t, {});
  const { status, output } = await publish(t, stub);
  assert.notEqual(status, 0);
  assert.match(output, /answered 404/);
  assert.equal(stub.log.length, 0);
});

// --- verify-only, at the floor ---

test("verify-only republishes nothing and moves no dist-tag when npm holds both", async (t) => {
  const bytes = Object.fromEntries(PACKAGES.map((name) => [name, tarGz(goodEntries(name))]));
  const ours = (name) => ({
    [VERSION]: { gitHead: COMMIT, dist: { integrity: integrityOf(bytes[name]) } },
  });
  const stub = await registry(
    t,
    seeded({ [CONTRACTS]: ours(CONTRACTS), [SDK]: ours(SDK) }, { latest: VERSION }),
  );
  const result = await publish(t, stub, { verify: true });
  assert.equal(result.status, 0, result.output);
  assert.equal((result.output.match(/a same-version retry publishes nothing/g) ?? []).length, 2);
  assert.equal(stub.log.length, 0);
  // Other bytes under the version are the incident.
  const forged = await registry(
    t,
    seeded(
      {
        [CONTRACTS]: ours(CONTRACTS),
        [SDK]: { [VERSION]: { gitHead: COMMIT, dist: { integrity: "sha512-other" } } },
      },
      { latest: VERSION },
    ),
  );
  const incident = await publish(t, forged, { verify: true });
  assert.notEqual(incident.status, 0);
  assert.match(incident.output, /::error::INCIDENT: @sealant\/sdk@1\.3\.0/);
  assert.equal(forged.log.length, 0);
});

test("verify-only finishes a release that stopped between the two packages, and nothing else", async (t) => {
  const contracts = tarGz(goodEntries(CONTRACTS));
  // An earlier attempt published the contracts from this commit; the SDK never published.
  const partial = await registry(
    t,
    seeded({
      [CONTRACTS]: { [VERSION]: { gitHead: COMMIT, dist: { integrity: integrityOf(contracts) } } },
    }),
  );
  partial.packages.get(CONTRACTS)["dist-tags"].latest = VERSION;
  const finished = await publish(t, partial, { verify: true });
  assert.equal(finished.status, 0, finished.output);
  assert.match(
    finished.output,
    /@sealant\/sdk@1\.3\.0 is not published yet: an earlier attempt stopped/,
  );
  assert.deepEqual(
    partial.log.map(({ name, distTags }) => [name, distTags]),
    [[SDK, { latest: VERSION }]],
  );
  // npm holding neither, at the floor, means a marker was moved by hand: nothing publishes.
  const handMoved = await registry(t, seeded());
  const moved = await publish(t, handMoved, { verify: true });
  assert.notEqual(moved.status, 0);
  assert.match(
    moved.output,
    /is the stable floor, but npm does not hold @sealant\/api-contracts@1\.3\.0: a marker was moved by hand/,
  );
  assert.equal(handMoved.log.length, 0);
  // The contracts from another commit is not this release's partial publish.
  const foreign = await registry(
    t,
    seeded({ [CONTRACTS]: { [VERSION]: { gitHead: "elsewhere" } } }),
  );
  const refused = await publish(t, foreign, { verify: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.output, /was published from elsewhere/);
  assert.equal(foreign.log.length, 0);
});

// --- the whole step, with the floor ---

const OWNER = "sealant-ci";
const IMAGES = ["sealant-api", "sealant-worker", "sealant-ssh-gateway", "sealant-web"];
const latestLabels = (version) =>
  Object.fromEntries(IMAGES.map((image) => [`ghcr.io/${OWNER}/${image}:latest`, version]));

/**
 * The npm job's "Publish to npm" step as written (its --provenance left out: it needs GitHub's
 * OIDC), over this run's artifacts, against the stub npm registry, a stub GitHub API for the latest
 * release, and a stand-in docker for each ghcr :latest.
 */
const publishStep = async (
  t,
  stub,
  { version = VERSION, github = {}, labels = {}, unreadable = [], environment = {} } = {},
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "core-release-npm-step-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  artifacts(directory, { version });
  const tags = Object.fromEntries(
    Object.keys(labels).map((ref) => [ref, `sha256:${"b".repeat(64)}`]),
  );
  const docker = registryStandIn(directory, { tags, versions: labels, unreadable });
  const githubStub = await githubApi(t, github);
  const run = npmStep();
  assert.equal(run.split(" --provenance").length, 2);
  const child = spawn("bash", ["-c", run.replace(" --provenance", "")], {
    env: {
      ...process.env,
      PATH: `${docker.bin}:${process.env.PATH}`,
      GITHUB_WORKSPACE: directory,
      GITHUB_SHA: COMMIT,
      GITHUB_REPOSITORY: "sealant-sh/sealant",
      GITHUB_REPOSITORY_OWNER: OWNER,
      GITHUB_API_URL: githubStub.url,
      VERSION: version,
      ...npmEnvironment(directory, stub),
      ...environment,
    },
  });
  return { ...(await collect(child)), github: githubStub.requests, docker: docker.calls() };
};

test("stable npm: above the floor both tarballs publish; below it, by any one marker, nothing does", async (t) => {
  const lower = await registry(t, seeded());
  const published = await publishStep(t, lower, {
    github: { latest: "v1.2.2" },
    labels: latestLabels("1.2.2"),
  });
  assert.equal(published.status, 0, published.output);
  assert.match(published.output, /Stable floor: 1\.2\.2 .*1\.3\.0 may publish/);
  assert.equal(lower.log.length, 2);
  for (const [marker, markers, named] of [
    ["the SDK's npm latest", { seed: { [SDK]: { latest: "1.4.0" } } }, /npm:@sealant\/sdk@latest/],
    [
      "the contracts' npm latest",
      { seed: { [CONTRACTS]: { latest: "1.4.0" } } },
      /npm:@sealant\/api-contracts@latest/,
    ],
    ["GitHub's latest release", { github: { latest: "v1.4.0" } }, /github:sealant-sh\/sealant/],
    [
      "one ghcr :latest",
      {
        labels: {
          ...latestLabels("1.2.2"),
          [`ghcr.io/${OWNER}/sealant-ssh-gateway:latest`]: "1.4.0",
        },
      },
      /ghcr\.io\/sealant-ci\/sealant-ssh-gateway:latest/,
    ],
  ]) {
    const stub = await registry(t, seeded());
    for (const [name, tags] of Object.entries(markers.seed ?? {}))
      stub.packages.get(name)["dist-tags"] = tags;
    const refused = await publishStep(t, stub, { labels: latestLabels("1.2.2"), ...markers });
    assert.equal(refused.status, 1, marker);
    assert.match(refused.output, /1\.3\.0 is below the stable floor/, marker);
    assert.match(refused.output, named, marker);
    assert.equal(stub.log.length, 0, marker);
  }
});

test("stable npm at the floor publishes nothing and only verifies, or finishes this release's own partial publish", async (t) => {
  const bytes = Object.fromEntries(PACKAGES.map((name) => [name, tarGz(goodEntries(name))]));
  const ours = (name) => ({
    [VERSION]: { gitHead: COMMIT, dist: { integrity: integrityOf(bytes[name]) } },
  });
  const retried = await registry(
    t,
    seeded({ [CONTRACTS]: ours(CONTRACTS), [SDK]: ours(SDK) }, { latest: VERSION }),
  );
  const retry = await publishStep(t, retried, {
    github: { latest: "v1.2.2" },
    labels: latestLabels("1.2.2"),
  });
  assert.equal(retry.status, 0, retry.output);
  assert.match(retry.output, /1\.3\.0 may retry/);
  assert.equal(retried.log.length, 0);
  // The contracts at the floor alone (an attempt that stopped before the SDK): the SDK publishes.
  const partial = await registry(t, seeded({ [CONTRACTS]: ours(CONTRACTS) }));
  partial.packages.get(CONTRACTS)["dist-tags"].latest = VERSION;
  const finished = await publishStep(t, partial, { github: { latest: "v1.2.2" } });
  assert.equal(finished.status, 0, finished.output);
  assert.match(
    finished.output,
    /Stable floor: 1\.3\.0 npm:@sealant\/api-contracts@latest; 1\.3\.0 may retry/,
  );
  assert.deepEqual(
    partial.log.map(({ name }) => name),
    [SDK],
  );
  // A marker at the version with neither package published: moved by hand.
  const handMoved = await registry(t, seeded());
  const moved = await publishStep(t, handMoved, { labels: latestLabels(VERSION) });
  assert.equal(moved.status, 1);
  assert.match(moved.output, /a marker was moved by hand/);
  assert.equal(handMoved.log.length, 0);
});

test("stable npm fails, publishing nothing, on an unreadable or malformed marker", async (t) => {
  for (const [label, markers, problem] of [
    ["GitHub answers 502", { github: { status: 502 } }, /GitHub answered 502/],
    [
      "a :latest unreadable",
      { labels: latestLabels("1.2.2"), unreadable: [`ghcr.io/${OWNER}/sealant-web:latest`] },
      /Could not read ghcr\.io\/sealant-ci\/sealant-web:latest/,
    ],
    ["a label not X.Y.Z", { labels: latestLabels("1.2") }, /carries no single plain X\.Y\.Z/],
    ["a GitHub tag of 10 digits", { github: { latest: "v1234567890.0.0" } }, /not vX\.Y\.Z/],
  ]) {
    const stub = await registry(t, seeded());
    const result = await publishStep(t, stub, markers);
    assert.equal(result.status, 1, label);
    assert.match(result.output, problem, label);
    assert.equal(stub.log.length, 0, label);
  }
  const malformed = await registry(t, seeded());
  malformed.packages.get(SDK)["dist-tags"] = { latest: "1.2.2 invalid" };
  const result = await publishStep(t, malformed);
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /npm:@sealant\/sdk dist-tags latest is "1\.2\.2 invalid", not a plain/,
  );
  assert.equal(malformed.log.length, 0);
});

// --- the normalizer the pack job runs, and the publisher's copy of its check ---

const normalizer = fileURLToPath(new URL("./normalize-npm-tarball.mjs", import.meta.url));
const normalize = (args) =>
  spawnSync(process.execPath, [normalizer, ...args], {
    env: { ...process.env, NORMALIZE_PACOTE: PACOTE },
    encoding: "utf8",
  });

test("the normalizer drops what the publisher refuses, repacks once, and its output checks", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "core-normalize-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packed = path.join(directory, "packed.tgz");
  // What pnpm pack writes for the SDK: scripts, devDependencies, publishConfig beyond access.
  writeFileSync(
    packed,
    tarGz([
      ...goodEntries(SDK, VERSION, {
        scripts: { build: "tsgo", prepublishOnly: "pnpm run build" },
        devDependencies: { effect: "4.0.0" },
      }),
      ["package/dist/.npmrc", "registry=https://evil.example/\n"],
    ]),
  );
  const expected = ["--name", SDK, "--version", VERSION, "--commit", COMMIT, "--channel", "latest"];
  mkdirSync(path.join(directory, "out"));
  const made = normalize([packed, "--out", path.join(directory, "out"), ...expected]);
  assert.equal(made.status, 0, made.stderr);
  const record = JSON.parse(made.stdout);
  assert.equal(record.file, "sealant-sdk-1.3.0.tgz");
  assert.deepEqual(readdirSync(path.join(directory, "out")), [record.file]);
  const out = path.join(directory, "out", record.file);
  assert.equal(record.integrity, integrityOf(readFileSync(out)));
  const checked = normalize(["--check", out, ...expected]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout), record);
  // The raw pack is refused by --check, never rewritten by it.
  const raw = normalize(["--check", packed, ...expected]);
  assert.equal(raw.status, 1);
  assert.match(raw.stderr, /not normalized: it keeps scripts, devDependencies/);
  // A wrong version or commit is refused when normalizing too.
  for (const [flag, value] of [
    ["--version", "1.3.1"],
    ["--commit", "beef"],
  ]) {
    const args = [...expected];
    args[args.indexOf(flag) + 1] = value;
    assert.equal(
      normalize([packed, "--out", path.join(directory, "out"), ...args]).status,
      1,
      flag,
    );
  }
});

test("the publisher's check and normalize-npm-tarball.mjs --check give the same answers", async (t) => {
  // The publisher runs no repository file, so it carries the check written out; this holds the
  // copy to the script the pack job ran.
  const directory = mkdtempSync(path.join(tmpdir(), "core-npm-parity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cases = {
    normalized: goodEntries(SDK),
    "the contracts": goodEntries(CONTRACTS),
    "a tag": goodEntries(SDK, VERSION, { tag: "latest" }),
    scripts: goodEntries(SDK, VERSION, { scripts: { prepare: "x" } }),
    "publishConfig beyond access": goodEntries(SDK, VERSION, {
      publishConfig: { access: "public", tag: "x" },
    }),
    "publishConfig without access": goodEntries(SDK, VERSION, { publishConfig: {} }),
    "an .npmrc": [...goodEntries(SDK), ["package/lib/.npmrc", "x=1\n"]],
    "a binding.gyp": [...goodEntries(SDK), ["package/binding.gyp", "{}"]],
    "a forged commit": goodEntries(SDK, VERSION, { gitHead: "forged" }),
    "another version": goodEntries(SDK, "1.3.1"),
    "a prerelease": goodEntries(SDK, "1.3.0-next.4"),
    "a dry-run version": goodEntries(SDK, "1.3.0-dryrun.9.1"),
    "an alias": goodEntries(SDK, VERSION, { dependencies: { [CONTRACTS]: VERSION, a: "npm:b@1" } }),
    "a sibling range": goodEntries(SDK, VERSION, { dependencies: { [CONTRACTS]: "^1.3.0" } }),
    "a sibling alias": goodEntries(SDK, VERSION, {
      dependencies: { [CONTRACTS]: `npm:${CONTRACTS}-next@${VERSION}` },
    }),
  };
  const answers = {};
  for (const [label, entries] of Object.entries(cases)) {
    const tarball = path.join(directory, `${Object.keys(answers).length}.tgz`);
    writeFileSync(tarball, tarGz(entries));
    const name = label === "the contracts" ? CONTRACTS : SDK;
    const fromBlock = await new Promise((resolve) => {
      const child = spawn(
        "bash",
        [
          "-c",
          `set -euo pipefail\n${block}\ncheck_tarball "$@"`,
          "check",
          tarball,
          name,
          VERSION,
          COMMIT,
          "latest",
        ],
        { env: { ...process.env, REPUBLISH_TEST_PACOTE: PACOTE }, stdio: "ignore" },
      );
      child.on("close", resolve);
    });
    const script = normalize([
      "--check",
      tarball,
      "--name",
      name,
      "--version",
      VERSION,
      "--commit",
      COMMIT,
      "--channel",
      "latest",
    ]).status;
    answers[label] = [fromBlock === 0, script === 0];
  }
  for (const [label, [byBlock, byScript]] of Object.entries(answers))
    assert.equal(byBlock, byScript, `${label}: block ${byBlock}, script ${byScript}`);
  assert.deepEqual(
    Object.entries(answers)
      .filter(([, [accepted]]) => accepted)
      .map(([label]) => label),
    ["normalized", "the contracts"],
  );
});

// --- the delays ---

test("the npm step logs both delays it runs with, before anything else, and refuses garbage", () => {
  const preamble = npmStep().slice(0, npmStep().indexOf("# --- floor ---"));
  const run = (environment) =>
    spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", preamble], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...environment },
    });
  const production = run({});
  assert.equal(production.status, 0, production.stderr);
  assert.match(production.stdout, /^retry backoff: production \(1500 ms × attempt\)$/m);
  assert.match(production.stdout, /^integrity read-back wait: production \(5 s × attempt\)$/m);
  const overridden = run({ RELEASE_TEST_RETRY_MS: "7", REPUBLISH_TEST_WAIT: "0" });
  assert.match(overridden.stdout, /^retry backoff: overridden to 7 ms × attempt$/m);
  assert.match(overridden.stdout, /^integrity read-back wait: overridden to 0 s × attempt$/m);
  const garbage = run({ REPUBLISH_TEST_WAIT: "5s secret-token" });
  assert.notEqual(garbage.status, 0);
  assert.doesNotMatch(garbage.stdout + garbage.stderr, /secret-token/);
  // The read-back sleeps the production 5 s unless a test overrides it, and nowhere else.
  assert.equal(
    (workflow.match(/\bsleep \$\(\(attempt \* \$\{REPUBLISH_TEST_WAIT:-5\}\)\)/g) ?? []).length,
    1,
  );
  // release-overrides.test.mjs keeps every workflow from setting it.
});

test("the npm step, run whole, logs the production delays when no test overrides them", async (t) => {
  const stub = await registry(t, seeded());
  const unset = await publishStep(t, stub, {
    environment: { RELEASE_TEST_RETRY_MS: "", REPUBLISH_TEST_WAIT: "" },
  });
  assert.equal(unset.status, 0, unset.output);
  assert.equal(
    (unset.output.match(/retry backoff: production \(1500 ms × attempt\)/g) ?? []).length,
    1,
  );
  assert.equal(
    (unset.output.match(/integrity read-back wait: production \(5 s × attempt\)/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(unset.output, /overridden/);
});
