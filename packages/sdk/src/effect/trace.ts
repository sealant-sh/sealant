/**
 * Trace continuation: every SDK call continues its caller's trace instead of starting its own.
 *
 * A call's parent is captured synchronously when the call starts, in this order:
 *
 *   1. the calling Effect fiber's current span (a Promise call made inside `Effect.promise` or
 *      `Effect.tryPromise` runs its first step while that fiber is current);
 *   2. the client's `traceContext` provider;
 *   3. the active OpenTelemetry context, read through `@opentelemetry/api`'s global registration,
 *      so the SDK imports and depends on no tracing package.
 *
 * Each contract call runs in a client span `sealant.sdk.<group>.<endpoint>` carrying only the IDs
 * from its path. When the caller's Effect tracer exports spans, the SDK's spans are made on that
 * tracer and the request carries the SDK's HTTP span. When nothing exports them, the request carries
 * the parent's own `traceparent`, so the server's span hangs off a span that exists. With no parent
 * and no exporting tracer the request carries no trace header at all.
 */
import { Context, Effect, Fiber, Option, Tracer } from "effect";
import { HttpClient } from "effect/http";

import type { SealantTraceContext } from "../types.js";

/** The caller's trace, captured when a call starts and continued by everything that call does. */
export interface CallerTrace {
  /** The span the call's spans hang off, when the caller has one. */
  readonly parent: Tracer.AnySpan | undefined;
  /** The calling fiber's tracer when it exports spans (anything but Effect's native tracer). */
  readonly tracer: Tracer.Tracer | undefined;
  /** The W3C `tracestate` that travels with an explicit or OpenTelemetry parent. */
  readonly tracestate: string | undefined;
}

/** The `tracestate` a call forwards; set from the captured caller trace. */
export const CallerTraceState = Context.Reference<string | undefined>(
  "@sealant/sdk/CallerTraceState",
  { defaultValue: () => undefined },
);

