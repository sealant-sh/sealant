#!/usr/bin/env node
/**
 * The release manifest: what one stable release run (.github/workflows/release.yml) built, by
 * digest, and the two npm tarballs its pack job made, by sha512. Every job after the build reads it
 * from its own run's `release-manifest` artifact, never from a tag, which another writer can move.
 *
 *   write <out>                    from the run's digests-* and index-* records (env below)
 *   digest <manifest> <image> <arch>
 *                                  prints that image's platform digest for that arch
 *   archive-digest <archive>       prints an image archive's platform manifest digest
 *   check-archive <manifest> <image> <arch> <archive>
 *                                  refuses the archive unless its platform manifest digest is the
 *                                  manifest's; prints the image IDs it may load as: its config
 *                                  digest (Docker's classic store), then its manifest digest (the
 *                                  containerd image store)
 *   check-index <metadata> <index> <digest>=<source>...
 *                                  refuses the index `imagetools create --metadata-file` reported
 *                                  unless <index> (its raw JSON, read by that digest) holds exactly
 *                                  the given sources' manifests for linux/amd64 and linux/arm64;
 *                                  prints its digest
 *
 * `write` reads VERSION, COMMIT, DIGESTS (a directory of digests-<image>--<arch>/<hex>, as
 * download-artifact lays them out), INDEXES (index-<image>/digest) and PACKAGES (the pack job's
 * {<name>: {file, sha512, integrity}}).
 *
 * The rules are sealant-sh/mend's scripts/release-manifest.mjs; the images are Core's.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGES = ["sealant-api", "sealant-worker", "sealant-ssh-gateway", "sealant-web"];
export const ARCHES = ["amd64", "arm64"];
/** The npm packages a release publishes, in the order it publishes them. */
export const PACKAGES = ["@sealant/api-contracts", "@sealant/sdk"];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** A release's X.Y.Z, or a dispatched dry run's X.Y.Z-dryrun.<run>.<attempt>, which never publishes. */
const RUN_VERSION =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(-dryrun\.[1-9]\d*\.[1-9]\d*)?$/;
const MANIFEST_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const INDEX_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const PLATFORMS = ARCHES.map((arch) => `linux/${arch}`);

class Refused extends Error {}

function ensure(condition, message) {
  if (!condition) throw new Refused(message);
}

/** Throws unless `manifest` has the release manifest's shape; returns it. */
export function validateManifest(manifest) {
  ensure(
    RUN_VERSION.test(manifest?.version ?? "") && /^[0-9a-f]{40}$/.test(manifest.commit ?? ""),
    "The release manifest needs an X.Y.Z (or dry-run) version and a 40-hex commit",
  );
  for (const image of IMAGES) {
    const entry = manifest.images?.[image];
    ensure(
      DIGEST.test(entry?.index ?? ""),
      `The release manifest has no index digest for ${image}`,
    );
    for (const arch of ARCHES)
      ensure(
        DIGEST.test(entry.platforms?.[arch] ?? ""),
        `The release manifest has no ${arch} digest for ${image}`,
      );
  }
  ensure(
    manifest.packages !== null &&
      typeof manifest.packages === "object" &&
      JSON.stringify(Object.keys(manifest.packages)) === JSON.stringify(PACKAGES),
    `The release manifest must record exactly ${PACKAGES.join(" and ")}`,
  );
  for (const name of PACKAGES) {
    const entry = manifest.packages[name];
    ensure(
      entry?.file === tarballName(name, manifest.version) &&
        /^[0-9a-f]{128}$/.test(entry.sha512 ?? "") &&
        entry.integrity === `sha512-${Buffer.from(entry.sha512, "hex").toString("base64")}`,
      `The release manifest's ${name} entry needs ${tarballName(name, manifest.version)}, its sha512 and the matching integrity`,
    );
  }
  return manifest;
}

/** The file npm pack names <name>@<version>: @sealant/sdk 1.2.3 is sealant-sdk-1.2.3.tgz. */
export const tarballName = (name, version) => `${name.slice(1).replace("/", "-")}-${version}.tgz`;

export const readManifest = (file) => validateManifest(JSON.parse(readFileSync(file, "utf8")));

/** The one regular file in `dir`, which must be all it holds. */
function onlyFile(dir, what) {
  const entries = readdirSync(dir, { withFileTypes: true });
  ensure(
    entries.length === 1 && entries[0].isFile(),
    `${what} must hold exactly one file, not ${entries.map((entry) => entry.name).join(", ")}`,
  );
  return entries[0].name;
}

/** The manifest from one run's records. */
export function buildManifest({ version, commit, digests, indexes, packages }) {
  const images = Object.fromEntries(
    IMAGES.map((image) => {
      const platforms = Object.fromEntries(
        ARCHES.map((arch) => {
          const hex = onlyFile(path.join(digests, `digests-${image}--${arch}`), `${image} ${arch}`);
          ensure(/^[0-9a-f]{64}$/.test(hex), `${image} ${arch} records ${hex}, not a digest`);
          return [arch, `sha256:${hex}`];
        }),
      );
      const directory = path.join(indexes, `index-${image}`);
      ensure(onlyFile(directory, `${image}'s index`) === "digest", `${image}'s index record`);
      const index = readFileSync(path.join(directory, "digest"), "utf8").trim();
      return [image, { index, platforms }];
    }),
  );
  return validateManifest({ version, commit, images, packages });
}

