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
 * The request itself is untouched: a route still reads `?token=` to authenticate. Install an
 * exporter's tracer, logger or reporter beneath this layer, so its output passes through it.
 */
import { Cause, Effect, ErrorReporter, Exit, Layer, Logger, Tracer } from "effect";
import { Headers } from "effect/unstable/http";

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

/**
 * Header names whose values are credentials: the standard ones and any name that says it holds a
 * token, a key, a secret, a password, a signature or a credential (`x-sealant-gateway-token`).
 */
export const CREDENTIAL_HEADER =
  /^(?:authorization|proxy-authorization|cookie|set-cookie)$|token|secret|password|passwd|api[-_]?key|signature|credential|session/i;

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

/** A full URL with its query credentials and userinfo replaced; anything else as it is. */
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

const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
const QUERY_PAIR = /([?&;])([^=&\s#?;]+)=([^&\s#;"'<>)]*)/g;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;

/**
 * Free text (an error message, a stack, a log line) with every credential it can recognise
 * replaced: a URL's userinfo, a credential query parameter wherever a query appears, and a
 * `Bearer` or `Basic` credential.
 */
export const redactCredentialsInText = (text: string): string =>
  text
    .replace(USERINFO, `$1${REDACTED}:${REDACTED}@`)
    .replace(QUERY_PAIR, (pair: string, separator: string, name: string) =>
      isCredentialParameter(name) ? `${separator}${name}=${REDACTED}` : pair,
    )
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`);

const MAX_DEPTH = 4;

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * An error with its message, stack, cause and own fields redacted. A copy with the same prototype,
 * so its name, `_tag` and `instanceof` stay; its message is an own value, which also shadows a
 * message the prototype computes from the request (as Effect's HTTP errors do).
 */
const redactError = (error: Error, seen: WeakSet<object>, depth: number): Error => {
  const fields = new Map<PropertyKey, unknown>();
  for (const key of Reflect.ownKeys(error)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(error, key);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    const redacted = redactValue(descriptor.value, seen, depth + 1);
    if (redacted !== descriptor.value) fields.set(key, redacted);
  }
  const message = redactCredentialsInText(error.message);
  const stack = error.stack === undefined ? undefined : redactCredentialsInText(error.stack);
  if (fields.size === 0 && message === error.message && stack === error.stack) return error;
  const copy: Error = Object.create(Object.getPrototypeOf(error));
  for (const key of Reflect.ownKeys(error)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(error, key);
    if (descriptor !== undefined) Reflect.defineProperty(copy, key, descriptor);
  }
  for (const [key, value] of fields) {
    Reflect.defineProperty(copy, key, { value, writable: true, configurable: true });
  }
  Reflect.defineProperty(copy, "message", { value: message, writable: true, configurable: true });
  if (stack !== undefined) {
    Reflect.defineProperty(copy, "stack", { value: stack, writable: true, configurable: true });
  }
  return copy;
};

/** `value` with every credential in its text redacted; the same value when it held none. */
export const redactValue = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown => {
  if (typeof value === "string") return redactCredentialsInText(value);
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH || seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (value instanceof Error) return redactError(value, seen, depth);
  if (Array.isArray(value)) {
    const items = value.map((item) => redactValue(item, seen, depth + 1));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(
      ([key, item]) => [key, redactValue(item, seen, depth + 1)] as const,
    );
    return entries.some(([key, item]) => item !== value[key]) ? Object.fromEntries(entries) : value;
  }
  return value;
};

/** `cause` with every failure and defect redacted; the same cause when it held no credential. */
export const redactCause = <E>(cause: Cause.Cause<E>): Cause.Cause<unknown> => {
  let changed = false;
  const reasons = cause.reasons.map((reason): Cause.Reason<unknown> => {
    if (Cause.isFailReason(reason)) {
      const error = redactValue(reason.error);
      if (error === reason.error) return reason;
      changed = true;
      return Cause.makeFailReason(error);
    }
    if (Cause.isDieReason(reason)) {
      const defect = redactValue(reason.defect);
      if (defect === reason.defect) return reason;
      changed = true;
      return Cause.makeDieReason(defect);
    }
    return reason;
  });
  return changed ? Cause.fromReasons(reasons) : cause;
};

const HEADER_ATTRIBUTE = /^http\.(?:request|response)\.header\.(.+)$/;
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["url.full", "http.url"]);

const redactAttribute = (key: string, value: unknown): unknown => {
  const header = HEADER_ATTRIBUTE.exec(key);
  if (header?.[1] !== undefined && CREDENTIAL_HEADER.test(header[1])) return REDACTED;
  if (typeof value === "string") {
    if (URL_ATTRIBUTES.has(key)) return redactUrlCredentials(value);
    if (key === "url.query") return redactQueryCredentials(value);
  }
  return redactValue(value);
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
        event(redactCredentialsInText(name), startTime, redactAttributes(attributes));
      span.end = (endTime, exit) =>
        end(endTime, Exit.isFailure(exit) ? Exit.failCause(redactCause(exit.cause)) : exit);
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
      message: redactValue(options.message),
      cause: redactCause(options.cause),
    }),
  );

/** `reporter`, given every cause redacted. */
export const redactingReporter = (
  reporter: ErrorReporter.ErrorReporter,
): ErrorReporter.ErrorReporter =>
  ErrorReporter.make(({ cause, fiber, timestamp }) =>
    reporter.report({ cause: redactCause(cause), fiber, timestamp }),
  );

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
      CREDENTIAL_HEADER,
    ]),
  ),
);
