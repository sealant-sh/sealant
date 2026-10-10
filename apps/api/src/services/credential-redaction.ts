/**
 * No credential the API receives or sends reaches what it observes: tracing spans, log lines or
 * error reports.
 *
 * Credentials travel where Effect's HTTP layer records them. Browser WebSocket and EventSource
 * clients cannot set headers, so the terminal attach, the output stream and the port forward take
 * their bearer as `?token=`. The request tracer records every request's URL (`url.full`,
 * `url.query`) and headers (`http.request.header.*`), and the HTTP client does the same for every
 * outgoing request. An HTTP error quotes its request's URL in its message and holds the live request
 * (`reason.request`), whose URL and headers carry the credential. The SSH gateway's
 * `x-sealant-gateway-token` header is outside Effect's default redacted names.
 *
 * Deny by default. `CredentialRedactionLive` wraps each observer the process installs (the tracer,
 * the loggers, the error reporters) so that what an observer receives is only plain data, built
 * fresh at the moment of observation, never a live reference:
 *
 * - a string, through `redactCredentialsInText`; other primitives as they are;
 * - an array or a plain object, copied, each item and field observed in turn, a field whose name
 *   holds a credential (`authorization`, `x-sealant-gateway-token`, `accessToken`) replaced, an
 *   accessor never called;
 * - an error, as its plain form: name, `_tag`, message, stack and fields observed, and its reporting
 *   flags (`ErrorReporter.ignore`, `severity`, `attributes`);
 * - a URL, URL parameters, headers, a map, a set, a date, an HTTP request or response: as plain,
 *   redacted data;
 * - anything else (another class instance, a function): its label only.
 *
 * A cause is rebuilt the same way, every reason and its annotations observed (an Effect stack frame
 * as a fresh frame with redacted text, so the logical trace still prints). The program itself is
 * untouched: the request a route authenticates with, and the error an effect handles, keep their
 * class and values. Install an exporter's tracer, logger or reporter beneath this layer, so its
 * output passes through it.
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

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

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

const decodedName = (raw: string): string => {
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    // A malformed escape: judge the name as written.
    return raw;
  }
};

const isCredentialParameter = (rawName: string): boolean =>
  CREDENTIAL_QUERY_PARAMETERS.has(decodedName(rawName).toLowerCase());

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// Text: every rule a single forward scan, so any input costs linear time.
// ---------------------------------------------------------------------------------------------

const startsWithAt = (text: string, index: number, literal: string): boolean =>
  text.length - index >= literal.length &&
  text.slice(index, index + literal.length).toLowerCase() === literal;

const isSchemeChar = (char: string): boolean => /[a-z0-9+.-]/i.test(char);

/** The scheme separator at `index` (`://`, a slash-escaped `:\/\/`, an encoded `%3A%2F%2F`). */
const SCHEME_SEPARATORS = ["://", ":\\/\\/", "%3a%2f%2f"] as const;
/** Where an authority ends: a path, a query, a fragment, a quote, a space, encoded or escaped. */
const AUTHORITY_ENDS = ["%2f", "%3f", "%23", "\\/"] as const;
/** What ends userinfo: `@`, or `%40` encoded. */
const USERINFO_ENDS = ["@", "%40"] as const;

const literalAt = (text: string, index: number, literals: readonly string[]): number => {
  for (const literal of literals) if (startsWithAt(text, index, literal)) return literal.length;
  return 0;
};

/**
 * `scheme://user:password@host` with the userinfo replaced, whether the URL is written plainly,
 * with escaped slashes (`https:\/\/u:p@h`, as some serializers write it) or percent-encoded inside
 * another value (`https%3A%2F%2Fu%3Ap%40h`).
 */
