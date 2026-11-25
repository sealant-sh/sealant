/**
 * Errors to Sentry, and nothing else: no Sentry tracing (Effect's own tracer owns traces and exports
 * them over OTLP), no integrations that patch modules, read local variables or record breadcrumbs.
 * Each event carries the trace and span it happened in, so Sentry links it to its trace.
 *
 * What reaches the client has already passed the credential redaction: the Effect reporter is
 * installed beneath `CredentialRedactionLive`, and `captureError` observes its error itself. The
 * client's `beforeSend` then keeps only an allowlist of event fields.
 */
import {
  applySdkMetadata,
  createStackParser,
  createTransport,
  type ErrorEvent,
  type Event,
  linkedErrorsIntegration,
  Scope as SentryScope,
  type Transport,
  type TransportMakeRequestResponse,
  type TransportRequest,
} from "@sentry/core";
import {
  nodeStackLineParser,
  ServerRuntimeClient,
  type ServerRuntimeClientOptions,
} from "@sentry/core/server";
import { Cause, Context, ErrorReporter, Option, Tracer } from "effect";

import type { ObservabilityConfig } from "./config.js";
import { observe, redactUrlCredentials } from "./redaction.js";

/** How long one envelope may take to send before it is dropped. */
const SEND_TIMEOUT_MS = 5_000;

/** The trace an event belongs to, as Sentry's `contexts.trace` writes it. */
export interface EventTrace {
  readonly traceId: string;
  readonly spanId: string;
}

/** Context to attach to a captured error: the span it happened in, and safe tags. */
export interface CaptureContext {
  readonly span?: Tracer.AnySpan | undefined;
  /** Opaque IDs and enums only (`sealant.workspace_id`, `messaging.destination.name`). */
  readonly tags?: Readonly<Record<string, string | number | boolean | undefined>> | undefined;
}

export interface SentryErrors {
  /** The Effect reporter for this client; install it beneath the redaction. */
  readonly reporter: ErrorReporter.ErrorReporter;
  /** Capture one failure a Promise boundary caught. The error is observed (redacted) first. */
  readonly captureError: (error: unknown, context?: CaptureContext) => void;
  /** Wait for queued events to send, at most `timeoutMs`. */
  readonly flush: (timeoutMs: number) => Promise<boolean>;
}

