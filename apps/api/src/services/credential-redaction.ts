/**
 * No credential the API receives or sends reaches what it observes: tracing spans, log lines or
 * error reports.
 *
 * Credentials travel where Effect's HTTP layer records them. Browser WebSocket and EventSource
 * clients cannot set headers, so the terminal attach, the output stream and the port forward take
 * their bearer as `?token=`. The request tracer records every request's URL (`url.full`,
 * `url.query`) and headers (`http.request.header.*`), and the HTTP client does the same for every
 * outgoing request. An HTTP error's message quotes its request's URL (`RequestParseError (GET
 * /v1/sessions/s/attach?token=…)`), and that message reaches a span's failure, the request log's
 * cause and every error reporter. The SSH gateway's `x-sealant-gateway-token` header is outside
 * Effect's default redacted names.
 *
 * `CredentialRedactionLive` wraps each observer the process installs, so whatever an exporter, a
 * logger or a reporter receives has been through `redactCredentialsInText`:
 *
 * - the tracer: every span's attributes and events as they are set, and the failure it ends with;
 * - the loggers: every message and cause;
 * - the error reporters: every cause;
 * - the redacted header names: Effect's defaults and every credential header.
 *
 * What they are given is data they may keep: an HTTP request or response inside an error becomes a
 * plain snapshot (method, redacted URL, redacted headers), never the live object; errors and plain
 * objects are copied field by field, a credential-named field (`x-sealant-gateway-token`,
 * `accessToken`) replaced outright; a repeated reference is redacted every time; what lies deeper
 * than the traversal follows becomes a placeholder; and a reason keeps its trace annotations. If
 * redaction itself fails, an observer gets a placeholder, never the original.
 *
 * The request itself, and the error the effect handles, are untouched: a route still reads
 * `?token=` to authenticate. Install an exporter's tracer, logger or reporter beneath this layer, so
 * its output passes through it.
 *
 * Not covered: a fiber's log annotations and log-span labels (a logger reads them from the fiber),
 * a span's name and links. No Core code puts a credential there; keep it that way.
 */
import { Cause, Context, Effect, ErrorReporter, Exit, Layer, Logger, Tracer } from "effect";
import {
  Headers,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
  UrlParams,
} from "effect/unstable/http";

const REDACTED = "REDACTED";

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

/** A name, delimited (`x-sealant-gateway-token`, `api_key`), that ends in a credential word. */
const DELIMITED_CREDENTIAL_NAME =
  /(?:^|[-_.\s])(?:token|secret|password|passwd|api[-_]?key|apikey|signature|credentials?|authorization|cookie)$/i;
/** A camel-case name (`gatewayToken`, `clientSecret`) that ends in a credential word. */
const CAMEL_CREDENTIAL_NAME =
  /[a-z0-9](?:Token|Secret|Password|Passwd|ApiKey|Signature|Credentials?|Authorization|Cookie)$/;

/**
 * Whether a header or field name holds a credential: `authorization`, `proxy-authorization`,
 * `cookie`, `set-cookie`, `x-api-key`, `x-sealant-gateway-token`, `accessToken`, `client_secret`. A
 * name that only mentions one (`x-token-usage`, `tokenCount`, `sessionId`) is not.
 */
export const isCredentialName = (name: string): boolean =>
  DELIMITED_CREDENTIAL_NAME.test(name) || CAMEL_CREDENTIAL_NAME.test(name);

const isCredentialParameter = (rawName: string): boolean => {
  let name = rawName;
  try {
    name = decodeURIComponent(rawName.replaceAll("+", " "));
  } catch {
    // A malformed escape: judge the name as written.
  }
  return CREDENTIAL_QUERY_PARAMETERS.has(name.toLowerCase());
};

/** A query string (no leading `?`) with every credential parameter's value replaced. */
export const redactQueryCredentials = (query: string): string =>
  query
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");
      if (equals === -1) return pair;
      const rawName = pair.slice(0, equals);
      return isCredentialParameter(rawName) ? `${rawName}=${REDACTED}` : pair;
    })
    .join("&");

/** A full URL with its query credentials and userinfo replaced; other text through the text rules. */
export const redactUrlCredentials = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return redactCredentialsInText(value);
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

