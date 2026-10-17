// The release manifest release.yml writes, and the jobs that write and read it: run as written where
// they are shell, against stand-in commands. Ported from sealant-sh/mend
// scripts/release-manifest.test.mjs, for Core's four images.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

import {
  ARCHES,
  IMAGES,
  PACKAGES,
  archiveIdentity,
  buildManifest,
  checkArchive,
  checkIndex,
  selectPlatform,
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
    { ...valid, version: "1.2.3-dryrun.0.1" },
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

test("a dry run's version is recorded as it is, beside its archives' digests", (t) => {
  const directory = scratch(t);
  const { digests, indexes } = records(directory);
  const version = "1.2.3-dryrun.38700000001.2";
  const manifest = buildManifest({
    version,
    commit: COMMIT,
    digests,
    indexes,
    packages: packageRecords(version),
  });
  assert.equal(manifest.version, version);
  assert.equal(manifest.packages["@sealant/sdk"].file, `sealant-sdk-${version}.tgz`);
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

test("the manifest job writes from this run's records, whichever merge ran, and keeps them 90 days", (t) => {
  const job = jobs["release-manifest"];
  assert.ok(job.needs.includes("merge") && job.needs.includes("archive-merge"));
  assert.match(job.if, /^\$\{\{ !cancelled\(\) && /);
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

/** `descriptor` annotated as BuildKit annotates an attestation, whatever its platform says. */
const annotated = (descriptor) => ({
  ...descriptor,
  annotations: {
    "vnd.docker.reference.digest": descriptor.digest,
    "vnd.docker.reference.type": "attestation-manifest",
  },
});
/** Astra's round 2: an attestation-annotated linux/amd64 descriptor of the arm64 build. */
const ANNOTATED_AMD64 = annotated(childOf(arm64, "linux", "amd64"));
/** Each way an annotated descriptor can claim a runnable platform, and where it sits. */
const annotatedRunnable = () => [
  ["Astra's annotated amd64 descriptor first", [ANNOTATED_AMD64, ...plainChildren]],
  ["the same descriptor last", [...plainChildren, ANNOTATED_AMD64]],
  [
    "an annotated descriptor of a runnable variant",
    [...plainChildren, annotated(childOf(imageManifest("arm64 v8"), "linux", "arm64", "v8"))],
  ],
  [
    "an annotated descriptor of another digest",
    [annotated(childOf(imageManifest("other amd64"), "linux", "amd64")), ...plainChildren],
  ],
];

/** A source as merge names it: the build job's arch, and its manifest (or attested index). */
const built = (arch, document) => ({ arch, ...document });
const builds = [built("amd64", amd64), built("arm64", arm64)];

test("an index made from two plain image manifests is the one create reported", () => {
  const index = indexOf(plainChildren);
  assert.equal(checkIndex(created(index), index.bytes, builds), index.digest);
  assert.equal(
    checkIndex({ ...created(index), "containerimage.digest": index.digest }, index.bytes, builds),
    index.digest,
  );
  assert.throws(
    () =>
      checkIndex({ ...created(index), "containerimage.digest": amd64.digest }, index.bytes, builds),
    /two different ones/,
  );
  assert.throws(() => checkIndex({}, index.bytes, builds), /no index digest/);
  // BuildKit's arm64 builds may carry the v8 variant.
  const v8 = indexOf([plainChildren[0], childOf(arm64, "linux", "arm64", "v8")]);
  assert.equal(checkIndex(created(v8), v8.bytes, builds), v8.digest);
});

test("an index made from attested single-platform indexes holds each source's children", () => {
  const sources = [amd64, arm64].map((manifest, at) =>
    built(ARCHES[at], indexOf([plainChildren[at], attestationOf(manifest)])),
  );
  const index = indexOf(sources.flatMap((source) => source.value.manifests));
  assert.equal(checkIndex(created(index), index.bytes, sources), index.digest);
  const partial = indexOf([...plainChildren, attestationOf(amd64)]);
  assert.throws(() => checkIndex(created(partial), partial.bytes, sources), /lacks sha256:/);
  const both = indexOf(plainChildren);
  assert.throws(
    () => checkIndex(created(both), both.bytes, [built("amd64", both), built("arm64", arm64)]),
    /more than one platform/,
  );
  // An attested source's build is still bound to its arch's platform.
  const swapped = indexOf([
    childOf(amd64, "linux", "arm64"),
    childOf(arm64, "linux", "amd64"),
    ...sources.map((source) => source.value.manifests[1]),
  ]);
  assert.throws(
    () => checkIndex(created(swapped), swapped.bytes, sources),
    new RegExp(`maps linux/amd64 to ${arm64.digest}, not ${amd64.digest}, the amd64 build`),
  );
});

test("each arch's platform must name that arch's build: a swap, a duplicate, a wrong variant or a missing entry is refused", () => {
  const refused = (children, problem, sources = builds) => {
    const index = indexOf(children);
    assert.throws(() => checkIndex(created(index), index.bytes, sources), problem);
  };
  // Astra's round 1: both sources present, both platforms present, the labels exchanged.
  refused(
    [childOf(amd64, "linux", "arm64"), childOf(arm64, "linux", "amd64")],
    new RegExp(`maps linux/amd64 to ${arm64.digest}, not ${amd64.digest}, the amd64 build`),
  );
  // The same index with the sources named for the other arch is refused the same way.
  refused(plainChildren, /maps linux\/amd64 to sha256:[0-9a-f]{64}, not sha256:[0-9a-f]{64}/, [
    built("amd64", arm64),
    built("arm64", amd64),
  ]);
  refused(
    [childOf(amd64, "linux", "amd64"), childOf(arm64, "linux", "amd64")],
    /has 2 linux\/amd64 entries/,
  );
  refused(
    [...plainChildren, childOf(imageManifest("another arm64"), "linux", "arm64")],
    /has 2 linux\/arm64 entries/,
  );
  // Counted per descriptor, never through a set: a digest listed twice is refused.
  refused(
    [...plainChildren, { ...plainChildren[1], digest: amd64.digest }],
    new RegExp(`lists ${amd64.digest} 2 times`),
  );
  // Another build under one platform alone, the other platform bound to its own build.
  const foreign = imageManifest("someone else's build");
  refused(
    [childOf(foreign, "linux", "amd64"), plainChildren[1]],
    new RegExp(`maps linux/amd64 to ${foreign.digest}, not ${amd64.digest}, the amd64 build`),
  );
  refused(
    [plainChildren[0], childOf(foreign, "linux", "arm64")],
    new RegExp(`maps linux/arm64 to ${foreign.digest}, not ${arm64.digest}, the arm64 build`),
  );
  refused([plainChildren[0]], /has 0 linux\/arm64 entries \(none\), not one/);
  refused(
    [plainChildren[0], childOf(arm64, "linux", "arm64", "v7")],
    /holds linux\/arm64\/v7 \(sha256:[0-9a-f]{64}\), not linux\/amd64 or linux\/arm64/,
  );
  refused([childOf(amd64, "linux", "amd64", "v2"), plainChildren[1]], /holds linux\/amd64\/v2 /);
  refused([childOf(amd64, "windows", "amd64"), plainChildren[1]], /holds windows\/amd64 /);
  refused([{ ...plainChildren[0], platform: undefined }, plainChildren[1]], /holds no platform /);
  // An attestation annotation never takes a descriptor out of its runnable platform: containerd
  // ignores the annotation and selects the first match.
  for (const [label, children] of annotatedRunnable())
    refused(
      children,
      /annotated as an attestation for linux\/(amd64|arm64\/v8), a platform a consumer can select/,
    );
  // A real attestation, annotated and for unknown/unknown, is still one.
  const attested = indexOf([...plainChildren, attestationOf(amd64), attestationOf(arm64)]);
  assert.throws(
    () => checkIndex(created(attested), attested.bytes, builds),
    /from no source/,
    "excluded from the platforms, the attestations are only children no plain source names",
  );
  // One source per arch, no more and no fewer.
  for (const sources of [[builds[0]], [builds[0], built("amd64", arm64)], [...builds, builds[1]]])
    refused(plainChildren, /exactly one source per arch/, sources);
});

test("an index missing a source, holding another, or holding more is refused", () => {
  const other = imageManifest("someone else's arm64");
  const foreign = indexOf([plainChildren[0], childOf(other, "linux", "arm64")]);
  assert.throws(
    () => checkIndex(created(foreign), foreign.bytes, builds),
    new RegExp(`maps linux/arm64 to ${other.digest}, not ${arm64.digest}`),
  );
  const extra = indexOf([...plainChildren, attestationOf(imageManifest("extra"))]);
  assert.throws(() => checkIndex(created(extra), extra.bytes, builds), /from no source/);
  const riscv = indexOf([...plainChildren, childOf(imageManifest("extra"), "linux", "riscv64")]);
  assert.throws(() => checkIndex(created(riscv), riscv.bytes, builds), /holds linux\/riscv64/);
  // A lone manifest reported as created, or bytes read for another digest, are refused too.
  assert.throws(() => checkIndex(created(arm64), arm64.bytes, builds), /not a multi-arch index/);
  assert.throws(
    () => checkIndex(created(indexOf(plainChildren)), arm64.bytes, builds),
    /does not hash to/,
  );
});

test("select resolves an arch through the index as a consumer would, and refuses an ambiguous one", (t) => {
  const index = indexOf(plainChildren);
  for (const [at, arch] of ARCHES.entries())
    assert.equal(selectPlatform(index.bytes, index.digest, arch), plainChildren[at].digest);
  // A swapped index answers the other build: the identity check compares it with this arch's.
  const swapped = indexOf([childOf(amd64, "linux", "arm64"), childOf(arm64, "linux", "amd64")]);
  assert.equal(selectPlatform(swapped.bytes, swapped.digest, "amd64"), arm64.digest);
  const attested = indexOf([...plainChildren, attestationOf(amd64), attestationOf(arm64)]);
  assert.equal(selectPlatform(attested.bytes, attested.digest, "arm64"), arm64.digest);
  for (const [children, problem] of [
    [
      [childOf(amd64, "linux", "amd64"), childOf(arm64, "linux", "amd64")],
      /2 linux\/amd64 entries/,
    ],
    [[plainChildren[1]], /0 linux\/amd64 entries/],
    [[plainChildren[0], childOf(arm64, "linux", "arm64", "v7")], /holds linux\/arm64\/v7/],
  ]) {
    const bad = indexOf(children);
    assert.throws(() => selectPlatform(bad.bytes, bad.digest, "amd64"), problem);
  }
  // An annotated runnable descriptor, first or last, is refused rather than skipped or selected.
  for (const [label, children] of annotatedRunnable()) {
    const bad = indexOf(children);
    for (const arch of ARCHES)
      assert.throws(
        () => selectPlatform(bad.bytes, bad.digest, arch),
        /annotated as an attestation/,
        `${label} ${arch}`,
      );
  }
  assert.throws(() => selectPlatform(index.bytes, swapped.digest, "amd64"), /does not hash to/);
  assert.throws(() => selectPlatform(amd64.bytes, amd64.digest, "amd64"), /not a multi-arch index/);
  assert.throws(() => selectPlatform(index.bytes, index.digest, "riscv64"), /No build for riscv64/);
  // As the identity step runs it.
  const directory = scratch(t);
  const file = path.join(directory, "index.json");
  writeFileSync(file, index.bytes);
  const select = (...args) =>
    spawnSync(process.execPath, [script, "select", file, ...args], { encoding: "utf8" });
  assert.equal(select(index.digest, "arm64").stdout, `${arm64.digest}\n`);
  const refused = select(swapped.digest, "arm64");
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
});

for (const job of ["merge", "archive-merge"])
  test(`${job} records the index create reported, bound to each arch's build`, (t) => {
    const record = step(job, "Check and record the index digest");
    assert.match(record.run, /check-index create\.json/);
    assert.match(record.run, /inspect "\$REPOSITORY@\$digest" --raw >index\.json/);
    assert.match(record.run, /sources\+=\("\$arch=sha256:\$source=source-\$source\.json"\)/);
    assert.doesNotMatch(record.run, /\$REPOSITORY:\$(tag|VERSION)/);
    const directory = scratch(t);
    const digests = path.join(directory, "digests");
    const documents = path.join(directory, "documents");
    const work = path.join(directory, "index");
    for (const dir of [digests, documents, work, path.join(directory, "bin")]) mkdirSync(dir);
    const index = indexOf(plainChildren);
    const swapped = indexOf([childOf(amd64, "linux", "arm64"), childOf(arm64, "linux", "amd64")]);
    for (const entry of [amd64, arm64, index, swapped, indexOf([plainChildren[1]])])
      writeFileSync(path.join(documents, entry.digest), entry.bytes);
    // One directory per build, named for its arch, as download-artifact lays them out.
    const lay = (byArch) => {
      rmSync(digests, { recursive: true, force: true });
      for (const [arch, entry] of Object.entries(byArch)) {
        mkdirSync(path.join(digests, `digests-sealant-api--${arch}`), { recursive: true });
        writeFileSync(
          path.join(digests, `digests-sealant-api--${arch}`, entry.digest.slice(7)),
          "",
        );
      }
    };
    lay({ amd64, arm64 });
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
      rmSync(path.join(work, "digest"), { force: true });
      return spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-c", record.run.replaceAll("/tmp/digests", digests)],
        {
          cwd: work,
          encoding: "utf8",
          env: {
            PATH: `${path.join(directory, "bin")}:${process.env.PATH}`,
            IMAGE: "sealant-api",
            REPOSITORY: "ghcr.invalid/fixture/sealant-api",
            GITHUB_WORKSPACE: root,
          },
        },
      );
    };
    const recorded = run(created(index));
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(readFileSync(path.join(work, "digest"), "utf8"), `${index.digest}\n`);
    const lone = run(created(indexOf([plainChildren[1]])));
    assert.equal(lone.status, 1);
    assert.match(lone.stderr, /0 linux\/amd64 entries/);
    assert.equal(readFileSync(path.join(work, "digest"), "utf8"), "");
    // Astra's swapped index, created and reported as it would be, is not recorded.
    const exchanged = run(created(swapped));
    assert.equal(exchanged.status, 1);
    assert.match(exchanged.stderr, /maps linux\/amd64 to .*, the amd64 build/);
    assert.equal(readFileSync(path.join(work, "digest"), "utf8"), "");
    // Astra's round 2: an annotated linux/amd64 descriptor of the arm64 build, first, is not recorded.
    const annotatedFirst = indexOf([ANNOTATED_AMD64, ...plainChildren]);
    writeFileSync(path.join(documents, annotatedFirst.digest), annotatedFirst.bytes);
    const hidden = run(created(annotatedFirst));
    assert.equal(hidden.status, 1);
    assert.match(hidden.stderr, /annotated as an attestation for linux\/amd64/);
    assert.equal(readFileSync(path.join(work, "digest"), "utf8"), "");
    // The builds' artifacts named for the other arch: the arch comes from the artifact, so refused.
    lay({ amd64: arm64, arm64: amd64 });
    const misnamed = run(created(index));
    assert.equal(misnamed.status, 1);
    assert.match(misnamed.stderr, /maps linux\/amd64 to .*, the amd64 build/);
    lay({ amd64, arm64 });
    const nothing = run({});
    assert.equal(nothing.status, 1);
    assert.match(nothing.stdout, /reported no index digest/);
    // A source given without its arch is refused by the script.
    const file = path.join(work, "index.json");
    writeFileSync(file, index.bytes);
    writeFileSync(path.join(work, "a.json"), amd64.bytes);
    const unnamed = spawnSync(
      process.execPath,
      [script, "check-index", path.join(work, "create.json"), file, `${amd64.digest}=a.json`],
      { cwd: work, encoding: "utf8" },
    );
    assert.equal(unnamed.status, 1);
    assert.match(unnamed.stderr, /is not <arch>=<digest>=<file>/);
  });

// --- a dry run's archives ---

/**
 * An image archive as BuildKit's docker exporter writes one: oci-layout, index.json naming one
 * manifest, the manifest and config blobs, and manifest.json; packed by tar with `./` names.
 * `index` rewrites index.json's manifests, to forge a digest.
 */
const archive = (directory, { arch = "amd64", index } = {}) => {
  const layout = path.join(directory, `layout-${Math.random()}`);
  mkdirSync(path.join(layout, "blobs/sha256"), { recursive: true });
  const blob = (bytes) => {
    const digest = sha256(bytes);
    writeFileSync(path.join(layout, "blobs/sha256", digest.slice(7)), bytes);
    return digest;
  };
  // A nonce in the config, so two fixture archives are two images.
  const config = Buffer.from(
    JSON.stringify({ architecture: arch, os: "linux", nonce: Math.random() }),
  );
  const configDigest = blob(config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: { digest: configDigest, size: config.length },
      layers: [],
    }),
  );
  const manifestDigest = blob(manifest);
  const descriptor = {
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    digest: manifestDigest,
    size: manifest.length,
  };
  writeFileSync(path.join(layout, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  writeFileSync(
    path.join(layout, "index.json"),
    JSON.stringify({ schemaVersion: 2, manifests: index?.(descriptor) ?? [descriptor] }),
  );
  writeFileSync(path.join(layout, "manifest.json"), "[]");
  const file = path.join(directory, `${Math.random()}.tar`);
  execFileSync("tar", ["-cf", file, "-C", layout, "."]);
  return { file, platform: manifestDigest, config: configDigest };
};
/** A manifest whose `image` on `arch` records `platform`. */
const manifestWith = (directory, entries) => {
  const manifest = buildManifest({ version: "1.2.3", commit: COMMIT, ...records(directory) });
  for (const [image, arch, platform] of entries) manifest.images[image].platforms[arch] = platform;
  return manifest;
};

test("an archive's platform digest is computed from the archive, and must be the manifest's", (t) => {
  const directory = scratch(t);
  const built = archive(directory);
  assert.deepEqual(archiveIdentity(built.file), {
    platform: built.platform,
    config: built.config,
    architecture: "amd64",
  });
  const manifest = manifestWith(directory, [["sealant-api", "amd64", built.platform]]);
  // The image IDs it may load as: the config digest, or on the containerd store the manifest's.
  assert.deepEqual(checkArchive(manifest, "sealant-api", "amd64", built.file), [
    built.config,
    built.platform,
  ]);
  // Another image's archive is not this run's sealant-worker.
  assert.throws(
    () => checkArchive(manifest, "sealant-worker", "amd64", built.file),
    /the release manifest records/,
  );
  // The right digest, built for the other arch.
  const arm = archive(directory, { arch: "arm64" });
  const armManifest = manifestWith(scratch(t), [["sealant-api", "amd64", arm.platform]]);
  assert.throws(
    () => checkArchive(armManifest, "sealant-api", "amd64", arm.file),
    /built for arm64/,
  );
});

test("an index.json whose digest is not its manifest's, or that names an index or two manifests, is refused", (t) => {
  const directory = scratch(t);
  const recorded = `sha256:${hex("recorded")}`;
  const forged = archive(directory, {
    index: (descriptor) => [{ ...descriptor, digest: recorded }],
  });
  const manifest = manifestWith(directory, [["sealant-api", "amd64", recorded]]);
  assert.throws(
    () => checkArchive(manifest, "sealant-api", "amd64", forged.file),
    /lacks the manifest/,
  );
  // The blob is present under the claimed name, but its bytes are another manifest's.
  const layout = path.join(directory, "swapped");
  mkdirSync(layout);
  execFileSync("tar", ["-xf", forged.file, "-C", layout]);
  writeFileSync(
    path.join(layout, "blobs/sha256", recorded.slice(7)),
    readFileSync(path.join(layout, "blobs/sha256", forged.platform.slice(7))),
  );
  const swapped = path.join(directory, "swapped.tar");
  execFileSync("tar", ["-cf", swapped, "-C", layout, "."]);
  assert.throws(
    () => checkArchive(manifest, "sealant-api", "amd64", swapped),
    /does not hash to the digest index\.json gives it/,
  );
  const file = path.join(directory, "release-manifest.json");
  writeFileSync(file, JSON.stringify(manifest));
  const result = spawnSync(
    process.execPath,
    [script, "check-archive", file, "sealant-api", "amd64", swapped],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const list = archive(directory, {
    index: (descriptor) => [
      { ...descriptor, mediaType: "application/vnd.oci.image.index.v1+json" },
    ],
  });
  assert.throws(() => archiveIdentity(list.file), /not one image manifest/);
  const two = archive(directory, { index: (descriptor) => [descriptor, descriptor] });
  assert.throws(() => archiveIdentity(two.file), /one platform manifest/);
});

test("the dry run's smoke loads only its arch's checked archives, and tags only the IDs they load as", (t) => {
  const smoke = jobs["selfhost-smoke"];
  const download = smoke.steps.find((entry) => entry.with?.pattern?.startsWith("archive-"));
  assert.equal(download.if, "needs.release.outputs.target == 'archive'");
  assert.equal(download.with.pattern, "archive-*--${{ matrix.platform.arch }}");
  const load = step("selfhost-smoke", "Load this run's images from their archives");
  assert.equal(load.if, "needs.release.outputs.target == 'archive'");
  assert.equal(
    step("selfhost-smoke", "Pull this run's images by digest").if,
    "needs.release.outputs.target == 'ghcr'",
  );
  const directory = scratch(t);
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const calls = path.join(directory, "calls.jsonl");
  writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "image" && args[1] === "inspect") {
  if (process.env.FIXTURE_ONLY && !process.env.FIXTURE_ONLY.split(" ").includes(args[2])) process.exit(1);
  console.log(process.env.FIXTURE_ID ?? args[2]);
}
`,
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  const built = Object.fromEntries(IMAGES.map((image) => [image, archive(directory)]));
  for (const image of IMAGES) {
    const dir = path.join(directory, "archives", `archive-${image}--amd64`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${image}.tar`), readFileSync(built[image].file));
  }
  const manifest = manifestWith(
    directory,
    IMAGES.map((image) => [image, "amd64", built[image].platform]),
  );
  const file = path.join(directory, "release-manifest.json");
  writeFileSync(file, JSON.stringify(manifest));
  const ids = path.join(directory, "ids");
  const run = (extra = {}) => {
    writeFileSync(calls, "");
    return spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", load.run], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        NAMESPACE: "ghcr.io/sealant-ci",
        MANIFEST: file,
        VERSION: "1.2.3-dryrun.9.1",
        ARCH: "amd64",
        IDS: ids,
        ...extra,
      },
    });
  };
  const calledWith = () =>
    readFileSync(calls, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const loaded = run();
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.deepEqual(
    calledWith(),
    IMAGES.flatMap((image) => [
      [
        "load",
        "--input",
        path.join(directory, "archives", `archive-${image}--amd64`, `${image}.tar`),
      ],
      ["image", "inspect", built[image].config, "--format", "{{.Id}}"],
      ["tag", built[image].config, `ghcr.io/sealant-ci/${image}:1.2.3-dryrun.9.1`],
    ]),
  );
  assert.equal(
    readFileSync(ids, "utf8"),
    IMAGES.map((image) => `${image} ${built[image].config}\n`).join(""),
  );
  // Docker's containerd image store IDs an image by its manifest digest.
  const containerd = run({ FIXTURE_ONLY: IMAGES.map((image) => built[image].platform).join(" ") });
  assert.equal(containerd.status, 0, containerd.stderr);
  assert.deepEqual(
    calledWith()
      .filter(([command]) => command === "tag")
      .map((call) => call[1]),
    IMAGES.map((image) => built[image].platform),
  );
  // An image that loads as anything else is never tagged.
  const elsewhere = run({ FIXTURE_ID: `sha256:${"e".repeat(64)}` });
  assert.equal(elsewhere.status, 1);
  assert.match(
    elsewhere.stdout + elsewhere.stderr,
    /did not load as its config digest or its manifest digest/,
  );
  assert.ok(calledWith().every(([command]) => command !== "tag"));
  // A swapped archive is refused before Docker sees it.
  writeFileSync(
    path.join(directory, "archives", "archive-sealant-api--amd64", "sealant-api.tar"),
    readFileSync(built["sealant-web"].file),
  );
  const swapped = run();
  assert.equal(swapped.status, 1);
  assert.match(swapped.stderr, /the release manifest records/);
  assert.ok(calledWith().every(([command]) => command !== "load"));
});

test("archive-build records the digest it computes from its archive, and only if BuildKit agrees", (t) => {
  const record = step("archive-build", "Record the platform digest from the archive");
  const directory = scratch(t);
  const built = archive(directory);
  const run = (DIGEST) =>
    spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-e",
        "-c",
        record.run.replaceAll("/tmp/digests", path.join(directory, "digests")),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, ARCHIVE: built.file, DIGEST },
      },
    );
  assert.equal(run(built.platform).status, 0);
  assert.deepEqual(readdirSync(path.join(directory, "digests")), [built.platform.slice(7)]);
  const disagree = run(`sha256:${"0".repeat(64)}`);
  assert.equal(disagree.status, 1);
  assert.match(disagree.stdout, /The archive holds sha256:[0-9a-f]{64}; BuildKit reported/);
});
