/**
 * What a process with telemetry on hands its transports: the OTLP trace and log exporters and the
 * Sentry client. A real Effect HTTP server is run under `observedLive` with both pointed at a local
 * collector that records every body it is sent. A canary secret is planted in the request (its
 * query and its authorization header), in an environment variable a handler logs, and in the
 * message of the error the handler dies with (as a credential, and as a failed query's bound value). The canary must reach no body; the trace and the
 * error must still arrive, the error carrying the request's trace.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";

import { observabilitySettingFromEnv } from "./config.js";
import { observedLive } from "./layer.js";
import { withSentryTraceFallback } from "./trace-context.js";

const CANARY = "canary-5c1e-ddb3-4f0a-secret";
const ENV_NAME = "SEALANT_OBSERVED_TEST_GITHUB_TOKEN";

interface Received {
  readonly path: string;
  readonly body: string;
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
  delete process.env[ENV_NAME];
});

/** A collector that answers 200 to everything and keeps what it was sent. */
const startCollector = async () => {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      received.push({ path: request.url ?? "", body });
      return response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  const port = await listen(server);
  disposers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { port, received };
};

/** The app under test: one route that logs the environment's token and then dies. */
const app = HttpRouter.use((router) =>
  router.add(
    "GET",
    "/workspaces/:id",
    Effect.gen(function* () {
      yield* Effect.logInfo("resolving the workspace", { [ENV_NAME]: process.env[ENV_NAME] });
      return yield* Effect.die(
        new Error(
          // A credential, and a failed query's bound values as Drizzle quotes them (user data).
          `GitHub refused: Authorization: Bearer ${CANARY} (token=${CANARY})\nparams: ${CANARY},25`,
        ),
      );
    }).pipe(Effect.withSpan("sealant.workspace.lookup")),
  ),
);

const run = async (env: Record<string, string>) => {
  const setting = observabilitySettingFromEnv(env, { serviceName: "sealant-api" });
  let server: Server | undefined;
  const layer = HttpRouter.serve(app).pipe(
    Layer.provide(
      NodeHttpServer.layer(() => (server = withSentryTraceFallback(createServer())), { port: 0 }),
    ),
    Layer.provide(observedLive(setting)),
  );
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const address = server?.address();
  if (typeof address !== "object" || address === null) throw new Error("expected a TCP address");
  return {
    request: async (path: string, headers: Record<string, string>) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
      await response.text();
      return response.status;
    },
    /** Shut the server down: every exporter flushes what it holds. */
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

describe("a server with telemetry on", () => {
  it("sends its trace, logs and error, and the canary reaches none of them", async () => {
    const collector = await startCollector();
    process.env[ENV_NAME] = CANARY;
    const server = await run({
      SENTRY_DSN: `http://0123456789abcdef@127.0.0.1:${collector.port}/2`,
      SENTRY_ENVIRONMENT: "test",
    });

    const status = await server.request(`/workspaces/wks_1?token=${CANARY}`, {
      authorization: `Bearer ${CANARY}`,
      "sentry-trace": `${TRACE_ID}-00f067aa0ba902b7-1`,
    });
    await server.stop();

    expect(status).toBe(500);
    const at = (path: string) => collector.received.filter((item) => item.path.startsWith(path));
    const traces = at("/api/2/integration/otlp/v1/traces");
    const logs = at("/api/2/integration/otlp/v1/logs");
    const events = at("/api/2/envelope/");
    expect(traces.length).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    expect(events.length).toBe(1);

    // The caller's trace continued (from `sentry-trace`), and the error names the span it died in.
    expect(traces.map((item) => item.body).join("")).toContain(TRACE_ID);
    expect(events[0]?.body).toContain(`"trace_id":"${TRACE_ID}"`);
    expect(events[0]?.body).toContain("GitHub refused");
    expect(logs.map((item) => item.body).join("")).toContain("resolving the workspace");

    for (const item of collector.received) expect(item.body).not.toContain(CANARY);
  });

  it("makes no network call when no DSN is set", async () => {
    const collector = await startCollector();
    const server = await run({
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
    });
    await server.request("/workspaces/wks_1", {});
    await server.stop();
    expect(collector.received).toEqual([]);
  });
});
