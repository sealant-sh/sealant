/**
 * Registry mirrors for every workspace's Docker service (`SEALANT_DOCKER_REGISTRY_MIRRORS`): the
 * daemon asks each mirror first for a Docker Hub image and falls back to Docker Hub itself when a
 * mirror fails, so a mirror that is down costs one failed request per pull and never fails it.
 * Docker applies mirrors to Docker Hub only (`docker.io`); every other registry is reached
 * directly.
 *
 * A mirror is an origin: `http://` or `https://`, a host and an optional port, no credentials,
 * path, query or fragment. Upstream credentials belong to the mirror, never to the workspace. A
 * plain-http mirror is also named an insecure registry: `docker pull` honours the scheme of a
 * mirror, but BuildKit (`docker build`) reaches every mirror over https unless it is listed there.
 */

const VARIABLE = "SEALANT_DOCKER_REGISTRY_MIRRORS";

/** A hostname or IPv4 literal Docker accepts in `--registry-mirror` and `--insecure-registry`. */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

const parseMirror = (entry: string): string => {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new Error(`${VARIABLE} has an entry that is not a URL: ${JSON.stringify(entry)}.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !HOST_PATTERN.test(url.hostname)
  ) {
    throw new Error(
      `${VARIABLE} entries must be http:// or https:// origins with a host name and no credentials, path, query or fragment: ${JSON.stringify(entry)}.`,
    );
  }
  return url.origin;
};

/** The comma-separated mirror list, as origins, in order and without duplicates. */
export const parseDockerRegistryMirrors = (raw: string): readonly string[] => {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error(`${VARIABLE} is set but names no mirror.`);
  }
  return [...new Set(entries.map(parseMirror))];
};

/** The dockerd flags for the mirrors: each mirror, and each plain-http one as insecure too. */
export const dockerdRegistryMirrorArgs = (mirrors: readonly string[]): readonly string[] =>
  mirrors.flatMap((mirror) => {
    const url = new URL(mirror);
    return [
      `--registry-mirror=${url.origin}`,
      ...(url.protocol === "http:" ? [`--insecure-registry=${url.host}`] : []),
    ];
  });

/** The host names the mirrors are reached by, for a mirror container's network aliases. */
export const registryMirrorHostNames = (mirrors: readonly string[]): readonly string[] => [
  ...new Set(mirrors.map((mirror) => new URL(mirror).hostname)),
];