/** A `traceparent` the request carries as is, set when no exporting tracer makes the SDK's spans. */
export const DirectTraceparent = Context.Reference<string | undefined>(
  "@sealant/sdk/DirectTraceparent",
  { defaultValue: () => undefined },
);

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ALL_ZERO = /^0+$/;
const TRACESTATE_MAX_LENGTH = 512;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** A parsed W3C `traceparent`, or `undefined` for a malformed or invalid one. */
export function parseTraceparent(
  value: string,
): { readonly traceId: string; readonly spanId: string; readonly sampled: boolean } | undefined {
  const match = TRACEPARENT.exec(value.trim());
  if (match === null) return undefined;
  const [, version, traceId, spanId, flags, rest] = match;
  if (version === undefined || traceId === undefined || spanId === undefined) return undefined;
  if (flags === undefined || version === "ff") return undefined;
  // Version 00 has exactly four fields; a later version may append more.
  if (version === "00" && rest !== undefined) return undefined;
  if (ALL_ZERO.test(traceId) || ALL_ZERO.test(spanId)) return undefined;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/** The `traceparent` a span is continued by. */
export function formatTraceparent(span: Tracer.AnySpan): string {
  return `00-${span.traceId.padStart(32, "0")}-${span.spanId}-${span.sampled ? "01" : "00"}`;
}

const safeTracestate = (value: string | undefined): string | undefined =>
  value !== undefined &&
  value.length > 0 &&
  value.length <= TRACESTATE_MAX_LENGTH &&
  PRINTABLE_ASCII.test(value)
    ? value
    : undefined;

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

/** Call `holder[name]()` when it is a method; anything else answers `undefined`. */
const callMethod = (holder: unknown, name: string, args: ReadonlyArray<unknown> = []): unknown => {
  if (!isRecord(holder)) return undefined;
  const method = holder[name];
  return typeof method === "function" ? Reflect.apply(method, holder, args) : undefined;
};

// `@opentelemetry/api` 1.x keeps its registered globals under this symbol, and keys the active span
// in a context with the second one. Reading them directly keeps the SDK free of the dependency.
const OPENTELEMETRY_API = Symbol.for("opentelemetry.js.api.1");
const OPENTELEMETRY_SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");

/** The active OpenTelemetry span's context, when `@opentelemetry/api` is registered and has one. */
export function activeOpenTelemetryContext(): SealantTraceContext | undefined {
  try {
    const api: unknown = Reflect.get(globalThis, OPENTELEMETRY_API);
    if (!isRecord(api)) return undefined;
    const active = callMethod(api["context"], "active");
    const span = callMethod(active, "getValue", [OPENTELEMETRY_SPAN_KEY]);
    const spanContext = callMethod(span, "spanContext");
    if (!isRecord(spanContext)) return undefined;
    const { traceId, spanId, traceFlags, traceState } = spanContext;
    if (typeof traceId !== "string" || typeof spanId !== "string") return undefined;
    const flags = typeof traceFlags === "number" && (traceFlags & 1) === 1 ? "01" : "00";
    const traceparent = `00-${traceId}-${spanId}-${flags}`;
    if (parseTraceparent(traceparent) === undefined) return undefined;
    const serialized = callMethod(traceState, "serialize");
    const tracestate = safeTracestate(typeof serialized === "string" ? serialized : undefined);
    return tracestate === undefined ? { traceparent } : { traceparent, tracestate };
  } catch {
    return undefined;
  }
}

/** The calling Effect fiber's span and exporting tracer, when a fiber is running this call. */
const fromCallingFiber = ():
  | { readonly parent: Tracer.AnySpan | undefined; readonly tracer: Tracer.Tracer | undefined }
  | undefined => {
  try {
    const fiber = Fiber.getCurrent();
    if (fiber === undefined) return undefined;
    const tracer = fiber.getRef(Tracer.Tracer);
    return {
      parent: Option.getOrUndefined(Context.getOption(fiber.context, Tracer.ParentSpan)),
      tracer: tracer === Tracer.nativeTracer ? undefined : tracer,
    };
  } catch {
    return undefined;
  }
};

const fromTraceContext = (
  context: SealantTraceContext | undefined,
):
  | { readonly parent: Tracer.ExternalSpan; readonly tracestate: string | undefined }
  | undefined => {
  if (context === undefined || typeof context.traceparent !== "string") return undefined;
  const parsed = parseTraceparent(context.traceparent);
  if (parsed === undefined) return undefined;
  return {
    parent: Tracer.externalSpan(parsed),
    tracestate: safeTracestate(context.tracestate),
  };
};

const callProvider = (
  provider: (() => SealantTraceContext | undefined) | undefined,
): SealantTraceContext | undefined => {
  if (provider === undefined) return undefined;
  try {
    return provider();
  } catch {
    // A provider that throws must not fail the call it was asked about.
    return undefined;
  }
};

// Set only for the synchronous extent of `withCallerTrace`, so it never outlives the call that set it.
let handedTrace: { readonly trace: CallerTrace | undefined } | undefined;

/**
 * Call `f` so that every SDK call it starts synchronously captures `trace`: how a call that has
 * already awaited hands its trace to another facade call (`create()` to `ready()`).
 */
export function withCallerTrace<A>(trace: CallerTrace | undefined, f: () => A): A {
  const previous = handedTrace;
  handedTrace = { trace };
  try {
    return f();
  } finally {
    handedTrace = previous;
  }
}

/**
 * The caller's trace right now, or `undefined` when there is none. Synchronous: call it before the
 * first `await` of a call, while a calling Effect fiber is still current.
 */
export function captureCallerTrace(
  provider: (() => SealantTraceContext | undefined) | undefined,
): CallerTrace | undefined {
  if (handedTrace !== undefined) return handedTrace.trace;
  const fiber = fromCallingFiber();
  if (fiber?.parent !== undefined) {
    return { parent: fiber.parent, tracer: fiber.tracer, tracestate: undefined };
  }
  const explicit =
    fromTraceContext(callProvider(provider)) ?? fromTraceContext(activeOpenTelemetryContext());
  if (explicit === undefined && fiber?.tracer === undefined) return undefined;
  return { parent: explicit?.parent, tracer: fiber?.tracer, tracestate: explicit?.tracestate };
}

/** Run an effect as part of a captured caller trace. */
export const continueCallerTrace =
  (trace: CallerTrace | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    if (trace === undefined) return effect;
    const withState =
      trace.tracestate === undefined
        ? effect
        : Effect.provideService(effect, CallerTraceState, trace.tracestate);
    const withTracer =
      trace.tracer === undefined
        ? withState
        : Effect.provideService(withState, Tracer.Tracer, trace.tracer);
    return trace.parent === undefined
      ? withTracer
      : Effect.withParentSpan(withTracer, trace.parent, { captureStackTrace: false });
  };

/** The trace headers a raw `fetch` made for a captured caller trace carries. */
export function traceHeaders(trace: CallerTrace | undefined): Readonly<Record<string, string>> {
  if (trace?.parent === undefined) return {};
  const traceparent = formatTraceparent(trace.parent);
  return trace.tracestate === undefined
    ? { traceparent }
    : { traceparent, tracestate: trace.tracestate };
}

/** An endpoint's route as the contract declares it: `GET` and `/v1/sessions/:sessionId/output`. */
export interface EndpointRoute {
  readonly method: string;
  readonly path: string;
}

/**
 * `tracer`, giving the one HTTP client span started directly beneath the span `parentSpanId` the
 * endpoint's route template: Sentry then describes the request as `GET
 * /v1/sessions/:sessionId/output`, never by its URL and the IDs in it.
 */
const routeTemplatingTracer = (
  tracer: Tracer.Tracer,
  parentSpanId: string,
  route: EndpointRoute,
): Tracer.Tracer =>
  Tracer.make({
    ...tracer,
    span: (options) => {
      const span = tracer.span(options);
      const parent = Option.getOrUndefined(options.parent);
      if (options.kind === "client" && parent?.spanId === parentSpanId) {
        span.attribute("url.template", route.path);
        span.attribute("sentry.op", "http.client");
        span.attribute("sentry.description", `${route.method} ${route.path}`);
      }
      return span;
    },
  });

/**
 * What Sentry calls an SDK call's span: its operation, and in words what the call does, from its
 * endpoint (`sealant.sdk.sessions.get_session_output` reads `sealant.sdk — get session output`).
 * The span's name stays in `code.function.name`, so a search for it still finds the call.
 */
const sdkSpanAttributes = (name: string) => ({
  "sentry.op": "sealant.sdk",
  "sentry.description": (name.split(".").at(-1) ?? name).split("_").filter(Boolean).join(" "),
  "code.function.name": name,
});

/**
 * Run one contract call in its client span, and choose what trace header its request carries (see
 * the module comment).
 */
export const traceCall = <A, E, R>(
  name: string,
  attributes: Readonly<Record<string, string>>,
  effect: Effect.Effect<A, E, R>,
  route?: EndpointRoute,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const parent = yield* Effect.serviceOption(Tracer.ParentSpan);
    const tracer = yield* Effect.tracer;
    const templated =
      route === undefined || tracer === Tracer.nativeTracer
        ? effect
        : Effect.flatMap(Effect.currentSpan.pipe(Effect.option), (span) =>
            Option.isNone(span)
              ? effect
              : Effect.withTracer(effect, routeTemplatingTracer(tracer, span.value.spanId, route)),
          );
    const spanned = Effect.withSpan(templated, name, {
      kind: "client",
      attributes: { ...attributes, ...sdkSpanAttributes(name) },
      captureStackTrace: false,
    });
    if (tracer !== Tracer.nativeTracer) return yield* spanned;
    const unpropagated = Effect.provideService(spanned, HttpClient.TracerPropagationEnabled, false);
    if (Option.isNone(parent)) return yield* unpropagated;
    return yield* Effect.provideService(
      unpropagated,
      DirectTraceparent,
      formatTraceparent(parent.value),
    );
  });