const redactUserinfo = (text: string): string => {
  let out = "";
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const separator = char === ":" || char === "%" ? literalAt(text, index, SCHEME_SEPARATORS) : 0;
    if (separator === 0) {
      index += 1;
      continue;
    }
    const hasScheme = index > 0 && isSchemeChar(text.charAt(index - 1));
    const authorityStart = index + separator;
    let end = authorityStart;
    let userinfoEnd = -1;
    while (end < text.length) {
      const at = text.charAt(end);
      if (/[\s/?#"'<>]/.test(at)) break;
      if ((at === "%" || at === "\\") && literalAt(text, end, AUTHORITY_ENDS) > 0) break;
      if (at === "@" || (at === "%" && literalAt(text, end, USERINFO_ENDS) > 0)) userinfoEnd = end;
      end += 1;
    }
    if (hasScheme && userinfoEnd > authorityStart) {
      out += `${text.slice(copied, authorityStart)}${REDACTED}:${REDACTED}`;
      copied = userinfoEnd;
    }
    index = Math.max(end, authorityStart);
  }
  return copied === 0 ? text : out + text.slice(copied);
};

const QUERY_PAIR = /([?&;])([^=&\s#?;]+)=([^&\s#;"'<>)\\]*)/g;

/**
 * An `Authorization`-style credential in any case, bare or quoted, plain or JSON-escaped:
 * `Bearer x`, `bearer "x"`, `\"Bearer \\\"x\\\"\"`. A quoted credential runs to its closing quote.
 */
const AUTH_SCHEME =
  /\b(bearer|basic)[ \t]+(?:\\*"(?:[^"\\]|\\(?![\\"])){0,1024}\\*"|'[^']{0,1024}'|[^\s"',;)\\]+)/gi;

/**
 * Where a quoted value opened with `escapes` backslashes before `quote` ends: after the first
 * `quote` preceded by exactly that many backslashes (so `"a \"b\" c"` and its JSON-escaped form
 * close at their own quote, not an escaped one inside). The end of the text when it never closes.
 */
const closingQuote = (text: string, from: number, quote: string, escapes: number): number => {
  let index = from;
  while (index < text.length) {
    const char = text.charAt(index);
    if (escapes === 0 && char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      let backslashes = 0;
      while (backslashes <= escapes && text.charAt(index - 1 - backslashes) === "\\")
        backslashes += 1;
      if (backslashes === escapes) return index + 1;
    }
    index += 1;
  }
  return text.length;
};

const KEY_CHAR = /[A-Za-z0-9_.-]/;
const MAX_KEY = 64;

/**
 * Each `name: value` or `name=value` whose name holds a credential (as JSON, an inspected object, a
 * header line or a query writes it) with its value replaced: a quoted value to its closing quote, an
 * escaped one to its escaped quote, a bare one to the next delimiter, and a bare `Bearer`/`Basic`
 * value with the credential after it. Names are read backwards from each `:` or `=`, at most 64
 * characters, so the scan stays linear.
 */
const redactNamedValues = (text: string): string => {
  let out = "";
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char !== ":" && char !== "=") {
      index += 1;
      continue;
    }
    // The name before it: a closing quote (maybe escaped), then the name's characters.
    let nameEnd = index;
    while (nameEnd > 0 && /[\s]/.test(text.charAt(nameEnd - 1)) && index - nameEnd < 4)
      nameEnd -= 1;
    while (nameEnd > 0 && /["'\\]/.test(text.charAt(nameEnd - 1)) && index - nameEnd < 8) {
      nameEnd -= 1;
    }
    let nameStart = nameEnd;
    while (
      nameStart > 0 &&
      nameEnd - nameStart < MAX_KEY &&
      KEY_CHAR.test(text.charAt(nameStart - 1))
    ) {
      nameStart -= 1;
    }
    const name = text.slice(nameStart, nameEnd);
    if (name === "" || !isCredentialName(decodedName(name))) {
      index += 1;
      continue;
    }
    // The value after it.
    let valueStart = index + 1;
    while (valueStart < text.length && /[ \t]/.test(text.charAt(valueStart))) valueStart += 1;
    let escapes = 0;
    while (text.charAt(valueStart + escapes) === "\\") escapes += 1;
    const quote = text.charAt(valueStart + escapes);
    let valueEnd: number;
    if (quote === '"' || quote === "'") {
      valueEnd = closingQuote(text, valueStart + escapes + 1, quote, escapes);
    } else {
      valueEnd = valueStart;
      while (valueEnd < text.length && !/[\s,;&}\])"'<>\\]/.test(text.charAt(valueEnd))) {
        valueEnd += 1;
      }
      // `Authorization: Bearer x`: the scheme alone is not the credential.
      if (/^(?:bearer|basic)$/i.test(text.slice(valueStart, valueEnd))) {
        let next = valueEnd;
        while (next < text.length && /[ \t]/.test(text.charAt(next))) next += 1;
        while (next < text.length && !/[\s,;&}\])"'<>\\]/.test(text.charAt(next))) next += 1;
        valueEnd = next;
      }
    }
    if (valueEnd > valueStart) {
      out += `${text.slice(copied, valueStart)}${REDACTED}`;
      copied = valueEnd;
    }
    index = Math.max(valueEnd, index + 1);
  }
  return copied === 0 ? text : out + text.slice(copied);
};

