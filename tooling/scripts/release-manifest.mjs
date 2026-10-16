#!/usr/bin/env node
/**
 * The release manifest: what one stable release run (.github/workflows/release.yml) built, by
 * digest. Every job after the build reads it from its own run's `release-manifest` artifact, never
 * from a tag, which another writer can move.
 *
 *   write <out>                    from the run's digests-* and index-* records (env below)
 *   digest <manifest> <image> <arch>
 *                                  prints that image's platform digest for that arch
 *   check-index <metadata> <index> <digest>=<source>...
 *                                  refuses the index `imagetools create --metadata-file` reported
 *                                  unless <index> (its raw JSON, read by that digest) holds exactly
 *                                  the given sources' manifests for linux/amd64 and linux/arm64;
 *                                  prints its digest
 *
 * `write` reads VERSION, COMMIT, DIGESTS (a directory of digests-<image>--<arch>/<hex>, as
 * download-artifact lays them out) and INDEXES (index-<image>/digest).
 *
 * The rules are sealant-sh/mend's scripts/release-manifest.mjs; the images are Core's.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGES = ["sealant-api", "sealant-worker", "sealant-ssh-gateway", "sealant-web"];
export const ARCHES = ["amd64", "arm64"];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PLAIN_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
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
    PLAIN_VERSION.test(manifest?.version ?? "") && /^[0-9a-f]{40}$/.test(manifest.commit ?? ""),
    "The release manifest needs a plain X.Y.Z version and a 40-hex commit",
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
  return manifest;
}

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
export function buildManifest({ version, commit, digests, indexes }) {
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
  return validateManifest({ version, commit, images });
}

const sha256 = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;

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
      });
      writeFileSync(args[0], `${JSON.stringify(manifest, null, 2)}\n`);
      return JSON.stringify(manifest);
    }
    case "digest:3": {
      const [file, image, arch] = args;
      ensure(IMAGES.includes(image) && ARCHES.includes(arch), `No ${image} for ${arch}`);
      return readManifest(file).images[image].platforms[arch];
    }
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
        "usage: release-manifest.mjs write <out> | digest <manifest> <image> <arch> | check-index <metadata> <index> <digest>=<source>...",
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
