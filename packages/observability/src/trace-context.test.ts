import { Effect, Layer, Tracer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";

import { UntracedProbesLive } from "./trace-context.js";

const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

/** A tracer that keeps the name and parent of every span it starts. */
const recordingTracer = () => {
  const started: Array<{ readonly name: string; readonly traceId: string }> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = Tracer.nativeTracer.span(options);
      started.push({ name: span.name, traceId: span.traceId });
      return span;
    },
  });
  return { started, tracer };
};

const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/healthz", Effect.succeed(HttpServerResponse.text("ok")));
    yield* router.add("GET", "/readyz", Effect.succeed(HttpServerResponse.text("ok")));
    yield* router.add("GET", "/v1/workspaces", Effect.succeed(HttpServerResponse.text("[]")));
  }),
);

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

/** The routes as a web handler under {@link UntracedProbesLive} and a recording tracer. */
const serve = () => {
  const { started, tracer } = recordingTracer();
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(routes, UntracedProbesLive, Layer.succeed(Tracer.Tracer, tracer)),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await handler(new Request(`http://localhost${path}`, { headers }));
    expect(response.status).toBe(200);
  };
  return { started, get };
};

describe("UntracedProbesLive", () => {
  it("starts no trace for a health or readiness poll that continues none", async () => {
    const { started, get } = serve();
    await get("/healthz");
    await get("/readyz?verbose=1");
    expect(started).toEqual([]);
  });

  it("traces a probe that carries a trace, and every other request", async () => {
    const { started, get } = serve();
    await get("/healthz", { traceparent: TRACEPARENT });
    await get("/v1/workspaces");
    expect(started.map((span) => span.name)).toEqual(["GET", "GET"]);
    expect(started[0]?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
  });
});
