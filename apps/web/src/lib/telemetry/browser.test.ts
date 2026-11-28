// @vitest-environment jsdom
/**
 * The browser SDK as the app configures it, run for real against a recording transport: what
 * reaches the transport is exactly what would reach Sentry.
 */
import {
  addBreadcrumb,
  captureException,
  flush,
  getActiveSpan,
  init,
  type BrowserOptions,
} from "@sentry/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { browserSentryOptions, reportCaughtError, reportRecoverableError } from "./browser";

const CANARY_TOKEN = "ghp_CANARYc4n4ryC4N4RYc4n4ryC4N4RYc4n4";
const CANARY_QUERY = "canary-query-7f3a9b2c";
const CANARY_PATH = `/workspaces/ws_123?token=${CANARY_QUERY}#${CANARY_QUERY}`;

type Envelope = Parameters<ReturnType<NonNullable<BrowserOptions["transport"]>>["send"]>[0];

/** One item of an envelope the SDK handed the transport: its type and the JSON it carried. */
interface SentItem {
  readonly type: string;
  readonly json: string;
}

const sent: SentItem[] = [];
const fetched: { readonly url: string; readonly headers: Headers }[] = [];
const sentText = (): string => sent.map((item) => item.json).join("\n");
const sentOfType = (type: string): readonly string[] =>
  sent.filter((item) => item.type === type).map((item) => item.json);

const errorEventSchema = z.object({
  exception: z.object({ values: z.array(z.object({ value: z.string().optional() })) }),
});

/** The error events sent whose own exception (not a breadcrumb of an earlier one) says `message`. */
const errorEventsSaying = (message: string): number =>
  sentOfType("event").filter((json) => {
    const event = errorEventSchema.safeParse(JSON.parse(json));
    return event.success && event.data.exception.values.some((value) => value.value === message);
  }).length;

const record = (envelope: Envelope): void => {
  const items: readonly (readonly [{ readonly type: string }, unknown])[] = envelope[1];
  for (const [header, payload] of items) {
    sent.push({ type: header.type, json: JSON.stringify(payload) });
  }
};

// A pathless layout above the page, as the app's own `_authenticated` is: the route ID
// (`/_authenticated/workspaces/$workspaceId/`) is not what the address bar shows.
const rootRoute = createRootRoute();
const authenticatedRoute = createRoute({ getParentRoute: () => rootRoute, id: "_authenticated" });
const workspaceRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/workspaces/$workspaceId/",
});
const router = createRouter({
  routeTree: rootRoute.addChildren([authenticatedRoute.addChildren([workspaceRoute])]),
  history: createMemoryHistory({ initialEntries: [CANARY_PATH] }),
});

const realFetch = globalThis.fetch;

beforeAll(async () => {
  window.history.replaceState({}, "", CANARY_PATH);
  // Installed before init, so the SDK wraps it the way it wraps the browser's fetch.
  globalThis.fetch = (input, requestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push({ url, headers: new Headers(requestInit?.headers) });
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  await router.load();
  init({
    ...browserSentryOptions(
      {
        dsn: "https://public@sentry.example/9",
        environment: "test",
        tracesSampleRate: 1,
      },
      router,
    ),
    transport: () => ({
      send: (envelope) => {
        record(envelope);
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("browser telemetry", () => {
  it("adds trace headers to this app's tRPC requests and to nothing else", async () => {
    await fetch("/api/trpc/workspaces.list?batch=1");
    await fetch("https://elsewhere.example/api/trpc/workspaces.list");

    const own = fetched.find((request) => request.url.startsWith("/api/trpc"));
    const other = fetched.find((request) => request.url.startsWith("https://elsewhere.example"));
    expect(own?.headers.get("traceparent")).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-0[01]$/);
    expect(other?.headers.has("traceparent")).toBe(false);
    expect(other?.headers.has("sentry-trace")).toBe(false);
  });

  it("sends the page load as a transaction named by URL template, not route ID", async () => {
    getActiveSpan()?.end();
    await flush();

    const [transaction] = sentOfType("transaction");
    expect(transaction).toContain('"transaction":"/workspaces/$workspaceId"');
    expect(transaction).not.toContain("_authenticated");
  });

  it("reports a caught error once, and skips redirects", async () => {
    const error = new Error("boundary failure");
    reportCaughtError(error, { componentStack: "\n    at Page" });
    reportCaughtError(error, { componentStack: "\n    at Layout" });
    reportCaughtError(redirect({ to: "/" }), {});
    await flush();

    expect(errorEventsSaying("boundary failure")).toBe(1);
    expect(sentOfType("event").some((event) => event.includes("Redirect"))).toBe(false);
  });

  it("reports a recovered render error only when its cause was not reported already", async () => {
    const reportedFirst = new Error("server render failure");
    reportCaughtError(reportedFirst, {});
    reportRecoverableError(new Error("React recovered", { cause: reportedFirst }), {});
    reportRecoverableError(
      new Error("React recovered", { cause: new Error("hydration mismatch") }),
      {},
    );
    await flush();

    expect(errorEventsSaying("server render failure")).toBe(1);
    expect(errorEventsSaying("hydration mismatch")).toBe(1);
  });

  it("sends no canary planted in the URL, a request URL or an error message", async () => {
    addBreadcrumb({
      category: "fetch",
      data: { url: `https://web.example/api/trpc/x?input=${CANARY_QUERY}`, method: "GET" },
    });
    addBreadcrumb({
      category: "navigation",
      data: { from: "/login", to: `/reset-password?token=${CANARY_QUERY}` },
    });
    captureException(
      new Error(`request failed: Authorization: Bearer ${CANARY_TOKEN}, token=${CANARY_QUERY}`),
    );
    await flush();

    const text = sentText();
    expect(text).toContain("request failed");
    expect(text).not.toContain(CANARY_TOKEN);
    expect(text).not.toContain(CANARY_QUERY);
  });
});
