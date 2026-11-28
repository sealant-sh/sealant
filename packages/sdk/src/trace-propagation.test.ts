import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";

import { Effect, Layer, Option, References, Tracer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { getWorkspaceOp, resolveInternalConfig, sealantApiClientLayer } from "./effect/index.js";
import { opencode, Sealant, type SealantConfig } from "./index.js";

const now = "2026-11-25T00:00:00.000Z";
const workspace = (status: string) => ({
  workspaceId: "ws_1",
  name: "test",
  ownerUserId: "alice",
  status,
  createdAt: now,
  updatedAt: now,
  spec: { harness: { id: "codex" } },
});
const sessionWire = {
  sessionId: "ses_1",
  workspaceId: "ws_1",
  runId: "run_1",
  ownerUserId: "alice",
  status: "running",
  argv: ["sh"],
  cols: 80,
  rows: 24,
  outputHighWater: "0",
  createdAt: now,
};

const json = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

interface Received {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A control plane that records each request's headers; `ws_1` is ready after `readyAfter` reads. */
const serve = async (config: Partial<SealantConfig> = {}, readyAfter = 0) => {
  const received: Received[] = [];
  let workspaceReads = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    received.push({ path, headers: request.headers });
    request.resume();
    request.on("end", () => {
      if (path === "/v1/workspaces" && request.method === "POST")
        return json(
          response,
          {
            workspaceId: "ws_1",
            name: "test",
            status: "queued",
            registryId: "default",
            repository: "fixture",
            tag: "latest",
          },
          202,
        );
      if (path === "/v1/workspaces/ws_1") {
        workspaceReads += 1;
        return json(response, workspace(workspaceReads > readyAfter ? "ready" : "queued"));
      }
      if (path === "/v1/sessions/ses_1") return json(response, sessionWire);
      if (path === "/v1/sessions/ses_1/output/stream") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("event: output\nid: 1\ndata: aGk=\n\nevent: end\ndata: {}\n\n");
        return;
      }
      if (path.endsWith("/exec"))
        return json(response, {
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: false,
          timedOut: false,
        });
      if (path.endsWith("/backup")) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end("tar");
        return;
      }
      return json(response, { _tag: "WorkspaceNotFoundError", message: "no route" }, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("expected TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new Sealant({ baseUrl, apiKey: "key", ownerUserId: "alice", ...config });
  closers.push(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseUrl, client, received };
};

/** The trace id and parent span id a request's `traceparent` names. */
const traceparentOf = (received: Received | undefined) => {
  const header = received?.headers.traceparent;
  if (typeof header !== "string") return undefined;
  const [, traceId, spanId] = header.split("-");
  return { traceId, spanId };
};

/** Run `f` inside an Effect span, the way an Effect caller calls the Promise facade. */
const inSpan = <A>(f: () => Promise<A>, tracer?: Tracer.Tracer) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan;
      const value = yield* Effect.promise(f);
      return { span, value };
    }).pipe(
      Effect.withSpan("caller.operation"),
      tracer === undefined ? (effect) => effect : Effect.provideService(Tracer.Tracer, tracer),
    ),
  );

/** A tracer that exports: it keeps every span it makes. */
const recordingTracer = () => {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { tracer, spans };
};

describe("SDK calls continue the caller's trace", () => {
  it("a contract call inside an Effect span carries that span as its parent", async () => {
    const s = await serve();
    const { span } = await inSpan(() => s.client.workspaces.get("ws_1"));
    expect(traceparentOf(s.received[0])).toEqual({ traceId: span.traceId, spanId: span.spanId });
  });

  it("with an exporting tracer, names the SDK's client span and parents the request under it", async () => {
    const s = await serve();
    const { tracer, spans } = recordingTracer();
    const { span } = await inSpan(() => s.client.workspaces.get("ws_1"), tracer);

    const sdkSpan = spans.find((made) => made.name === "sealant.sdk.workspaces.get_workspace");
    expect(sdkSpan).toBeDefined();
    expect(sdkSpan?.kind).toBe("client");
    expect(Option.getOrUndefined(sdkSpan?.parent ?? Option.none())?.spanId).toBe(span.spanId);
    expect(Object.fromEntries(sdkSpan?.attributes ?? [])).toEqual({
      "sealant.workspace_id": "ws_1",
      "sentry.op": "sealant.sdk",
      "sentry.description": "get workspace",
      "code.function.name": "sealant.sdk.workspaces.get_workspace",
    });
    // The header names a span the tracer made under the SDK's span, in the caller's trace.
    const wire = traceparentOf(s.received[0]);
    const httpSpan = spans.find((made) => made.spanId === wire?.spanId);
    expect(wire?.traceId).toBe(span.traceId);
    expect(Option.getOrUndefined(httpSpan?.parent ?? Option.none())?.spanId).toBe(sdkSpan?.spanId);
    // Sentry describes the request by the endpoint's route, never by the IDs in its URL.
    expect(httpSpan?.attributes.get("url.template")).toBe("/v1/workspaces/:workspaceId");
    expect(httpSpan?.attributes.get("sentry.description")).toBe("GET /v1/workspaces/:workspaceId");
  });

  it("hands an exporting tracer no credential or body", async () => {
    const canary = "slt_canary_9f2c41d7";
    const s = await serve({ apiKey: canary });
    const { tracer, spans } = recordingTracer();
    await inSpan(() => s.client.workspaces.get("ws_1"), tracer);
    expect(s.received[0]?.headers.authorization).toBe(`Bearer ${canary}`);
    const exported = JSON.stringify(
      spans.map((made) => ({ name: made.name, attributes: Object.fromEntries(made.attributes) })),
    );
    expect(exported).not.toContain(canary);
    expect(exported).not.toContain("harness");
  });

  it("sends no trace header when there is no parent and no explicit context", async () => {
    const s = await serve();
    await s.client.workspaces.get("ws_1");
    expect(s.received[0]?.headers.traceparent).toBeUndefined();
    expect(s.received[0]?.headers.b3).toBeUndefined();
  });

  it("continues the configured traceContext, tracestate included", async () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const s = await serve({ traceContext: () => ({ traceparent, tracestate: "vendor=a1" }) });
    await s.client.workspaces.get("ws_1");
    expect(s.received[0]?.headers.traceparent).toBe(traceparent);
    expect(s.received[0]?.headers.tracestate).toBe("vendor=a1");
  });

  it("ignores a malformed traceContext instead of sending it", async () => {
    const s = await serve({ traceContext: () => ({ traceparent: "00-not-a-trace-01" }) });
    await s.client.workspaces.get("ws_1");
    expect(s.received[0]?.headers.traceparent).toBeUndefined();
  });

  it("continues the active OpenTelemetry span when @opentelemetry/api is registered", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const spanKey = Symbol.for("OpenTelemetry Context Key SPAN");
    const apiKey = Symbol.for("opentelemetry.js.api.1");
    const span = { spanContext: () => ({ traceId, spanId, traceFlags: 1 }) };
    const active = { getValue: (key: symbol) => (key === spanKey ? span : undefined) };
    Reflect.set(globalThis, apiKey, { version: "1.9.0", context: { active: () => active } });
    try {
      const s = await serve();
      await s.client.workspaces.get("ws_1");
      expect(s.received[0]?.headers.traceparent).toBe(`00-${traceId}-${spanId}-01`);
    } finally {
      Reflect.deleteProperty(globalThis, apiKey);
    }
  });

  it("keeps create's readiness polls in the trace create was called in", async () => {
    const s = await serve({}, 2);
    const { span } = await inSpan(() =>
      s.client.workspaces.create({
        repository: "github.com/sealant-sh/fixture",
        harness: opencode(),
      }),
    );
    const traced = s.received.map((request) => traceparentOf(request)?.traceId);
    expect(s.received.filter((request) => request.path === "/v1/workspaces/ws_1").length).toBe(3);
    expect(traced).toEqual(s.received.map(() => span.traceId));
  });

  it("sends the caller's trace on the session output stream", async () => {
    const s = await serve();
    const session = await (await s.client.workspaces.get("ws_1")).sessions.get("ses_1");
    const { span } = await inSpan(async () => {
      const chunks = [];
      for await (const chunk of session.output()) chunks.push(chunk);
      return chunks;
    });
    const stream = s.received.find((request) => request.path.endsWith("/output/stream"));
    expect(traceparentOf(stream)).toEqual({ traceId: span.traceId, spanId: span.spanId });
  });

  it("sends the caller's trace on resource exec and backup", async () => {
    const s = await serve();
    const instances = s.client.scopes.actAs("rdm:project").instances;
    const exec = await inSpan(() => instances.exec("db", { argv: ["true"] }));
    const backup = await inSpan(() => instances.backup("db", "data"));
    const execRequest = s.received.find((request) => request.path.endsWith("/exec"));
    const backupRequest = s.received.find((request) => request.path.endsWith("/backup"));
    expect(traceparentOf(execRequest)?.traceId).toBe(exec.span.traceId);
    expect(traceparentOf(backupRequest)?.traceId).toBe(backup.span.traceId);
  });

  it("sends contract calls through the configured fetch", async () => {
    const seen: string[] = [];
    const s = await serve({
      fetch: (input, init) => {
        seen.push(input instanceof Request ? input.url : String(input));
        return fetch(input, init);
      },
    });
    await s.client.workspaces.get("ws_1");
    expect(seen).toEqual([`${s.baseUrl}/v1/workspaces/ws_1?ownerUserId=alice`]);
  });

  it("an Effect caller composing operations directly continues its own span", async () => {
    const s = await serve();
    const layer = sealantApiClientLayer(resolveInternalConfig({ baseUrl: s.baseUrl }));
    const span = await Effect.runPromise(
      Effect.gen(function* () {
        const current = yield* Effect.currentSpan;
        yield* getWorkspaceOp("ws_1");
        return current;
      }).pipe(Effect.withSpan("caller.operation"), Effect.provide(layer)),
    );
    expect(traceparentOf(s.received[0])).toEqual({ traceId: span.traceId, spanId: span.spanId });
  });

  it("sends no trace header for a caller that turned tracing and propagation off", async () => {
    const s = await serve();
    const layer = sealantApiClientLayer(resolveInternalConfig({ baseUrl: s.baseUrl }));
    // How Mend runs with telemetry off: every span is disabled, its IDs `noop`.
    const off = Layer.mergeAll(
      Layer.succeed(References.TracerEnabled, false),
      Layer.succeed(Tracer.DisablePropagation, true),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() => s.client.workspaces.get("ws_1"));
        yield* getWorkspaceOp("ws_1");
      }).pipe(Effect.withSpan("caller.operation"), Effect.provide(layer), Effect.provide(off)),
    );
    expect(s.received).toHaveLength(2);
    for (const received of s.received) {
      expect(received.headers.traceparent).toBeUndefined();
      expect(received.headers.b3).toBeUndefined();
    }
  });

  it("never sends a disabled span as a parent, even with propagation left on", async () => {
    const s = await serve();
    const layer = sealantApiClientLayer(resolveInternalConfig({ baseUrl: s.baseUrl }));
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() => s.client.workspaces.get("ws_1"));
        yield* getWorkspaceOp("ws_1");
      }).pipe(
        // Tracing on, the caller's parent a disabled span (what a disabled region leaves behind).
        Effect.withParentSpan(
          Tracer.externalSpan({ traceId: "noop", spanId: "noop", sampled: false }),
        ),
        Effect.provide(layer),
      ),
    );
    expect(s.received).toHaveLength(2);
    for (const received of s.received) {
      expect(received.headers.traceparent).toBeUndefined();
      expect(received.headers.b3).toBeUndefined();
    }
  });
});
