/**
 * Canonical OCI names (distribution-spec "Pulling manifests"). A repository or reference that does
 * not match is refused, never repaired: these values become URL path segments and `docker`
 * arguments, and anything the grammar does not admit (`..`, `%2e`, `?`, `#`, a scheme, a
 * backslash, whitespace, an empty segment) is a way to address something else.
 */

/** `<name>` : lowercase path components separated by `/`, each `[a-z0-9]+` joined by `.`, `_`, `__` or `-`s. */
const REPOSITORY_COMPONENT = "[a-z0-9]+(?:(?:\\.|_|__|-+)[a-z0-9]+)*";
const REPOSITORY = new RegExp(`^${REPOSITORY_COMPONENT}(?:/${REPOSITORY_COMPONENT})*$`);
const REPOSITORY_MAX_LENGTH = 255;

/** `<tag>`: at most 128 of `[A-Za-z0-9_.-]`, not starting with `.` or `-`. */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** `<digest>`: `algorithm:encoded`; the registered algorithms are checked for their exact length. */
const DIGEST = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[A-Za-z0-9=_-]+$/;
const DIGEST_MAX_LENGTH = 512;
const REGISTERED_DIGEST_LENGTHS: Readonly<Record<string, number>> = { sha256: 64, sha512: 128 };

export const isOciRepository = (value: string): boolean =>
  value.length <= REPOSITORY_MAX_LENGTH && REPOSITORY.test(value);

export const isOciTag = (value: string): boolean => TAG.test(value);

export const isOciDigest = (value: string): boolean => {
  if (value.length > DIGEST_MAX_LENGTH || !DIGEST.test(value)) return false;
  const separator = value.indexOf(":");
  const expected = REGISTERED_DIGEST_LENGTHS[value.slice(0, separator)];
  if (expected === undefined) return true;
  const encoded = value.slice(separator + 1);
  return encoded.length === expected && /^[a-f0-9]+$/.test(encoded);
};

/** A manifest reference is a tag or a digest. */
export const isOciReference = (value: string): boolean => isOciDigest(value) || isOciTag(value);

const trimEdges = (text: string): string => text.replace(/^[._-]+|[._-]+$/g, "");

/**
 * One path component of a repository name, made from arbitrary text (a Git repository's name, an
 * OS family). This is for names Sealant GENERATES; a name a caller supplies is refused, not
 * rewritten. A lone `.` or `_` between alphanumerics survives, every other run of characters the
 * grammar does not admit becomes one `-`, and the edges are trimmed again after the cut so a
 * separator can never end the component.
 */
export const toOciRepositoryComponent = (
  value: string,
  fallback: string,
  maxLength = 48,
): string => {
  const component = trimEdges(
    trimEdges(
      value.toLowerCase().replace(/[^a-z0-9]+/g, (run) => (run === "." || run === "_" ? run : "-")),
    ).slice(0, maxLength),
  );
  return component.length > 0 ? component : fallback;
};

export const OCI_REPOSITORY_MESSAGE =
  "must be an OCI repository name: lowercase path components of [a-z0-9] joined by '.', '_', '__' or '-', separated by '/'";
export const OCI_REFERENCE_MESSAGE =
  "must be an OCI tag ([A-Za-z0-9_][A-Za-z0-9._-]{0,127}) or a digest (algorithm:encoded)";
