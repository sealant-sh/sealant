/**
 * The W3C trace context that crosses process boundaries: an HTTP request, a queued job, a boot
 * config. `traceparent` carries the trace; Sentry's `sentry-trace` is accepted only when no
 * `traceparent` came.
 */
import type { IncomingMessage, Server } from "node:http";

import { Effect, Layer, Option, type Tracer } from "effect";
import { Headers, HttpMiddleware, type HttpServerRequest, HttpTraceContext } from "effect/http";

/** A trace context as it is stored or sent: the W3C fields, `tracestate` when one came. */
export interface TraceCarrier {
  readonly traceparent: string;
  readonly tracestate?: string | undefined;
}

/** `span`'s context as a W3C carrier. */
export const carrierOf = (span: Tracer.AnySpan): TraceCarrier => ({
  traceparent: `00-${span.traceId.padStart(32, "0")}-${span.spanId}-${span.sampled ? "01" : "00"}`,
});

/**
 * The current span's context as a carrier, to send with work another process picks up (a queued
 * job, a boot config), or `undefined` outside any span.
 */
export const currentTraceCarrier: Effect.Effect<TraceCarrier | undefined> =
  Effect.currentParentSpan.pipe(
    Effect.map(carrierOf),
    Effect.orElseSucceed(() => undefined),
  );

/** The remote parent a carrier names, or `undefined` when it names none validly. */
export const parentOf = (carrier: TraceCarrier): Tracer.ExternalSpan | undefined =>
  Option.getOrUndefined(
    HttpTraceContext.w3c(Headers.fromInput({ traceparent: carrier.traceparent })),
  );

const SENTRY_TRACE = /^\s*([0-9a-f]{32})-([0-9a-f]{16})(?:-([01]))?\s*$/i;

/**
 * Sentry's `sentry-trace` (`<trace>-<span>[-<sampled>]`) written as a `traceparent`, or `undefined`
 * when it is malformed. An absent sampled flag means the caller deferred the decision: sampled.
 */
export const traceparentFromSentryTrace = (value: string): string | undefined => {
  const match = SENTRY_TRACE.exec(value);
  if (match === null) return undefined;
  const [, traceId, spanId, sampled] = match;
  if (traceId === undefined || spanId === undefined) return undefined;
  return `00-${traceId.toLowerCase()}-${spanId.toLowerCase()}-${sampled === "0" ? "00" : "01"}`;
};

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Gives a request that carries `sentry-trace` but no `traceparent` the equivalent `traceparent`, so
 * Effect's request tracer (which reads W3C and B3 only) continues the caller's trace.
 */
export const adoptSentryTrace = (request: IncomingMessage): void => {
  if (headerValue(request.headers.traceparent) !== undefined) return;
  const sentryTrace = headerValue(request.headers["sentry-trace"]);
  if (sentryTrace === undefined) return;
  const traceparent = traceparentFromSentryTrace(sentryTrace);
  if (traceparent !== undefined) request.headers.traceparent = traceparent;
};

/**
 * `server`, adopting `sentry-trace` on each request before any other listener (the HTTP framework's
 * included) sees it.
 */
export const withSentryTraceFallback = <S extends Server>(server: S): S => {
  server.prependListener("request", adoptSentryTrace);
  server.prependListener("upgrade", adoptSentryTrace);
  return server;
};

/** The paths a load balancer or orchestrator polls to see whether the process is up. */
const PROBE_PATHS: ReadonlySet<string> = new Set(["/healthz", "/readyz", "/health", "/ready"]);

/**
 * Whether `request` is a liveness or readiness probe that continues no trace. Such a probe is
 * polled every few seconds, so tracing it would put a root trace of its own in Sentry for every
 * poll. A probe that carries a trace (someone following one through) is traced as usual.
 */
export const isUntracedProbe = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const path = request.url.split(/[?#]/, 1)[0] ?? request.url;
  return (
    PROBE_PATHS.has(path) &&
    request.headers["traceparent"] === undefined &&
    request.headers["sentry-trace"] === undefined
  );
};

/**
 * Turns the request tracer off for {@link isUntracedProbe} requests. A probe's failures are still
 * reported as errors; only its span is never made.
 */
export const UntracedProbesLive: Layer.Layer<never> = Layer.succeed(
  HttpMiddleware.TracerDisabledWhen,
)(isUntracedProbe);
