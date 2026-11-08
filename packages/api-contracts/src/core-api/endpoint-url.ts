/**
 * The base URL of a compatible endpoint an API-key login sends its requests to, such as a company
 * gateway: Anthropic-compatible for a Claude login, OpenAI-compatible for a Codex login.
 */
import { Schema, SchemaGetter } from "effect";

const parsed = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/** Why `value` is not an endpoint URL, or `undefined` when it is one. */
const endpointUrlProblem = (value: string): string | undefined => {
  const url = parsed(value);
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return "must be an absolute http: or https: URL";
  }
  if (url.hostname === "") return "must name a host";
  if (url.username !== "" || url.password !== "") {
    return "must not carry a user name or password; the key is sent on its own";
  }
  if (url.search !== "" || value.includes("?")) return "must not have a query string";
  if (url.hash !== "" || value.includes("#")) return "must not have a fragment";
  return undefined;
};

/** Scheme, host (with a port that is not the scheme's default) and path, without a trailing slash. */
const canonicalEndpointUrl = (value: string): string => {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
};

/**
 * An absolute `http:` or `https:` URL with a host, and no user name, password, query string or
 * fragment. Decoding normalizes it: the host as the URL standard writes it, and the path without a
 * trailing slash. `http:` is allowed, since an endpoint on a private network often has no TLS.
 */
export const EndpointUrl = Schema.String.check(Schema.makeFilter(endpointUrlProblem)).pipe(
  Schema.decode({
    decode: SchemaGetter.transform(canonicalEndpointUrl),
    encode: SchemaGetter.passthrough(),
  }),
  Schema.brand("EndpointUrl"),
);
export type EndpointUrl = typeof EndpointUrl.Type;

/** The endpoint's host, with its port when that is not the scheme's default. */
export const endpointHostOf = (url: EndpointUrl): string => new URL(url).host;

const decodeEndpointUrl = Schema.decodeSync(EndpointUrl);

/** A pasted endpoint as an {@link EndpointUrl}, or the reason it is not one, for a person to read. */
export const parseEndpointUrl = (
  raw: string,
):
  | { readonly valid: true; readonly url: EndpointUrl }
  | { readonly valid: false; readonly reason: string } => {
  const problem = endpointUrlProblem(raw);
  return problem === undefined
    ? { valid: true, url: decodeEndpointUrl(raw) }
    : { valid: false, reason: `The endpoint ${problem}.` };
};