const SCHEME_CHAR = /[a-z0-9+.-]/i;
const AUTHORITY_END = /[\s/?#]/;

/**
 * `scheme://user:password@host` with the userinfo replaced, in one pass: each `://` is found once,
 * its scheme read backwards and its authority forwards, so dotted or long text costs linear time.
 */
const redactUserinfo = (text: string): string => {
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const separator = text.indexOf("://", from);
    if (separator === -1) break;
    let schemeStart = separator;
    while (schemeStart > 0 && SCHEME_CHAR.test(text.charAt(schemeStart - 1))) schemeStart -= 1;
    const authorityStart = separator + 3;
    let at = -1;
    let end = authorityStart;
    while (end < text.length && !AUTHORITY_END.test(text.charAt(end))) {
      if (text.charAt(end) === "@") at = end;
      end += 1;
    }
    if (
      schemeStart < separator &&
      /^[a-z]/i.test(text.charAt(schemeStart)) &&
      at > authorityStart
    ) {
      out += `${text.slice(copied, authorityStart)}${REDACTED}:${REDACTED}`;
      copied = at;
    }
    from = Math.max(end, authorityStart);
  }
  return copied === 0 ? text : out + text.slice(copied);
};

const QUERY_PAIR = /([?&;])([^=&\s#?;]+)=([^&\s#;"'<>)]*)/g;
/** An `Authorization`-style credential, in any case, as the API's bearer parsing accepts it. */
const AUTH_SCHEME = /\b(bearer|basic)[ \t]+[^\s"',;)]+/gi;

/**
 * Free text (an error message, a stack, a log line) with every credential it can recognise
 * replaced: a URL's userinfo, a credential query parameter wherever a query appears, and a
 * `Bearer` or `Basic` credential in any case. Linear in the text's length.
 */
export const redactCredentialsInText = (text: string): string =>
  redactUserinfo(text)
    .replace(QUERY_PAIR, (pair: string, separator: string, name: string) =>
      isCredentialParameter(name) ? `${separator}${name}=${REDACTED}` : pair,
    )
    .replace(AUTH_SCHEME, (_match: string, scheme: string) => `${scheme} ${REDACTED}`);

/** How deep a value is followed; what lies deeper reads as this placeholder, never itself. */
const MAX_DEPTH = 6;
const TOO_DEEP = "[redacted: nested too deep]";

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const readField = (value: object, key: string): unknown => Reflect.get(value, key);

/** Headers as plain data, credential headers replaced. */
const headersSnapshot = (headers: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (typeof headers !== "object" || headers === null) return out;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    out[name] = isCredentialName(name) ? REDACTED : redactCredentialsInText(value);
  }
  return out;
};

/**
 * An HTTP request or response as plain data an observer may keep: method, URL (credentials
 * replaced) and headers (credential headers replaced), never the live object, whose URL, headers
 * and body still hold what the request carried.
 */
const httpSnapshot = (value: object): Record<string, unknown> | undefined => {
  if (HttpClientRequest.isHttpClientRequest(value)) {
    const query = UrlParams.toString(value.urlParams);
    return {
      method: value.method,
      url: redactUrlCredentials(query === "" ? value.url : `${value.url}?${query}`),
      headers: headersSnapshot(value.headers),
    };
  }
  if (HttpServerRequest.TypeId in value) {
    const url = readField(value, "url");
    return {
      method: readField(value, "method"),
      url: typeof url === "string" ? redactUrlCredentials(url) : undefined,
      headers: headersSnapshot(readField(value, "headers")),
    };
  }
  if (HttpClientResponse.TypeId in value || HttpServerResponse.isHttpServerResponse(value)) {
    const request = readField(value, "request");
    return {
      status: readField(value, "status"),
      headers: headersSnapshot(readField(value, "headers")),
      ...(typeof request === "object" && request !== null
        ? { request: httpSnapshot(request) }
        : {}),
    };
  }
  return undefined;
};

/**
 * Errors seen before, with their redacted copies: the same error always yields the same copy, so a
 * reporter that skips what it has already reported still recognises it.
 */
const redactedErrors = new WeakMap<object, unknown>();

interface Traversal {
  /** Values already redacted in this traversal: a repeated reference gets the same copy. */
  readonly done: Map<object, unknown>;
}

const redactInto = (value: unknown, traversal: Traversal, depth: number): unknown => {
  if (typeof value === "string") return redactCredentialsInText(value);
  if (typeof value !== "object" || value === null) return value;
  const known = traversal.done.get(value) ?? redactedErrors.get(value);
  if (known !== undefined) return known;
  if (depth > MAX_DEPTH) return TOO_DEEP;

  const snapshot = httpSnapshot(value);
  if (snapshot !== undefined) {
    traversal.done.set(value, snapshot);
    return snapshot;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    traversal.done.set(value, items);
    for (const item of value) items.push(redactInto(item, traversal, depth + 1));
    if (items.every((item, index) => item === value[index])) {
      traversal.done.set(value, value);
      return value;
    }
    return items;
  }
  if (isPlainObject(value) || value instanceof Error) return redactObject(value, traversal, depth);
  // Another class instance (a date, a map, a span, a stream): kept as it is.
  return value;
};

/**
 * A plain object or an error with every field redacted: a field whose name holds a credential is
 * replaced outright. An error stays an error with its prototype (its name, `_tag` and
 * `instanceof`); its message and stack are own values, which shadow a message the prototype
 * computes from the request it holds (as Effect's HTTP errors do). The original is never changed.
 */
const redactObject = (value: object, traversal: Traversal, depth: number): unknown => {
  const copy: Record<PropertyKey, unknown> = Object.create(Object.getPrototypeOf(value));
  traversal.done.set(value, copy);
  let changed = false;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) {
      Reflect.defineProperty(copy, key, descriptor);
      continue;
    }
    const field: unknown = descriptor.value;
    const redacted =
      typeof key === "string" && isCredentialName(key) && field !== undefined && field !== null
        ? REDACTED
        : redactInto(field, traversal, depth + 1);
    if (redacted !== field) changed = true;
    Reflect.defineProperty(copy, key, { ...descriptor, value: redacted });
  }
  if (value instanceof Error) {
    const message = redactCredentialsInText(value.message);
    const stack = value.stack === undefined ? undefined : redactCredentialsInText(value.stack);
    // A message the prototype computes (an HTTP error's) is read from the original, never kept.
    if (message !== value.message || !Object.hasOwn(value, "message")) changed = true;
    Reflect.defineProperty(copy, "message", { value: message, writable: true, configurable: true });
    if (stack !== undefined) {
      if (stack !== value.stack) changed = true;
      Reflect.defineProperty(copy, "stack", { value: stack, writable: true, configurable: true });
    }
  }
  if (!changed) {
    traversal.done.set(value, value);
    return value;
  }
  if (value instanceof Error) redactedErrors.set(value, copy);
  return copy;
};

