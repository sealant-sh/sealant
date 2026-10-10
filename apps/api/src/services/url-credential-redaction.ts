/**
 * Credentials in URLs never reach a tracing span.
 *
 * Browser WebSocket and EventSource clients cannot set headers, so the terminal attach, the output
 * stream and the port forward take their bearer as `?token=`. Effect's HTTP tracer records every
 * request's URL on its span (`url.full`, `url.query`), and its HTTP client does the same for every
 * outgoing request, so a span exporter would receive a reusable credential. This tracer wraps the
 * one in place and rewrites those attributes with each credential query parameter's value replaced
 * by `REDACTED` (and any `user:password@` with `REDACTED:REDACTED@`). The request log already
 * records the path without its query.
 *
 * Wrap whatever tracer the process installs: an exporter's tracer composed later must be provided
 * beneath this layer, so its spans pass through the redaction.
 */
import { Effect, Layer, Tracer } from "effect";

/** Query parameter names whose values are credentials, compared without case. */
export const CREDENTIAL_QUERY_PARAMETERS: ReadonlySet<string> = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "ticket",
  "code",
  "key",
  "api_key",
  "apikey",
  "secret",
  "client_secret",
  "password",
  "sig",
  "signature",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
]);

const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["url.full", "url.query", "http.url"]);

const REDACTED = "REDACTED";

const isCredential = (name: string): boolean => CREDENTIAL_QUERY_PARAMETERS.has(name.toLowerCase());

/** A query string (no leading `?`) with every credential parameter's value replaced. */
export const redactQueryCredentials = (query: string): string =>
  query
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");
      const rawName = equals === -1 ? pair : pair.slice(0, equals);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replaceAll("+", " "));
      } catch {
        // A malformed escape: judge the name as written.
      }
      return equals !== -1 && isCredential(name) ? `${rawName}=${REDACTED}` : pair;
    })
    .join("&");

/** A full URL with its query credentials and userinfo replaced; anything else as it is. */
export const redactUrlCredentials = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.username !== "" || url.password !== "") {
    url.username = REDACTED;
    url.password = REDACTED;
  }
  if (url.search !== "") {
    url.search = `?${redactQueryCredentials(url.search.slice(1))}`;
  }
  return url.toString();
};

const redactAttribute = (key: string, value: unknown): unknown => {
  if (typeof value !== "string" || !URL_ATTRIBUTES.has(key)) return value;
  return key === "url.query" ? redactQueryCredentials(value) : redactUrlCredentials(value);
};

/** `tracer`, with every span's URL attributes redacted as they are set. */
export const redactingUrlCredentials = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    ...tracer,
    span: (options) => {
      const span = tracer.span(options);
      const attribute = span.attribute.bind(span);
      span.attribute = (key, value) => attribute(key, redactAttribute(key, value));
      return span;
    },
  });

/** The process's tracer, wrapped by `redactingUrlCredentials`. */
export const UrlCredentialRedactionLive: Layer.Layer<never> = Layer.effect(
  Tracer.Tracer,
  Effect.map(Effect.tracer, redactingUrlCredentials),
);