/**
 * Free text (an error message, a stack, a log line, an inspected value) with every credential it
 * can recognise replaced: a URL's userinfo (plain, slash-escaped or percent-encoded), a credential
 * query parameter, a `Bearer` or `Basic` credential (any case, quoted or escaped), and the value of
 * any field or header named for a credential. Linear in the text's length.
 */
export const redactCredentialsInText = (text: string): string =>
  redactNamedValues(
    redactUserinfo(text)
      .replace(QUERY_PAIR, (pair: string, separator: string, name: string) =>
        isCredentialParameter(name) ? `${separator}${name}=${REDACTED}` : pair,
      )
      .replace(AUTH_SCHEME, (_match: string, scheme: string) => `${scheme} ${REDACTED}`),
  );

// ---------------------------------------------------------------------------------------------
// Values: deny by default
// ---------------------------------------------------------------------------------------------

/** How deep a value is followed; what lies deeper reads as this placeholder, never itself. */
const MAX_DEPTH = 6;
const TOO_DEEP = "[redacted: nested too deep]";
const CIRCULAR = "[redacted: circular]";

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isPlainArray = (value: object): value is readonly unknown[] =>
  Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;

const labelOf = (value: object): string => {
  const constructor: unknown = Reflect.get(value, "constructor");
  const name =
    typeof constructor === "function" && typeof constructor.name === "string"
      ? constructor.name
      : "";
  return `[${name === "" ? "object" : name}]`;
};

/** A data property's value along the prototype chain; never an accessor's. */
const dataProperty = (value: object, key: string): unknown => {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined;
    current = Reflect.getPrototypeOf(current);
  }
  return undefined;
};

const headersOf = (entries: Iterable<readonly [string, unknown]>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (typeof value !== "string") continue;
    out[name] = isCredentialName(name) ? REDACTED : redactCredentialsInText(value);
  }
  return out;
};

const readString = (value: object, key: string): string | undefined => {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
};

/** A value the allowlist knows how to give as plain, redacted data, or `undefined`. */
const knownForm = (value: object): unknown => {
  if (value instanceof URL) return redactUrlCredentials(value.href);
  if (value instanceof URLSearchParams) return redactQueryCredentials(value.toString());
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (typeof globalThis.Headers === "function" && value instanceof globalThis.Headers) {
    return headersOf(value.entries());
  }
  if (typeof globalThis.Request === "function" && value instanceof globalThis.Request) {
    return { method: value.method, url: redactUrlCredentials(value.url) };
  }
  if (HttpClientRequest.isHttpClientRequest(value)) {
    const query = UrlParams.toString(value.urlParams);
    return {
      method: value.method,
      url: redactUrlCredentials(query === "" ? value.url : `${value.url}?${query}`),
      headers: headersOf(Object.entries(value.headers)),
    };
  }
  if (HttpServerRequest.TypeId in value) {
    const url = readString(value, "url");
    const headers: unknown = Reflect.get(value, "headers");
    return {
      method: readString(value, "method"),
      url: url === undefined ? undefined : redactUrlCredentials(url),
      headers:
        typeof headers === "object" && headers !== null ? headersOf(Object.entries(headers)) : {},
    };
  }
  if (HttpClientResponse.TypeId in value || HttpServerResponse.isHttpServerResponse(value)) {
    const headers: unknown = Reflect.get(value, "headers");
    return {
      status: Reflect.get(value, "status"),
      headers:
        typeof headers === "object" && headers !== null ? headersOf(Object.entries(headers)) : {},
    };
  }
  return undefined;
};

interface Walk {
  /** The objects on the path from the root to here: a cycle reads as a placeholder. */
  readonly path: Set<object>;
}

const observeInto = (value: unknown, walk: Walk, depth: number): unknown => {
  switch (typeof value) {
    case "string":
      return redactCredentialsInText(value);
    case "number":
    case "boolean":
    case "undefined":
      return value;
    case "bigint":
      return value.toString();
    case "symbol":
      return value.toString();
    case "function":
      return "[function]";
    default:
      break;
  }
  if (value === null) return null;
  if (typeof value !== "object") return String(value);
  if (walk.path.has(value)) return CIRCULAR;
  if (depth > MAX_DEPTH) return TOO_DEEP;
  walk.path.add(value);
  try {
    return observeObject(value, walk, depth);
  } finally {
    walk.path.delete(value);
  }
};

