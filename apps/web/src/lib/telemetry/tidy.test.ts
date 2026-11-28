import type { Event } from "@sentry/react";
import { describe, expect, it } from "vitest";

import { nameByUrlTemplate, templateUrlPath, tidyTransaction, urlTemplate } from "./tidy";

type SpanJson = NonNullable<Event["spans"]>[number];

const span = (op: string, description: string, seconds = 0.01): SpanJson => ({
  op,
  description,
  span_id: "a1b2c3d4e5f60718",
  trace_id: "0af7651916cd43dd8448eb211c80319c",
  start_timestamp: 100,
  timestamp: 100 + seconds,
  data: {},
  origin: "auto.resource.browser.metrics",
  status: "ok",
});

describe("tidyTransaction", () => {
  it("drops the static bundle's quick loads and keeps the page's own work", () => {
    const tidied = tidyTransaction({
      type: "transaction",
      spans: [
        span("resource.css", "/assets/inter-latin-400-normal-C38fXH4l.woff2"),
        span("resource.other", "/assets/react-DF-Glrvw.js"),
        span("resource.link", "https://app.sealant.dev/assets/styles-U7WYlO77.css"),
        span("resource.other", "/assets/workspace-page-C7ESOvtk.js", 2.5),
        span("http.client", "GET /api/trpc/workspaces.get"),
        span("browser.request", "https://app.sealant.dev/workspaces"),
      ],
    });
    expect(tidied.spans?.map((kept) => kept.description)).toEqual([
      "/assets/workspace-page-C7ESOvtk.js",
      "GET /api/trpc/workspaces.get",
      "https://app.sealant.dev/workspaces",
    ]);
  });

  it("describes a request by its templated path", () => {
    const tidied = tidyTransaction({
      type: "transaction",
      spans: [span("http.client", "GET /api/workspaces/ws_3f9a8b7c6d5e/runs/42")],
    });
    expect(tidied.spans?.[0]?.description).toBe("GET /api/workspaces/*/runs/*");
  });
});

describe("templateUrlPath", () => {
  it("keeps the origin and templates only the path", () => {
    expect(templateUrlPath("https://api.sealant.dev/v1/sessions/sess_01JDCE5Q2Z8Y/output")).toBe(
      "https://api.sealant.dev/v1/sessions/*/output",
    );
    expect(templateUrlPath("/api/trpc/runs.list")).toBe("/api/trpc/runs.list");
  });
});

const transaction = (name: string, op: string): Event => ({
  type: "transaction",
  transaction: name,
  contexts: {
    trace: {
      op,
      span_id: "a1b2c3d4e5f60718",
      trace_id: "0af7651916cd43dd8448eb211c80319c",
      data: { "url.template": name },
    },
  },
});

describe("nameByUrlTemplate", () => {
  const templates: Record<string, string> = {
    "/_authenticated/workspaces/": "/workspaces",
    "/_auth/login": "/login",
  };
  const templateOf = (routeId: string) => templates[routeId];
  it("names a page load or navigation by its URL template", () => {
    for (const op of ["pageload", "navigation"]) {
      const named = nameByUrlTemplate(transaction("/_authenticated/workspaces/", op), templateOf);
      expect(named.transaction).toBe("/workspaces");
      expect(named.contexts?.trace?.data?.["url.template"]).toBe("/workspaces");
    }
  });

  it("leaves other transactions alone", () => {
    const request = transaction("/_auth/login", "http.server");
    expect(nameByUrlTemplate(request, templateOf)).toBe(request);
  });

  it("templates the raw pathname of a page no route matched", () => {
    const unmatched = transaction("/workspaces/ws_3f9a8b7c6d/typo", "pageload");
    expect(nameByUrlTemplate(unmatched, templateOf).transaction).toBe("/workspaces/*/typo");
    const plain = transaction("/nowhere", "navigation");
    expect(nameByUrlTemplate(plain, templateOf)).toBe(plain);
  });

  it("drops an index route's trailing slash", () => {
    expect(urlTemplate("/workspaces/")).toBe("/workspaces");
    expect(urlTemplate("/workspaces/$workspaceId")).toBe("/workspaces/$workspaceId");
    expect(urlTemplate("/")).toBe("/");
  });
});