/**
 * `value` with every credential redacted, as data an observer may keep: strings through
 * `redactCredentialsInText`, HTTP requests and responses as plain snapshots, errors and plain
 * objects copied field by field, credential-named fields replaced, what lies too deep replaced by a
 * placeholder. The same value when it held none of these.
 */
export const redactValue = (value: unknown): unknown => redactInto(value, { done: new Map() }, 0);

/** A reason's annotations (its trace and logical stack), each redacted as a value. */
const redactAnnotations = (annotations: ReadonlyMap<string, unknown>): Context.Context<never> =>
  Context.makeUnsafe(
    new Map([...annotations].map(([key, value]) => [key, redactValue(value)] as const)),
  );

const redactedCauses = new WeakMap<Cause.Cause<unknown>, Cause.Cause<unknown>>();

/**
 * `cause` with every failure and defect redacted, each reason keeping its (redacted) annotations,
 * so the trace and logical stack an observer prints stay. The same cause when it held no
 * credential, and the same copy each time it is redacted again.
 */
export const redactCause = <E>(cause: Cause.Cause<E>): Cause.Cause<unknown> => {
  const known = redactedCauses.get(cause);
  if (known !== undefined) return known;
  let changed = false;
  const reasons = cause.reasons.map((reason): Cause.Reason<unknown> => {
    if (Cause.isFailReason(reason)) {
      const error = redactValue(reason.error);
      if (error === reason.error) return reason;
      changed = true;
      return Cause.makeFailReason(error).annotate(redactAnnotations(reason.annotations));
    }
    if (Cause.isDieReason(reason)) {
      const defect = redactValue(reason.defect);
      if (defect === reason.defect) return reason;
      changed = true;
      return Cause.makeDieReason(defect).annotate(redactAnnotations(reason.annotations));
    }
    return reason;
  });
  const redacted = changed ? Cause.fromReasons(reasons) : cause;
  redactedCauses.set(cause, redacted);
  return redacted;
};