const observeFields = (
  value: object,
  walk: Walk,
  depth: number,
  skip: ReadonlySet<string> = new Set(),
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (skip.has(key)) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) {
      out[key] = "[accessor]";
      continue;
    }
    const field: unknown = descriptor.value;
    out[key] =
      isCredentialName(key) && field !== undefined && field !== null
        ? REDACTED
        : observeInto(field, walk, depth + 1);
  }
  return out;
};

const ERROR_OWN = new Set(["message", "stack", "cause", "name"]);

/** An error as plain data: what observers print and report, and the flags reporters read. */
const errorForm = (error: Error, walk: Walk, depth: number): Record<string, unknown> => {
  const name = dataProperty(error, "name");
  const tag = dataProperty(error, "_tag");
  // `message` may be a getter (Effect's HTTP errors compute it from the request): read once, here,
  // and kept only redacted.
  const message = typeof error.message === "string" ? redactCredentialsInText(error.message) : "";
  const stack = typeof error.stack === "string" ? redactCredentialsInText(error.stack) : undefined;
  const cause = dataProperty(error, "cause");
  const ignore = dataProperty(error, ErrorReporter.ignore);
  const severity = dataProperty(error, ErrorReporter.severity);
  const attributes = dataProperty(error, ErrorReporter.attributes);
  return {
    ...observeFields(error, walk, depth, ERROR_OWN),
    name: typeof name === "string" ? name : "Error",
    ...(typeof tag === "string" ? { _tag: tag } : {}),
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(cause === undefined ? {} : { cause: observeInto(cause, walk, depth + 1) }),
    ...(ignore === true ? { [ErrorReporter.ignore]: true } : {}),
    ...(typeof severity === "string" ? { [ErrorReporter.severity]: severity } : {}),
    ...(typeof attributes === "object" && attributes !== null
      ? { [ErrorReporter.attributes]: observeInto(attributes, walk, depth + 1) }
      : {}),
  };
};

const observeObject = (value: object, walk: Walk, depth: number): unknown => {
  if (isPlainArray(value)) return value.map((item) => observeInto(item, walk, depth + 1));
  if (isPlainObject(value)) return observeFields(value, walk, depth);
  if (value instanceof Error) return errorForm(value, walk, depth);
  const known = knownForm(value);
  if (known !== undefined) return known;
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value) {
      const name = typeof key === "string" ? key : String(observeInto(key, walk, depth + 1));
      out[name] =
        typeof key === "string" && isCredentialName(key)
          ? REDACTED
          : observeInto(item, walk, depth + 1);
    }
    return out;
  }
  if (value instanceof Set) return [...value].map((item) => observeInto(item, walk, depth + 1));
  if (ArrayBuffer.isView(value))
    return `[${labelOf(value).slice(1, -1)} ${value.byteLength} bytes]`;
  return labelOf(value);
};

/**
 * What an observer may receive for `value`: plain data built fresh now, credentials redacted, never
 * a live reference (see the module comment).
 */
export const observe = (value: unknown): unknown => observeInto(value, { path: new Set() }, 0);

// ---------------------------------------------------------------------------------------------
// Causes
// ---------------------------------------------------------------------------------------------

interface StackFrame {
  readonly name: string;
  readonly stack: () => string | undefined;
  readonly parent: StackFrame | undefined;
}

const isStackFrame = (value: unknown): value is StackFrame =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "name") === "string" &&
  typeof Reflect.get(value, "stack") === "function";

/** An Effect stack frame chain as fresh frames with redacted text, read now (at most ten deep). */
const observeFrame = (frame: StackFrame, depth = 0): StackFrame | undefined => {
  if (depth >= 10) return undefined;
  let text: string | undefined;
  try {
    const stack = frame.stack();
    text = stack === undefined ? undefined : redactCredentialsInText(stack);
  } catch {
    text = undefined;
  }
  const parent = isStackFrame(frame.parent) ? observeFrame(frame.parent, depth + 1) : undefined;
  return { name: redactCredentialsInText(frame.name), stack: () => text, parent };
};

