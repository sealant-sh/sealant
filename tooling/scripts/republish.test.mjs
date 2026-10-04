// The publish job's republish block, run as written in this repository's workflow, against a stub
// npm registry on 127.0.0.1, with tarballs crafted the ways three reviews found to fool a check of
// the tarball as built. The same file lives in sealant-sh/mend, sealant-sh/sealant and
// sealant-sh/sealantd. Keep them identical.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const PACOTE = path.join(
  execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "npm/node_modules/pacote",
);

/** The republish block, from whichever workflow carries it. */
const block = (() => {
  for (const file of ["next.yml", "release-cli.yml"]) {
    const workflow = path.join(root, ".github/workflows", file);
    if (!existsSync(workflow)) continue;
    const text = readFileSync(workflow, "utf8");
    const begin = text.indexOf("# --- republish ---");
    const end = text.indexOf("# --- end republish ---");
    if (begin < 0 || end < begin) continue;
    const lines = text.slice(begin, end).split("\n");
    const indent = /^ */.exec(lines[0] ?? "")?.[0].length ?? 0;
    return lines.map((line) => line.slice(indent)).join("\n");
  }
  throw new Error("No workflow carries the republish block.");
})();

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

const NAME = "@sealant-test/sdk";
const COMMIT = "c0ffee";
const manifest = (version, extra = {}) =>
  JSON.stringify({
    name: NAME,
    version,
    gitHead: COMMIT,
    main: "./dist/index.js",
    files: ["dist"],
    scripts: { prepack: "echo never", postpack: "echo never" },
    ...extra,
  });
const goodEntries = (version) => [
  ["package/package.json", manifest(version)],
  ["package/dist/index.js", "export {};\n"],
];

/** A stub registry: GET packument, PUT publish, PUT dist-tag; `forceLatest` misbehaves. */
const registry = async (t, seed = {}, { forceLatest = false } = {}) => {
  const packages = new Map(Object.entries(seed));
  const log = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = decodeURIComponent(request.url ?? "");
      const tagMatch = /^\/-\/package\/(.+)\/dist-tags\/([^/]+)$/.exec(url);
      if (request.method === "PUT" && tagMatch !== null) {
        const record = packages.get(tagMatch[1]);
        record["dist-tags"][tagMatch[2]] = JSON.parse(body);
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
        Object.assign(record.versions, published.versions);
        Object.assign(record["dist-tags"], published["dist-tags"]);
        const [version] = Object.keys(published.versions);
        if (forceLatest) record["dist-tags"].latest = version;
        packages.set(name, record);
        log.push({
          publish: version,
          distTags: published["dist-tags"],
          manifest: published.versions[version],
        });
        response.writeHead(201).end("{}");
        return;
      }
      response.writeHead(405).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/`, log, packages };
};

/** Runs publish_rebuilt on a crafted tarball against the stub; resolves to the exit status. */
const publish = async (t, stub, entries, version, channel = "next") => {
  const directory = mkdtempSync(path.join(tmpdir(), "republish-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "in.tgz"), tarGz(entries));
  const npmrc = path.join(directory, "npmrc");
  writeFileSync(npmrc, `${stub.url.replace("http:", "")}:_authToken=test\n`);
  const child = spawn(
    "bash",
    [
      "-c",
      `set -euo pipefail\n${block}\npublish_rebuilt "$@"`,
      "republish",
      "in.tgz",
      NAME,
      version,
      COMMIT,
      channel,
    ],
    {
      cwd: directory,
      env: { ...process.env, PACOTE, NPM_CONFIG_REGISTRY: stub.url, NPM_CONFIG_USERCONFIG: npmrc },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  return { status, output };
};

const seeded = (versions = {}, distTags = { latest: "0.38.1" }) => ({
  [NAME]: {
    name: NAME,
    versions: { "0.38.1": { version: "0.38.1" }, ...versions },
    "dist-tags": distTags,
  },
});

test("a good tarball is rebuilt and published under next, without its scripts", async (t) => {
  const stub = await registry(t, seeded());
  const { status, output } = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.equal(status, 0, output);
  assert.equal(stub.log.length, 1);
  assert.deepEqual(stub.log[0].distTags, { next: "0.39.0-next.9" });
  assert.equal(stub.log[0].manifest.scripts, undefined);
  assert.equal(stub.packages.get(NAME)["dist-tags"].latest, "0.38.1");
});

test("a `tag` field in the manifest is dropped, so it cannot publish as latest", async (t) => {
  const stub = await registry(t, seeded());
  const entries = [
    [
      "package/package.json",
      manifest("0.39.0-next.9", {
        tag: "latest",
        publishConfig: { tag: "latest", registry: "https://evil.example/", access: "public" },
      }),
    ],
    ["package/dist/index.js", ""],
  ];
  const { status, output } = await publish(t, stub, entries, "0.39.0-next.9");
  assert.equal(status, 0, output);
  assert.deepEqual(stub.log[0].distTags, { next: "0.39.0-next.9" });
  assert.equal(stub.log[0].manifest.tag, undefined);
  assert.deepEqual(stub.log[0].manifest.publishConfig, { access: "public" });
  assert.equal(stub.packages.get(NAME)["dist-tags"].latest, "0.38.1");
});

for (const [trick, name] of [
  ["package/./package.json", "package/./package.json"],
  ["package//package.json", "package//package.json"],
  ["a second manifest outside package/", "zzz/package.json"],
]) {
  test(`${trick}: npm's own reading is what is checked, and it is refused`, async (t) => {
    const stub = await registry(t, seeded());
    const entries = [
      ...goodEntries("0.39.0-next.9"),
      [name, manifest("0.39.0", { tag: "latest" })],
    ];
    const { status, output } = await publish(t, stub, entries, "0.39.0-next.9");
    assert.notEqual(status, 0, output);
    assert.equal(stub.log.length, 0);
    assert.match(output, /version 0\.39\.0, not 0\.39\.0-next\.9/);
  });
}