const REDACTION_FAILED = "[redacted: the redaction itself failed]";

/**
 * `redact(value)`, or a placeholder when redaction throws: an observer then gets the placeholder,
 * never the unredacted value, and the observed effect is never failed by its observer.
 */
const safely =
  <A, B>(redact: (value: A) => B, fallback: B) =>
  (value: A): B => {
    try {
      return redact(value);
    } catch {
      return fallback;
    }
  };

const observedValue = safely(redactValue, REDACTION_FAILED);
const observedCause = safely(
  (cause: Cause.Cause<unknown>) => redactCause(cause),
  Cause.die(REDACTION_FAILED),
);
const observedText = safely(redactCredentialsInText, REDACTION_FAILED);

const HEADER_ATTRIBUTE = /^http\.(?:request|response)\.header\.(.+)$/;
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["url.full", "http.url"]);

const redactAttribute = (key: string, value: unknown): unknown => {
  const header = HEADER_ATTRIBUTE.exec(key);
  if (header?.[1] !== undefined && isCredentialName(header[1])) return REDACTED;
  if (typeof value === "string") {
    if (URL_ATTRIBUTES.has(key)) return safely(redactUrlCredentials, REDACTION_FAILED)(value);
    if (key === "url.query") return safely(redactQueryCredentials, REDACTION_FAILED)(value);
  }
  return observedValue(value);
};

const redactAttributes = (
  attributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined =>
  attributes === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(attributes).map(([key, value]) => [key, redactAttribute(key, value)]),
      );

/** `tracer`, with every span's attributes, events and ending failure redacted. */
export const redactingTracer = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    ...tracer,
    span: (options) => {
      const span = tracer.span(options);
      const attribute = span.attribute.bind(span);
      const event = span.event.bind(span);
      const end = span.end.bind(span);
      span.attribute = (key, value) => attribute(key, redactAttribute(key, value));
      span.event = (name, startTime, attributes) =>
        event(observedText(name), startTime, redactAttributes(attributes));
      span.end = (endTime, exit) =>
        end(endTime, Exit.isFailure(exit) ? Exit.failCause(observedCause(exit.cause)) : exit);
      return span;
    },
  });

/** `logger`, given every message and cause redacted. */
export const redactingLogger = <Output>(
  logger: Logger.Logger<unknown, Output>,
): Logger.Logger<unknown, Output> =>
  Logger.make((options) =>
    logger.log({
      ...options,
      message: observedValue(options.message),
      cause: observedCause(options.cause),
    }),
  );

/**
 * `reporter`, given each report's cause redacted: one report in, one report out, and the same
 * error redacts to the same copy each time, so the reporter's own skipping of what it has already
 * reported still holds.
 */
export const redactingReporter = (
  reporter: ErrorReporter.ErrorReporter,
): ErrorReporter.ErrorReporter => ({
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: (options) => reporter.report({ ...options, cause: observedCause(options.cause) }),
});

/** Every observer in place, wrapped as the module comment says. */
export const CredentialRedactionLive: Layer.Layer<never> = Layer.mergeAll(
  Layer.effect(Tracer.Tracer, Effect.map(Effect.tracer, redactingTracer)),
  Layer.effect(
    Logger.CurrentLoggers,
    Effect.map(
      Effect.service(Logger.CurrentLoggers),
      (loggers) => new Set([...loggers].map(redactingLogger)),
    ),
  ),
  Layer.effect(
    ErrorReporter.CurrentErrorReporters,
    Effect.map(
      Effect.service(ErrorReporter.CurrentErrorReporters),
      (reporters) => new Set([...reporters].map(redactingReporter)),
    ),
  ),
  Layer.effect(
    Headers.CurrentRedactedNames,
    Effect.map(Effect.service(Headers.CurrentRedactedNames), (names) => [
      ...names,
      DELIMITED_CREDENTIAL_NAME,
      CAMEL_CREDENTIAL_NAME,
    ]),
  ),
);