const sha256 = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;

/**
 * The named members of an uncompressed tar, read header by header without loading the archive:
 * an image archive is hundreds of megabytes. Names are compared without a leading `./`; pax `path`
 * records and GNU long names are honoured, so a member cannot hide behind either.
 */
export function readTarMembers(file, wanted) {
  const found = new Map();
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const header = Buffer.alloc(512);
    let offset = 0;
    let longName;
    while (offset + 512 <= size) {
      readSync(fd, header, 0, 512, offset);
      if (header.every((byte) => byte === 0)) break;
      const field = (start, length) => {
        const raw = header.subarray(start, start + length);
        const end = raw.indexOf(0);
        return raw.subarray(0, end < 0 ? length : end).toString("utf8");
      };
      const length = Number.parseInt(field(124, 12).trim() || "0", 8);
      ensure(Number.isSafeInteger(length), `${file} is not a tar archive`);
      const type = field(156, 1);
      // POSIX ustar splits a long name into prefix and name; GNU's own format uses those bytes
      // for other fields, and says so with a different magic.
      const posix = header.subarray(257, 263).toString("latin1") === "ustar\0";
      const prefix = posix ? field(345, 155) : "";
      const body = () => {
        const content = Buffer.alloc(length);
        readSync(fd, content, 0, length, offset + 512);
        return content;
      };
      if (type === "x" || type === "L") {
        const content = body().toString("utf8");
        longName =
          type === "L" ? content.split("\0")[0] : /(?:^|\n)\d+ path=([^\n]*)\n/.exec(content)?.[1];
      } else if (type !== "g") {
        const raw = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
        const name = raw.replace(/^(\.\/)+/, "");
        longName = undefined;
        if (wanted.has(name)) {
          ensure(!found.has(name), `${file} holds ${name} twice`);
          found.set(name, body());
        }
      }
      offset += 512 + Math.ceil(length / 512) * 512;
    }
  } finally {
    closeSync(fd);
  }
  return found;
}

/**
 * An image archive's platform manifest, computed rather than trusted: index.json must name exactly
 * one image manifest, and the blob it names must hash to that digest. Returns the manifest digest
 * and the config digest, which is the image ID Docker loads it as, and the config's architecture.
 */
export function archiveIdentity(archive) {
  const index = readTarMembers(archive, new Set(["index.json"])).get("index.json");
  ensure(index !== undefined, `${archive} has no index.json`);
  const manifests = JSON.parse(index.toString("utf8")).manifests;
  ensure(
    Array.isArray(manifests) && manifests.length === 1,
    `${archive}'s index.json must name one platform manifest`,
  );
  const [descriptor] = manifests;
  ensure(
    MANIFEST_TYPES.has(descriptor.mediaType) && DIGEST.test(descriptor.digest ?? ""),
    `${archive}'s index.json names ${descriptor.mediaType}, not one image manifest`,
  );
  const manifestBlob = `blobs/sha256/${descriptor.digest.slice(7)}`;
  const manifestBytes = readTarMembers(archive, new Set([manifestBlob])).get(manifestBlob);
  ensure(manifestBytes !== undefined, `${archive} lacks the manifest index.json names`);
  ensure(
    sha256(manifestBytes) === descriptor.digest,
    `${archive}'s manifest does not hash to the digest index.json gives it`,
  );
  const config = JSON.parse(manifestBytes.toString("utf8")).config?.digest;
  ensure(DIGEST.test(config ?? ""), `${archive}'s manifest names no config`);
  const configBlob = `blobs/sha256/${config.slice(7)}`;
  const configBytes = readTarMembers(archive, new Set([configBlob])).get(configBlob);
  ensure(
    configBytes !== undefined && sha256(configBytes) === config,
    `${archive}'s config is missing or does not hash to its digest`,
  );
  return {
    platform: descriptor.digest,
    config,
    architecture: JSON.parse(configBytes.toString("utf8")).architecture,
  };
}

/**
 * The IDs Docker may load the archive as, once its platform manifest is the one the release
 * manifest records: the config digest on Docker's classic image store, the manifest digest on the
 * containerd image store. Both are hashes of content checked here.
 */
export function checkArchive(manifest, image, arch, archive) {
  ensure(IMAGES.includes(image) && ARCHES.includes(arch), `No ${image} for ${arch}`);
  const expected = manifest.images[image].platforms[arch];
  const identity = archiveIdentity(archive);
  ensure(
    identity.platform === expected,
    `${archive} holds ${identity.platform}; the release manifest records ${expected} for ${image} ${arch}`,
  );
  ensure(
    identity.architecture === arch,
    `${archive} is built for ${identity.architecture}, not ${arch}`,
  );
  return [identity.config, identity.platform];
}

