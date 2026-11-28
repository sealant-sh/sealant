/**
 * Sentry in the browser: errors caught by React error boundaries, uncaught errors and rejections,
 * and one transaction per page load and per navigation, named by URL template (`/workspaces/$workspaceId`). Requests to this
 * app's own `/api/trpc` carry W3C `traceparent` (and Sentry's `sentry-trace` and `baggage`), which
 * the web server passes on to sealant's API, so the API's spans join the browser's trace.
 *
 * Nothing here runs unless the page carries a telemetry config (see `runtime-config.ts`).
 */
import {
  captureReactException,
  init,
  isInitialized,
  tanstackRouterBrowserTracingIntegration,
  type BrowserOptions,
} from "@sentry/react";
import type { AnyRouter } from "@tanstack/react-router";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { isTRPCClientError } from "@trpc/client";

import {
  BROWSER_TELEMETRY_CONFIG_ELEMENT_ID,
  parseBrowserTelemetryConfig,
  type BrowserTelemetryConfig,
} from "./runtime-config";
import { scrubPayload } from "./scrub";
import { nameByUrlTemplate, tidyTransaction, urlTemplate } from "./tidy";

/** A route ID's URL template (`/_auth/login` is `/login`), from the router's own route tree. */
const urlTemplateOf =
  (router: AnyRouter) =>
  (routeId: string): string | undefined => {
    const fullPath: unknown = router.routesById[routeId]?.fullPath;
    return typeof fullPath === "string" ? urlTemplate(fullPath) : undefined;
  };

/** Only this app's own tRPC endpoint, matched on the path of a same-origin request. */
const TRACE_PROPAGATION_TARGETS = [/^\/api\/trpc(?:\/|$)/];

/**
 * The Sentry options for this app. Every data-collection switch is off (v11's replacement for
 * `sendDefaultPii`): no user, cookies, headers, bodies, query parameters or stack variables, and no console breadcrumbs (the console can hold
 * terminal output). Session replay is never installed. Every event, transaction and breadcrumb
 * passes through `scrubPayload` before it is sent.
 */
export const browserSentryOptions = (
  config: BrowserTelemetryConfig,
  router: AnyRouter,
): BrowserOptions => ({
  dsn: config.dsn,
  environment: config.environment,
  ...(SEALANT_WEB_RELEASE.length > 0 ? { release: SEALANT_WEB_RELEASE } : {}),
  tracesSampleRate: config.tracesSampleRate,
  // Page loads and navigations as transactions, which every Sentry server accepts; v11's default
  // streams spans instead.
  traceLifecycle: "static",
  propagateTraceparent: true,
  tracePropagationTargets: TRACE_PROPAGATION_TARGETS,
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
  },
  integrations: (defaults) => [
    ...defaults.filter((integration) => integration.name !== "Console"),
    tanstackRouterBrowserTracingIntegration(router),
  ],
  beforeSend: (event) => scrubPayload(event),
  // `beforeSendSpan` only sees streamed spans; with the static lifecycle the transaction is the
  // payload, spans and all.
  // oxlint-disable-next-line typescript/no-deprecated
  beforeSendTransaction: (event) =>
    tidyTransaction(nameByUrlTemplate(scrubPayload(event), urlTemplateOf(router))),
  beforeBreadcrumb: (breadcrumb) =>
    breadcrumb.category === "console" ? null : scrubPayload(breadcrumb),
});

const readPageConfig = (): BrowserTelemetryConfig | undefined => {
  const text = document.getElementById(BROWSER_TELEMETRY_CONFIG_ELEMENT_ID)?.textContent;
  return text === null || text === undefined ? undefined : parseBrowserTelemetryConfig(text);
};

/** Starts Sentry once, in the browser, when the page carries a config. Otherwise does nothing. */
export const startBrowserTelemetry = (router: AnyRouter): void => {
  if (typeof document === "undefined" || isInitialized()) return;
  const config = readPageConfig();
  if (config === undefined) return;
  init(browserSentryOptions(config, router));
};

/** A tRPC error the server answered with a 4xx: a not-found, a refusal, bad input. Not a defect. */
const isClientRequestError = (error: unknown): boolean => {
  if (!isTRPCClientError(error)) return false;
  const data: unknown = error.data;
  const status =
    typeof data === "object" && data !== null && "httpStatus" in data ? data.httpStatus : undefined;
  return typeof status === "number" && status >= 400 && status < 500;
};

const reported = new WeakSet<object>();

/** Whether `error` is reported for the first time now; marks it reported. */
const firstReport = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return true;
  if (reported.has(error)) return false;
  reported.add(error);
  return true;
};

const isControlFlow = (error: unknown): boolean =>
  isRedirect(error) || isNotFound(error) || isClientRequestError(error);

type ReactErrorInfo = { readonly componentStack?: string | undefined };

/**
 * Reports an error an error boundary caught, once per error object: the same error can pass
 * through more than one boundary (TanStack's not-found boundary rethrows what it does not handle).
 * Redirects, not-founds and 4xx tRPC answers are control flow, not failures, and are skipped.
 */
export const reportCaughtError = (error: unknown, errorInfo: ReactErrorInfo): void => {
  if (!isInitialized() || isControlFlow(error) || !firstReport(error)) return;
  captureReactException(
    error,
    { componentStack: errorInfo.componentStack ?? null },
    {
      mechanism: { type: "auto.function.react.error_boundary", handled: true },
    },
  );
};

/**
 * Reports an error React recovered from by rendering again on the client, as after a failed
 * server render. React wraps the original failure in `cause`, and a boundary has usually reported
 * that original already, so it is reported only when it was not.
 */
export const reportRecoverableError = (error: unknown, errorInfo: ReactErrorInfo): void => {
  const original = error instanceof Error && error.cause !== undefined ? error.cause : error;
  if (!isInitialized() || isControlFlow(original) || !firstReport(original)) return;
  captureReactException(
    error,
    { componentStack: errorInfo.componentStack ?? null },
    {
      mechanism: { type: "auto.function.react.recoverable_error", handled: true },
    },
  );
};
