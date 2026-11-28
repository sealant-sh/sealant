import { createServer, type IncomingHttpHeaders } from "node:http";

import { Effect, Layer, Tracer } from "effect";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServerResponse } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";

import { observedLive } from "./layer.js";
import {
  callingFiberTraceparent,
  currentTraceCarrier,
  UntracedProbesLive,
} from "./trace-context.js";

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

/** A server that keeps the headers of every request it is sent. */
const startUpstream = async () => {
  const received: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    received.push(request.headers);
    response.writeHead(200).end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  disposers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/`, received };
};

describe("telemetry off", () => {
  /**
   * A request handled under `observability`: it calls another service over HTTP, and reads the
   * carriers a queued job and a sealantd control request would carry.
   */
  const handle = async (observability: Layer.Layer<never>) => {
    const upstream = await startUpstream();
    const { started, tracer } = recordingTracer();
    const carriers: unknown[] = [];
    const callingRoutes = HttpRouter.use((router) =>
      router.add(
        "GET",
        "/v1/runs/:runId",
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          yield* client.get(upstream.url);
          carriers.push(yield* currentTraceCarrier, yield* Effect.sync(callingFiberTraceparent));
          return HttpServerResponse.text("ok");
        }).pipe(Effect.withSpan("sealant.run.read"), Effect.provide(FetchHttpClient.layer)),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.mergeAll(callingRoutes, observability, Layer.succeed(Tracer.Tracer, tracer)),
      { disableLogger: true },
    );
    disposers.push(dispose);
    const response = await handler(
      new Request("http://localhost/v1/runs/run_1", { headers: { traceparent: TRACEPARENT } }),
    );
    expect(response.status).toBe(200);
    return { started, carriers, sent: upstream.received };
  };

  it("makes no span and sends no trace context, even when a caller's trace arrives", async () => {
    const { started, carriers, sent } = await handle(observedLive({ kind: "off" }));
    expect(started).toEqual([]);
    expect(carriers).toEqual([undefined, undefined]);
    expect(sent.map((headers) => [headers.traceparent, headers.b3])).toEqual([
      [undefined, undefined],
    ]);
  });

  it("with an exporting tracer, the same request is traced and carries its trace", async () => {
    const { started, carriers, sent } = await handle(Layer.empty);
    expect(started.length).toBeGreaterThan(0);
    expect(carriers).toEqual([
      { traceparent: expect.stringContaining("0af7651916cd43dd8448eb211c80319c") },
      expect.stringContaining("0af7651916cd43dd8448eb211c80319c"),
    ]);
    expect(sent[0]?.traceparent).toContain("0af7651916cd43dd8448eb211c80319c");
  });
});
