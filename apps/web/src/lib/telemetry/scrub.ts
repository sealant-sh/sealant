/**
 * Strips what must never leave the browser for Sentry from an event, a breadcrumb or a span before
 * the SDK sends it: query strings and fragments (a reset-password link carries its token in one, a
 * tRPC GET carries its input in one), cookies, request bodies, headers outside an allowlist, and
 * anything in free text shaped like a credential.
 *
 * It walks every string in the payload rather than a list of known fields, so a field the SDK adds
 * in a later version is scrubbed too. Trace and span ids are hex and never match a pattern here.
 */

export const REDACTED = "[redacted]";

/** Keys dropped wherever they appear: each one only ever holds a query, a fragment or cookies. */
const DROPPED_KEYS = new Set([
  "cookies",
  "query_string",
  "url.query",
  "url.fragment",
  "http.query",
  "http.fragment",
]);

/** The only request headers kept on an event. */
const ALLOWED_REQUEST_HEADERS = new Set(["user-agent"]);

/** A key whose value is a credential, in `key=value`, `key: value` or `"key": "value"` form. */
const CREDENTIAL_KEY =
  "(?:[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|auth|cookie|credential|private[_-]?key|signature)[A-Za-z0-9_.-]*)";

const NAMED_VALUE = new RegExp(
  // A `Bearer` or `Basic` value is left to AUTH_SCHEME, which keeps the scheme and redacts what follows.
  `(["']?)(${CREDENTIAL_KEY})\\1(\\s*[=:]\\s*)(["']?)(?!(?:bearer|basic)\\s)([^\\s"'&,;}\\]<>]+)\\4`,
  "gi",
);

const AUTH_SCHEME = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/** Provider keys and tokens by their shape: Anthropic, OpenAI, GitHub, Slack and JWTs. */
const TOKEN_SHAPES = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
];

/** An absolute URL's userinfo, query and fragment. */
const ABSOLUTE_URL =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#"'<>@]*@)?([^\s?#"'<>]*)([?#][^\s"'<>]*)?/gi;

/** A string that is itself a path, such as a breadcrumb's `from` or `to`. */
const PATH_WITH_QUERY = /^(\/[^\s?#]*)[?#]\S*$/;

/** Drops a URL's query and fragment, and any userinfo, keeping the scheme, host and path. */
const stripUrls = (text: string): string => {
  const path = PATH_WITH_QUERY.exec(text);
  if (path !== null) return path[1] ?? text;
  return text.replace(
    ABSOLUTE_URL,
    (_match, scheme: string, _userinfo: string | undefined, rest: string) => `${scheme}${rest}`,
  );
};

/** Free text with every URL's query and fragment removed and every recognisable credential redacted. */
export const scrubText = (text: string): string => {
  let result = stripUrls(text)
    .replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(
      NAMED_VALUE,
      (_match, keyQuote: string, key: string, separator: string, valueQuote: string) =>
        `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`,
    );
  for (const shape of TOKEN_SHAPES) result = result.replace(shape, REDACTED);
  return result;
};

const MAX_DEPTH = 12;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Scrubs every string under `container`, in place, dropping the keys in DROPPED_KEYS. */
const scrubInPlace = (container: Record<string, unknown>, depth: number): void => {
  for (const key of Object.keys(container)) {
    if (DROPPED_KEYS.has(key)) {
      delete container[key];
      continue;
    }
    const entry = container[key];
    if (typeof entry === "string") container[key] = scrubText(entry);
    else if (isRecord(entry)) {
      if (depth >= MAX_DEPTH) container[key] = REDACTED;
      else scrubInPlace(entry, depth + 1);
    }
  }
};

/** A request keeps its URL and allowlisted headers: no body, no cookies, no query, no env. */
const scrubRequest = (request: Record<string, unknown>): void => {
  for (const key of ["data", "cookies", "query_string", "env"]) delete request[key];
  const headers = request.headers;
  if (!isRecord(headers)) return;
  for (const name of Object.keys(headers)) {
    if (!ALLOWED_REQUEST_HEADERS.has(name.toLowerCase())) delete headers[name];
  }
};

/**
 * Scrubs a Sentry payload (an error or transaction event, a breadcrumb) in place, as Sentry's
 * `beforeSend` hooks may, and returns it: every string scrubbed, and the request, if any, cut down
 * to its URL path and allowlisted headers.
 */
export const scrubPayload = <T extends object>(payload: T): T => {
  if (!isRecord(payload)) return payload;
  if (isRecord(payload.request)) scrubRequest(payload.request);
  scrubInPlace(payload, 0);
  return payload;
};