/** An entry BuildKit adds beside each platform manifest of an attested build. */
const isAttestation = (descriptor) =>
  descriptor.annotations?.["vnd.docker.reference.type"] === "attestation-manifest" ||
  (descriptor.platform?.os === "unknown" && descriptor.platform?.architecture === "unknown");

/** A registry document read by digest (`imagetools inspect …@<digest> --raw`): it must hash to it. */
function document(bytes, digest, what) {
  ensure(DIGEST.test(digest), `${what}: ${digest} is not a sha256 digest`);
  ensure(sha256(bytes) === digest, `${what} does not hash to ${digest}`);
  const parsed = JSON.parse(bytes.toString("utf8"));
  const mediaType = parsed.mediaType;
  ensure(
    MANIFEST_TYPES.has(mediaType) || INDEX_TYPES.has(mediaType),
    `${what} is ${mediaType}, not an image manifest or index`,
  );
  return { ...parsed, index: INDEX_TYPES.has(mediaType) };
}

/**
 * The digest `imagetools create` reported for the index it pushed, once that index is the one this
 * job asked for. The tag it pushed can move before anything reads it again, so the digest comes
 * from create's own metadata and the index is read by that digest. Every source must be in it: a
 * plain image manifest as a child, a single-platform index (an attested build) by each of its
 * children. It must hold nothing else, and its platform entries, attestations aside, must be
 * exactly linux/amd64 and linux/arm64.
 */
export function checkIndex(metadata, indexBytes, sources) {
  const reported = [
    metadata["containerimage.digest"],
    metadata["containerimage.descriptor"]?.digest,
  ].filter((value) => value !== undefined);
  ensure(
    reported.length > 0 && reported.every((value) => value === reported[0]),
    "imagetools create reported no index digest, or two different ones",
  );
  const [digest] = reported;
  const index = document(indexBytes, digest, "The created index");
  ensure(index.index, `The created ${digest} is a single image manifest, not a multi-arch index`);
  const children = new Set(index.manifests.map((descriptor) => descriptor.digest));
  const expected = new Set();
  ensure(sources.length > 0, "check-index needs the sources given to imagetools create");
  for (const { digest: source, bytes } of sources) {
    const parsed = document(bytes, source, `Source ${source}`);
    const wanted = parsed.index
      ? parsed.manifests.map((descriptor) => descriptor.digest)
      : [source];
    if (parsed.index)
      ensure(
        parsed.manifests.filter((descriptor) => !isAttestation(descriptor)).length === 1,
        `Source ${source} is an index of more than one platform`,
      );
    for (const child of wanted) {
      ensure(children.has(child), `The created index lacks ${child}, from source ${source}`);
      expected.add(child);
    }
  }
  const extra = [...children].filter((child) => !expected.has(child));
  ensure(extra.length === 0, `The created index holds ${extra.join(", ")}, from no source`);
  const platforms = index.manifests
    .filter((descriptor) => !isAttestation(descriptor))
    .map(({ platform }) =>
      [platform?.os, platform?.architecture, platform?.variant].filter(Boolean).join("/"),
    )
    .toSorted();
  ensure(
    JSON.stringify(platforms) === JSON.stringify(PLATFORMS),
    `The created index is for ${platforms.join(", ") || "no platform"}, not ${PLATFORMS.join(" and ")}`,
  );
  return digest;
}

function main([command, ...args]) {
  const { env } = process;
  switch (`${command}:${args.length}`) {
    case "write:1": {
      const manifest = buildManifest({
        version: env.VERSION,
        commit: env.COMMIT,
        digests: env.DIGESTS,
        indexes: env.INDEXES,
        packages: JSON.parse(env.PACKAGES ?? "null"),
      });
      writeFileSync(args[0], `${JSON.stringify(manifest, null, 2)}\n`);
      return JSON.stringify(manifest);
    }
    case "digest:3": {
      const [file, image, arch] = args;
      ensure(IMAGES.includes(image) && ARCHES.includes(arch), `No ${image} for ${arch}`);
      return readManifest(file).images[image].platforms[arch];
    }
    case "archive-digest:1":
      return archiveIdentity(args[0]).platform;
    case "check-archive:4":
      return checkArchive(readManifest(args[0]), args[1], args[2], args[3]).join(" ");
    default:
      if (command === "check-index" && args.length >= 3) {
        const [metadata, index, ...given] = args;
        const sources = given.map((entry) => {
          const at = entry.indexOf("=");
          ensure(at > 0, `${entry} is not <digest>=<file>`);
          return { digest: entry.slice(0, at), bytes: readFileSync(entry.slice(at + 1)) };
        });
        return checkIndex(JSON.parse(readFileSync(metadata, "utf8")), readFileSync(index), sources);
      }
      throw new Refused(
        "usage: release-manifest.mjs write <out> | digest <manifest> <image> <arch> | archive-digest <archive> | check-archive <manifest> <image> <arch> <archive> | check-index <metadata> <index> <digest>=<source>...",
      );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