/** A reason's annotations, each observed: a credential-named key's value replaced. */
const observeAnnotations = (annotations: ReadonlyMap<string, unknown>): Context.Context<never> =>
  Context.makeUnsafe(
    new Map(
      [...annotations].map(([key, value]) => {
        if (isCredentialName(key)) return [key, REDACTED] as const;
        if (isStackFrame(value)) return [key, observeFrame(value)] as const;
        return [key, observe(value)] as const;
      }),
    ),
  );

/**
 * `cause` as an observer may receive it: every reason rebuilt, its failure or defect observed and
 * its annotations observed (the logical trace kept as fresh frames). Built fresh on each call.
 */
export const observeCause = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> =>
  Cause.fromReasons(
    cause.reasons.map((reason): Cause.Reason<unknown> => {
      const annotations = observeAnnotations(reason.annotations);
      if (Cause.isFailReason(reason)) {
        return Cause.makeFailReason(observe(reason.error)).annotate(annotations);
      }
      if (Cause.isDieReason(reason)) {
        return Cause.makeDieReason(observe(reason.defect)).annotate(annotations);
      }
      return Cause.makeInterruptReason(reason.fiberId).annotate(annotations);
    }),
  );

// ---------------------------------------------------------------------------------------------
// Observers
// ---------------------------------------------------------------------------------------------

const REDACTION_FAILED = "[redacted: the redaction itself failed]";

/** `redact(value)`, or a placeholder when it throws: never the original, never a failed effect. */
const safely =
  <A, B>(redact: (value: A) => B, fallback: () => B) =>
  (value: A): B => {
    try {
      return redact(value);
    } catch {
      return fallback();
    }
  };

const observedValue = safely(observe, () => REDACTION_FAILED);
const observedCause = safely(observeCause, () => Cause.die(REDACTION_FAILED));
const observedText = safely(redactCredentialsInText, () => REDACTION_FAILED);

const HEADER_ATTRIBUTE = /^http\.(?:request|response)\.header\.(.+)$/;
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["url.full", "http.url"]);

const observedAttribute = (key: string, value: unknown): unknown => {
  const header = HEADER_ATTRIBUTE.exec(key);
  if (header?.[1] !== undefined && isCredentialName(header[1])) return REDACTED;
  if (typeof value === "string") {
    if (URL_ATTRIBUTES.has(key)) return safely(redactUrlCredentials, () => REDACTION_FAILED)(value);
    if (key === "url.query") return safely(redactQueryCredentials, () => REDACTION_FAILED)(value);
  }
  return observedValue(value);
};

const observedAttributes = (
  attributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined =>
  attributes === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(attributes).map(([key, value]) => [key, observedAttribute(key, value)]),
      );

/** `tracer`, with every span's attributes, events and ending failure observed. */
export const redactingTracer = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    ...tracer,
    span: (options) => {
      const span = tracer.span(options);
      const attribute = span.attribute.bind(span);
      const event = span.event.bind(span);
      const end = span.end.bind(span);
      span.attribute = (key, value) => attribute(key, observedAttribute(key, value));
      span.event = (name, startTime, attributes) =>
        event(observedText(name), startTime, observedAttributes(attributes));
      span.end = (endTime, exit) =>
        end(endTime, Exit.isFailure(exit) ? Exit.failCause(observedCause(exit.cause)) : exit);
      return span;
    },
  });

/** `logger`, given every message and cause observed. */
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

const failureOf = (reason: Cause.Reason<unknown>): unknown =>
  Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined;

/**
 * `reporter`, given each report's cause observed: one report in, at most one out. Like
 * `ErrorReporter.make`, a cause or a failure already reported (by identity of the original, not of
 * any copy) is not reported again, so the reporter's own skipping still holds across the fresh
 * copies it receives.
 */
export const redactingReporter = (
  reporter: ErrorReporter.ErrorReporter,
): ErrorReporter.ErrorReporter => {
  const reported = new WeakSet<object>();
  return {
    [ErrorReporter.TypeId]: ErrorReporter.TypeId,
    report: (options) => {
      if (reported.has(options.cause)) return;
      reported.add(options.cause);
      const fresh = options.cause.reasons.filter((reason) => {
        if (Cause.isInterruptReason(reason)) return true;
        const original = failureOf(reason);
        if (typeof original !== "object" || original === null) return true;
        if (reported.has(original)) return false;
        reported.add(original);
        return true;
      });
      if (fresh.every((reason) => Cause.isInterruptReason(reason))) return;
      reporter.report({ ...options, cause: observedCause(Cause.fromReasons(fresh)) });
    },
  };
};

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