test("a second manifest with this version but a forged commit is refused", async (t) => {
  const stub = await registry(t, seeded());
  const entries = [
    ...goodEntries("0.39.0-next.9"),
    ["package//package.json", manifest("0.39.0-next.9", { gitHead: "forged", tag: "latest" })],
  ];
  const { status, output } = await publish(t, stub, entries, "0.39.0-next.9");
  assert.notEqual(status, 0, output);
  assert.equal(stub.log.length, 0);
  assert.match(output, /gitHead forged, not c0ffee/);
});

test("next never moves back: an older version than the current next is refused", async (t) => {
  const stub = await registry(
    t,
    seeded(
      { "0.39.0-next.12": { gitHead: "later" } },
      { latest: "0.38.1", next: "0.39.0-next.12" },
    ),
  );
  const { status, output } = await publish(
    t,
    stub,
    goodEntries("0.39.0-next.11"),
    "0.39.0-next.11",
  );
  assert.notEqual(status, 0, output);
  assert.equal(stub.log.length, 0);
  assert.match(output, /next is already 0\.39\.0-next\.12/);
});

test("a version already published from this commit is done; from another, refused", async (t) => {
  const stub = await registry(t, seeded({ "0.39.0-next.9": { gitHead: COMMIT } }));
  assert.equal((await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9")).status, 0);
  assert.equal(stub.log.length, 0);
  const other = await registry(t, seeded({ "0.39.0-next.9": { gitHead: "elsewhere" } }));
  const refused = await publish(t, other, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.notEqual(refused.status, 0);
  assert.match(refused.output, /published from elsewhere/);
});

test("if latest still ends up on the new version, it is moved back and the job fails", async (t) => {
  const stub = await registry(t, seeded(), { forceLatest: true });
  const { status, output } = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.notEqual(status, 0, output);
  assert.match(output, /became latest/);
  assert.deepEqual(stub.log.at(-1), { distTag: "latest", version: "0.38.1" });
  assert.equal(stub.packages.get(NAME)["dist-tags"].latest, "0.38.1");
});

test("a registry failure stops the job instead of being read as nothing published", async (t) => {
  const stub = await registry(t, {});
  const { status, output } = await publish(t, stub, goodEntries("0.39.0-next.9"), "0.39.0-next.9");
  assert.notEqual(status, 0);
  assert.match(output, /answered 404/);
  assert.equal(stub.log.length, 0);
});

test("a stable release publishes under latest with the same rewrite", async (t) => {
  const stub = await registry(t, seeded());
  const { status, output } = await publish(t, stub, goodEntries("0.39.0"), "0.39.0", "latest");
  assert.equal(status, 0, output);
  assert.deepEqual(stub.log[0].distTags, { latest: "0.39.0" });
  const refused = await publish(
    t,
    await registry(t, seeded()),
    goodEntries("0.39.0-next.9"),
    "0.39.0-next.9",
    "latest",
  );
  assert.notEqual(refused.status, 0);
});

test("the archive writer makes archives npm can read", () => {
  assert.ok(gunzipSync(tarGz(goodEntries("1.0.0"))).length >= 2048);
});
