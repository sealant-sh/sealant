import { describe, expect, it } from "vitest";

import { traceHeadersFrom } from "./trace-headers";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("traceHeadersFrom", () => {
  it("passes on the trace context and nothing else from the request", () => {
    const headers = new Headers({
      traceparent: TRACEPARENT,
      tracestate: "vendor=value",
      "sentry-trace": "4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1",
      baggage:
        "sentry-trace_id=4bf92f3577b34da6a3ce929d0e0e4736,user.email=a@b.example,sentry-sampled=true",
      cookie: "better-auth.session_token=secret",
      authorization: "Bearer secret",
    });

    expect(traceHeadersFrom(headers)).toEqual({
      traceparent: TRACEPARENT,
      tracestate: "vendor=value",
      "sentry-trace": "4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1",
      baggage: "sentry-trace_id=4bf92f3577b34da6a3ce929d0e0e4736,sentry-sampled=true",
    });
  });

  it.each([
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
    "garbage",
  ])("drops a malformed traceparent %s, and its tracestate with it", (traceparent) => {
    expect(traceHeadersFrom(new Headers({ traceparent, tracestate: "vendor=value" }))).toEqual({});
  });

  it("drops baggage with no sentry- members", () => {
    expect(traceHeadersFrom(new Headers({ baggage: "user.id=42" }))).toEqual({});
  });
});