/** The fields of an event that leave the process; everything else is dropped. */
const scrubEvent = (event: Event): Event => {
  const kept: Event = {
    ...(event.event_id === undefined ? {} : { event_id: event.event_id }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    ...(event.level === undefined ? {} : { level: event.level }),
    ...(event.platform === undefined ? {} : { platform: event.platform }),
    ...(event.release === undefined ? {} : { release: event.release }),
    ...(event.environment === undefined ? {} : { environment: event.environment }),
    ...(event.server_name === undefined ? {} : { server_name: event.server_name }),
    ...(event.exception === undefined ? {} : { exception: event.exception }),
    ...(event.tags === undefined ? {} : { tags: event.tags }),
    ...(event.sdk === undefined ? {} : { sdk: event.sdk }),
    ...(event.debug_meta === undefined ? {} : { debug_meta: event.debug_meta }),
  };
  const trace = event.contexts?.trace;
  const runtime = event.contexts?.runtime;
  if (trace !== undefined || runtime !== undefined) {
    kept.contexts = {
      ...(trace === undefined ? {} : { trace }),
      ...(runtime === undefined ? {} : { runtime }),
    };
  }
  // A request is kept as its method and its URL without the query, never its data or headers.
  const request = event.request;
  if (request !== undefined) {
    const url = typeof request.url === "string" ? redactUrlCredentials(request.url) : undefined;
    kept.request = {
      ...(request.method === undefined ? {} : { method: request.method }),
      ...(url === undefined ? {} : { url: url.replace(/[?#].*$/s, "") }),
    };
  }
  return kept;
};

const fetchTransport = (options: { readonly url: string }) =>
  createTransport(
    { recordDroppedEvent: () => undefined, bufferSize: 64, ...options },
    async (request: TransportRequest): Promise<TransportMakeRequestResponse> => {
      const response = await fetch(options.url, {
        method: "POST",
        body: typeof request.body === "string" ? request.body : new Uint8Array(request.body),
        headers: { "content-type": "application/x-sentry-envelope" },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => undefined);
      return {
        statusCode: response.status,
        headers: {
          "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
          "retry-after": response.headers.get("retry-after"),
        },
      };
    },
  );

/**
 * A plain, observed error (what the redaction hands a reporter: name, message, stack as redacted
 * text) as an `Error` Sentry's stack parser reads. Anything else becomes an error named for its
 * kind, its observed form in the message.
 */
const asError = (observed: unknown): Error => {
  if (typeof observed === "object" && observed !== null) {
    const name = Reflect.get(observed, "name");
    const tag = Reflect.get(observed, "_tag");
    const message = Reflect.get(observed, "message");
    const stack = Reflect.get(observed, "stack");
    const error = new Error(typeof message === "string" ? message : "");
    error.name =
      typeof tag === "string" && tag !== "" ? tag : typeof name === "string" ? name : "Error";
    error.stack = typeof stack === "string" ? stack : `${error.name}: ${error.message}`;
    return error;
  }
  const error = new Error(typeof observed === "string" ? observed : String(observed));
  error.name = "NonErrorFailure";
  error.stack = `${error.name}: ${error.message}`;
  return error;
};

/** The span a reporter's fiber was running in, when it ran in one. */
const fiberSpan = (context: Context.Context<never>): Tracer.AnySpan | undefined =>
  Option.getOrUndefined(Context.getOption(context, Tracer.ParentSpan));

/**
 * Which failures an Effect boundary reports. Every defect does. A typed failure does only when it
 * is the API's own "internal" or "bad gateway" answer, or names an `Error` or `Fatal` severity:
 * expected refusals (not found, conflict, budget, unauthorised) are answers, not issues.
 */
const REPORTED_FAILURE_TAG = /(?:InternalServerError|BadGatewayError)$/;

const isReportedFailure = (failure: unknown): boolean => {
  if (typeof failure !== "object" || failure === null) return true;
  const tag = Reflect.get(failure, "_tag");
  if (typeof tag !== "string") return true;
  if (REPORTED_FAILURE_TAG.test(tag)) return true;
  const severity = Reflect.get(failure, ErrorReporter.severity);
  return severity === "Error" || severity === "Fatal";
};

/**
 * A Sentry client in errors-only mode for `config`, and the reporter and capture function that
 * feed it.
 */
export const makeSentryErrors = (config: ObservabilityConfig): SentryErrors => {
  const options: ServerRuntimeClientOptions = {
    dsn: config.dsn,
    environment: config.environment,
    ...(config.release === undefined ? {} : { release: config.release }),
    serverName: config.serviceName,
    platform: "node",
    runtime: { name: "node", version: process.version },
    // Collect nothing about people or requests (the v11 form of `sendDefaultPii: false`).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    // No Sentry tracing at all: Effect's tracer owns spans. "static" also keeps the client from
    // adding its span-streaming integration.
    traceLifecycle: "static",
    maxBreadcrumbs: 0,
    integrations: [linkedErrorsIntegration()],
    stackParser: createStackParser(nodeStackLineParser()),
    transport: (transportOptions): Transport => fetchTransport({ url: transportOptions.url }),
    beforeSend: (event: ErrorEvent): ErrorEvent => ({ ...scrubEvent(event), type: undefined }),
  };
  // The bare core client names no SDK of its own; without this, events carry no SDK name or version.
  applySdkMetadata(options, "sealant-server", ["core"]);
  const client = new ServerRuntimeClient(options);
  const scope = new SentryScope();
  scope.setClient(client);
  client.init();

  const capture = (error: Error, context: CaptureContext): void => {
    const event = scope.clone();
    const span = context.span;
    if (span !== undefined) {
      event.setContext("trace", { trace_id: span.traceId, span_id: span.spanId });
    }
    for (const [key, value] of Object.entries(context.tags ?? {})) {
      if (value !== undefined) event.setTag(key, value);
    }
    client.captureException(error, { mechanism: { type: "sealant", handled: true } }, event);
  };

  const reporter: ErrorReporter.ErrorReporter = {
    [ErrorReporter.TypeId]: ErrorReporter.TypeId,
    report: ({ cause, fiber }) => {
      const span = fiberSpan(fiber.context);
      for (const reason of cause.reasons) {
        if (Cause.isInterruptReason(reason)) continue;
        const original = Cause.isFailReason(reason) ? reason.error : reason.defect;
        if (ErrorReporter.isIgnored(original)) continue;
        if (Cause.isFailReason(reason) && !isReportedFailure(original)) continue;
        capture(asError(original), { span });
      }
    },
  };

  return {
    reporter,
    captureError: (error, context = {}) => {
      try {
        capture(asError(observe(error)), context);
      } catch {
        // Reporting never fails the caller.
      }
    },
    flush: (timeoutMs) => Promise.resolve(client.flush(timeoutMs)),
  };
};
