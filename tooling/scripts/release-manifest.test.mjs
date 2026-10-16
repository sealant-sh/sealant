// The release manifest release.yml writes, and the jobs that write and read it: run as written where
// they are shell, against stand-in commands. Ported from sealant-sh/mend
// scripts/release-manifest.test.mjs, for Core's four images.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import {
  ARCHES,
  IMAGES,
  PACKAGES,
  buildManifest,
  checkIndex,
  validateManifest,
} from "./release-manifest.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("./release-manifest.mjs", import.meta.url));
const { jobs } = parse(readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8"));
const step = (job, name) => {
  const found = jobs[job].steps.find((entry) => entry.name === name);
  assert.ok(found, `release.yml ${job} has the step "${name}"`);
  return found;
};

const scratch = (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "core-release-manifest-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const hex = (seed) => createHash("sha256").update(seed).digest("hex");
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const COMMIT = "f".repeat(40);

/** The records one run's jobs upload, laid out as download-artifact lays out a pattern. */
const records = (directory) => {
  const digests = path.join(directory, "digests");
  const indexes = path.join(directory, "indexes");
  for (const name of IMAGES) {
    for (const arch of ARCHES) {
      const dir = path.join(digests, `digests-${name}--${arch}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, hex(`${name}/${arch}`)), "");
    }
    mkdirSync(path.join(indexes, `index-${name}`), { recursive: true });
    writeFileSync(path.join(indexes, `index-${name}`, "digest"), `sha256:${hex(name)}\n`);
  }
  return { digests, indexes, packages: packageRecords("1.2.3") };
};

/** What the pack job records for each tarball: its file name, sha512 and integrity. */
const packageRecords = (version) =>
  Object.fromEntries(
    PACKAGES.map((name) => {
      const digest = createHash("sha512").update(`${name} tarball`).digest();
      return [
        name,
        {
          file: `${name.slice(1).replace("/", "-")}-${version}.tgz`,
          sha512: digest.toString("hex"),
          integrity: `sha512-${digest.toString("base64")}`,
        },
      ];
    }),
  );

test("the manifest holds every image's index and platform digests, and the run's identity", (t) => {
  const manifest = buildManifest({ version: "1.2.3", commit: COMMIT, ...records(scratch(t)) });
  assert.deepEqual(Object.keys(manifest.images), IMAGES);
  assert.deepEqual(manifest.images["sealant-web"], {
    index: `sha256:${hex("sealant-web")}`,
    platforms: {
      amd64: `sha256:${hex("sealant-web/amd64")}`,
      arm64: `sha256:${hex("sealant-web/arm64")}`,
    },
  });
  assert.deepEqual([manifest.version, manifest.commit], ["1.2.3", COMMIT]);
  assert.deepEqual(manifest.packages, packageRecords("1.2.3"));
  assert.deepEqual(Object.keys(manifest.packages), ["@sealant/api-contracts", "@sealant/sdk"]);
});

test("a run missing a record, or holding a stray one, writes no manifest", (t) => {
  const directory = scratch(t);
  const { digests, indexes, packages } = records(directory);
  const base = { version: "1.2.3", commit: COMMIT, digests, indexes, packages };
  writeFileSync(path.join(digests, "digests-sealant-api--arm64", hex("second")), "");
  assert.throws(() => buildManifest(base), /exactly one file/);
  rmSync(path.join(digests, "digests-sealant-api--arm64"), { recursive: true });
  assert.throws(() => buildManifest(base), /ENOENT/);
  const valid = buildManifest({ version: "1.2.3", commit: COMMIT, ...records(scratch(t)) });
  for (const broken of [
    { ...valid, commit: "abc" },
    { ...valid, version: "1.2" },
    { ...valid, version: "1.2.3-next.4" },
    {
      ...valid,
      images: {
        ...valid.images,
        "sealant-web": { ...valid.images["sealant-web"], index: "latest" },
      },
    },
    {
      ...valid,
      images: {
        ...valid.images,
        "sealant-worker": {
          ...valid.images["sealant-worker"],
          platforms: { amd64: valid.images["sealant-worker"].platforms.amd64 },
        },
      },
    },
    { ...valid, packages: undefined },
    { ...valid, packages: { "@sealant/sdk": valid.packages["@sealant/sdk"] } },
    { ...valid, packages: { ...valid.packages, "@sealant/extra": valid.packages["@sealant/sdk"] } },
    {
      ...valid,
      packages: {
        ...valid.packages,
        "@sealant/sdk": { ...valid.packages["@sealant/sdk"], integrity: "sha512-forged" },
      },
    },
    {
      ...valid,
      packages: {
        ...valid.packages,
        "@sealant/sdk": { ...valid.packages["@sealant/sdk"], file: "sealant-sdk-1.2.2.tgz" },
      },
    },
  ])
    assert.throws(() => validateManifest(broken));
});

test("digest prints one image's platform digest for one arch, and nothing else", (t) => {
  const directory = scratch(t);
  const manifest = buildManifest({ version: "1.2.3", commit: COMMIT, ...records(directory) });
  const file = path.join(directory, "release-manifest.json");
  writeFileSync(file, JSON.stringify(manifest));
  const digest = (...args) =>
    spawnSync(process.execPath, [script, "digest", file, ...args], { encoding: "utf8" });
  for (const image of IMAGES)
    for (const arch of ARCHES)
      assert.equal(digest(image, arch).stdout, `sha256:${hex(`${image}/${arch}`)}\n`);
  for (const args of [
    ["sealant-api", "riscv64"],
    ["sealant-cli", "amd64"],
  ]) {
    const refused = digest(...args);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
  }
});

test("the manifest job writes from this run's records, and keeps them 90 days", (t) => {
  const job = jobs["release-manifest"];
  assert.ok(job.needs.includes("merge"));
  const write = step("release-manifest", "Write release-manifest.json");
  assert.equal(write.env.COMMIT, "${{ github.sha }}");
  const directory = scratch(t);
  const { digests, indexes, packages } = records(directory);
  assert.equal(write.env.PACKAGES, "${{ needs.pack.outputs.records }}");
  assert.ok(job.needs.includes("pack"));
  const run = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", write.run], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: directory,
      VERSION: "1.2.3",
      COMMIT,
      DIGESTS: digests,
      INDEXES: indexes,
      PACKAGES: JSON.stringify(packages),
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const written = JSON.parse(
    readFileSync(path.join(directory, "manifest/release-manifest.json"), "utf8"),
  );
  assert.equal(written.images["sealant-api"].index, `sha256:${hex("sealant-api")}`);
  assert.deepEqual(written.packages, packages);
  const upload = job.steps.find((entry) => entry.with?.name === "release-manifest");
  assert.equal(upload.with["retention-days"], 90);
});

// --- the index imagetools create pushed ---

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
/** A registry document: its bytes and the digest it is read by. */
const doc = (value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, digest: sha256(bytes), value };
};
const imageManifest = (arch) =>
  doc({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: `sha256:${hex(arch)}`,
      size: 1,
    },
    layers: [],
  });
const childOf = (manifest, os, architecture, variant) => ({
  mediaType: OCI_MANIFEST,
  digest: manifest.digest,
  size: manifest.bytes.length,
  platform: { os, architecture, ...(variant ? { variant } : {}) },
});
/** BuildKit's attestation entry for `manifest`. */
const attestationOf = (manifest) => ({
  mediaType: OCI_MANIFEST,
  digest: `sha256:${hex(`attestation of ${manifest.digest}`)}`,
  size: 1,
  platform: { os: "unknown", architecture: "unknown" },
  annotations: {
    "vnd.docker.reference.digest": manifest.digest,
    "vnd.docker.reference.type": "attestation-manifest",
  },
});
const indexOf = (manifests) => doc({ schemaVersion: 2, mediaType: OCI_INDEX, manifests });
const created = (index) => ({
  "containerimage.descriptor": { mediaType: OCI_INDEX, digest: index.digest },
});
const amd64 = imageManifest("amd64");
const arm64 = imageManifest("arm64");
const plainChildren = [childOf(amd64, "linux", "amd64"), childOf(arm64, "linux", "arm64")];

test("an index made from two plain image manifests is the one create reported", () => {
  const index = indexOf(plainChildren);
  assert.equal(checkIndex(created(index), index.bytes, [amd64, arm64]), index.digest);
  assert.equal(
    checkIndex({ ...created(index), "containerimage.digest": index.digest }, index.bytes, [
      amd64,
      arm64,
    ]),
    index.digest,
  );
  assert.throws(
    () =>
      checkIndex({ ...created(index), "containerimage.digest": amd64.digest }, index.bytes, [
        amd64,
        arm64,
      ]),
    /two different ones/,
  );
  assert.throws(() => checkIndex({}, index.bytes, [amd64, arm64]), /no index digest/);
});

test("an index made from attested single-platform indexes holds each source's children", () => {
  const sources = [amd64, arm64].map((manifest, at) =>
    indexOf([plainChildren[at], attestationOf(manifest)]),
  );
  const index = indexOf(sources.flatMap((source) => source.value.manifests));
  assert.equal(checkIndex(created(index), index.bytes, sources), index.digest);
  const partial = indexOf([...plainChildren, attestationOf(amd64)]);
  assert.throws(() => checkIndex(created(partial), partial.bytes, sources), /lacks sha256:/);
  const both = indexOf(plainChildren);
  assert.throws(() => checkIndex(created(both), both.bytes, [both]), /more than one platform/);
});

test("an index missing a source, holding another, or not exactly amd64 and arm64 is refused", () => {
  const other = imageManifest("someone else's arm64");
  const swapped = indexOf([plainChildren[0], childOf(other, "linux", "arm64")]);
  assert.throws(
    () => checkIndex(created(swapped), swapped.bytes, [amd64, arm64]),
    new RegExp(`lacks ${arm64.digest}`),
  );
  const arm = imageManifest("arm/v7");
  for (const [children, sources] of [
    [
      [plainChildren[0], childOf(arm, "linux", "arm", "v7")],
      [amd64, arm],
    ],
    [
      [plainChildren[0], childOf(arm64, "linux", "amd64")],
      [amd64, arm64],
    ],
    [[plainChildren[0]], [amd64]],
  ]) {
    const index = indexOf(children);
    assert.throws(
      () => checkIndex(created(index), index.bytes, sources),
      /not linux\/amd64 and linux\/arm64/,
    );
  }
  const extra = indexOf([...plainChildren, childOf(imageManifest("extra"), "linux", "riscv64")]);
  assert.throws(() => checkIndex(created(extra), extra.bytes, [amd64, arm64]), /from no source/);
  // A lone manifest reported as created, or bytes read for another digest, are refused too.
  assert.throws(
    () => checkIndex(created(arm64), arm64.bytes, [amd64, arm64]),
    /not a multi-arch index/,
  );
  assert.throws(
    () => checkIndex(created(indexOf(plainChildren)), arm64.bytes, [amd64, arm64]),
    /does not hash to/,
  );
});

test("merge records the index create reported, never the one its tag names now", (t) => {
  const record = step("merge", "Check and record the index digest");
  assert.match(record.run, /check-index create\.json/);
  assert.match(record.run, /inspect "\$REPOSITORY@\$digest" --raw >index\.json/);
  assert.doesNotMatch(record.run, /\$REPOSITORY:\$tag/);
  const directory = scratch(t);
  const digests = path.join(directory, "digests");
  const documents = path.join(directory, "documents");
  const work = path.join(directory, "index");
  for (const dir of [digests, documents, work, path.join(directory, "bin")]) mkdirSync(dir);
  const index = indexOf(plainChildren);
  for (const entry of [amd64, arm64, index, indexOf([plainChildren[1]])])
    writeFileSync(path.join(documents, entry.digest), entry.bytes);
  for (const entry of [amd64, arm64]) writeFileSync(path.join(digests, entry.digest.slice(7)), "");
  // A docker that answers raw documents by digest only.
  writeFileSync(
    path.join(directory, "bin", "docker"),
    `#!${process.execPath}
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const at = args[3]?.indexOf("@") ?? -1;
if (args.slice(0, 3).join(" ") !== "buildx imagetools inspect" || args[4] !== "--raw" || at < 0) process.exit(79);
process.stdout.write(readFileSync(${JSON.stringify(documents)} + "/" + args[3].slice(at + 1)));
`,
  );
  chmodSync(path.join(directory, "bin", "docker"), 0o755);
  const run = (create) => {
    writeFileSync(path.join(work, "create.json"), JSON.stringify(create));
    return spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-c", record.run.replaceAll("/tmp/digests", digests)],
      {
        cwd: work,
        encoding: "utf8",
        env: {
          PATH: `${path.join(directory, "bin")}:${process.env.PATH}`,
          REPOSITORY: "ghcr.invalid/fixture/sealant-api",
          GITHUB_WORKSPACE: root,
        },
      },
    );
  };
  const recorded = run(created(index));
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(readFileSync(path.join(work, "digest"), "utf8"), `${index.digest}\n`);
  rmSync(path.join(work, "digest"));
  const lone = run(created(indexOf([plainChildren[1]])));
  assert.equal(lone.status, 1);
  assert.match(lone.stderr, /lacks/);
  assert.equal(readFileSync(path.join(work, "digest"), "utf8"), "");
  const nothing = run({});
  assert.equal(nothing.status, 1);
  assert.match(nothing.stdout, /reported no index digest/);
});