const snakeCase = (identifier: string): string =>
  identifier.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** The span attributes of a call: the IDs in its path (`workspaceId` -> `sealant.workspace_id`). */
const idAttributes = (request: unknown): Readonly<Record<string, string>> => {
  if (!isRecord(request) || !isRecord(request["params"])) return {};
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(request["params"])) {
    if (key.length > 2 && key.endsWith("Id") && typeof value === "string") {
      attributes[`sealant.${snakeCase(key)}`] = value;
    }
  }
  return attributes;
};

/** The routes of a contract's endpoints, by group and endpoint key. */
export type EndpointRoutes = ReadonlyMap<string, ReadonlyMap<string, EndpointRoute>>;

/** An endpoint function wrapped in {@link traceCall}; any other value is kept as it is. */
const instrumentValue = (
  name: string,
  value: unknown,
  holder: object,
  route: EndpointRoute | undefined,
): unknown => {
  if (typeof value !== "function") return value;
  return (...args: ReadonlyArray<unknown>): unknown => {
    const result: unknown = Reflect.apply(value, holder, args);
    return Effect.isEffect(result) ? traceCall(name, idAttributes(args[0]), result, route) : result;
  };
};

const instrumentGroup = (
  prefix: string,
  group: Record<PropertyKey, unknown>,
  routes: ReadonlyMap<string, EndpointRoute> | undefined,
): object => {
  const instrumented: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(group)) {
    instrumented[key] = instrumentValue(
      `${prefix}.${snakeCase(key)}`,
      value,
      group,
      routes?.get(key),
    );
  }
  return instrumented;
};

/**
 * The derived control-plane client with every endpoint run through {@link traceCall}, named
 * `sealant.sdk.<group>.<endpoint>` from the contract's own identifiers, its HTTP span described by
 * the endpoint's route in `routes`.
 */
export function instrumentClient<Client extends object>(
  client: Client,
  routes: EndpointRoutes = new Map(),
): Client {
  const instrumented: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(client)) {
    const name = `sealant.sdk.${snakeCase(key)}`;
    instrumented[key] =
      typeof value !== "function" && isRecord(value)
        ? instrumentGroup(name, value, routes.get(key))
        : instrumentValue(name, value, client, undefined);
  }
  // SAFETY: the copy has the client's keys, and each endpoint function is replaced by one taking the
  // same arguments and returning the same effect type (`traceCall` preserves A, E and R). TypeScript
  // cannot express that mapping over the derived client's type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the mapping above keeps the client's type; see SAFETY.
  return instrumented as Client;
}

/** The route of every endpoint `api` declares, keyed as its derived client is. */
export const endpointRoutes = (api: {
  readonly groups: Readonly<
    Record<
      string,
      {
        readonly endpoints: Readonly<
          Record<string, { readonly method: string; readonly path: string }>
        >;
      }
    >
  >;
}): EndpointRoutes =>
  new Map(
    Object.entries(api.groups).map(([groupKey, group]) => [
      groupKey,
      new Map(
        Object.entries(group.endpoints).map(([endpointKey, endpoint]) => [
          endpointKey,
          { method: endpoint.method, path: endpoint.path },
        ]),
      ),
    ]),
  );
