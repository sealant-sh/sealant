/**
 * No credential in a URL reaches a tracing span. The terminal attach, the output stream and the port
 * forward take their bearer as `?token=` (browser clients cannot set headers); each is served here
 * as the API serves it, through the router with its request tracer, a tracer recording every span
 * attribute beneath the redaction, and the credential configured as a service key so the request
 * authenticates. A service key is configured before the dynamic imports because runtime-env parses
 * process.env at module load.
 */
import {
  AccessTokenRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceSessionRepo,
} from "@sealant/db";
import { TelemetryQuery } from "@sealant/telemetry";
import { SealantRuntime } from "@sealant/workspaces";
import { Effect, Layer, Tracer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const MARKER = "slt_review347-query-credential-marker";

process.env["SEALANT_SERVICE_KEYS"] = MARKER;

let routes: Layer.Layer<never, never, HttpRouter.HttpRouter>;
let redaction: typeof import("./url-credential-redaction.js");

beforeAll(async () => {
  const [{ SessionAttachRoute }, { SessionOutputStreamRoute }, { WorkspaceForwardRoute }] =
    await Promise.all([
      import("../routes/sessions/sessions.ws.js"),
      import("../routes/sessions/sessions.sse.js"),
      import("../routes/workspaces/workspaces.ws.js"),
    ]);
  redaction = await import("./url-credential-redaction.js");
  // Nothing exists: each route authenticates, then answers that the resource is missing.
  const missing = Layer.mergeAll(
    Layer.succeed(WorkspaceSessionRepo, {
      getSessionById: () => Effect.succeed(undefined),
    } as never),
    Layer.succeed(WorkspaceRepo, { getWorkspaceById: () => Effect.succeed(undefined) } as never),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {} as never),
    Layer.succeed(TelemetryQuery, {} as never),
    Layer.succeed(SealantRuntime, {} as never),
    Layer.succeed(AccessTokenRepo, {} as never),
  );
  routes = Layer.mergeAll(SessionAttachRoute, SessionOutputStreamRoute, WorkspaceForwardRoute).pipe(
    HttpRouter.provideRequest(missing),
  ) as Layer.Layer<never, never, HttpRouter.HttpRouter>;
});

/** Every attribute of every ended span, as `key=value` lines. */
const recordingTracer = (attributes: string[]) =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        for (const [key, value] of span.attributes) attributes.push(`${key}=${String(value)}`);
        end(endTime, exit);
      };
      return span;
    },
  });

let disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.map((dispose) => dispose()));
  disposers = [];
});

const serve = (redacted: boolean) => {
  const attributes: string[] = [];
  const recording = Layer.succeed(Tracer.Tracer, recordingTracer(attributes));
  const tracer = redacted
    ? redaction.UrlCredentialRedactionLive.pipe(Layer.provide(recording))
    : recording;
  const { handler, dispose } = HttpRouter.toWebHandler(Layer.mergeAll(routes, tracer));
  disposers.push(dispose);
  const get = async (path: string) => {
    const response = await handler(new Request(`http://localhost${path}`));
    await response.text();
    // The request's span ends in a task scheduled after the response.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response.status;
  };
  return { get, attributes };
};

const browserRoutes = [
  ["the terminal attach", `/v1/sessions/sess_1/attach?from=0&ownerUserId=usr_1&token=${MARKER}`],
  [
    "the output stream",
    `/v1/sessions/sess_1/output/stream?from=0&ownerUserId=usr_1&token=${MARKER}`,
  ],
  ["the port forward", `/v1/workspaces/wks_1/forward?port=8080&ownerUserId=usr_1&token=${MARKER}`],
] as const;

describe("a credential in a request's URL", () => {
  for (const [name, path] of browserRoutes) {
    it(`on ${name}: authenticates, and no span attribute carries it`, async () => {
      const server = serve(true);
      expect(await server.get(path)).toBe(404);
      const recorded = server.attributes.join("\n");
      expect(recorded).toContain("url.full=");
      expect(recorded).toContain("token=REDACTED");
      expect(recorded).not.toContain(MARKER);
    });
  }

  it("reaches the span without the redaction (what the test guards)", async () => {
    const server = serve(false);
    expect(await server.get(browserRoutes[0][1])).toBe(404);
    expect(server.attributes.join("\n")).toContain(MARKER);
  });
});

describe("redactUrlCredentials", () => {
  it("replaces credential parameters and userinfo, and keeps the rest", () => {
    expect(
      redaction.redactUrlCredentials(
        "https://user:pw@example.com/v1/sessions/s/attach?from=7&token=abc&Access_Token=def&ticket=t",
      ),
    ).toBe(
      "https://REDACTED:REDACTED@example.com/v1/sessions/s/attach?from=7&token=REDACTED&Access_Token=REDACTED&ticket=REDACTED",
    );
    expect(redaction.redactQueryCredentials("port=8080&%74oken=abc&host=x")).toBe(
      "port=8080&%74oken=REDACTED&host=x",
    );
    expect(redaction.redactUrlCredentials("not a url")).toBe("not a url");
  });
});
