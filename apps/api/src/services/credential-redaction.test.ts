/**
 * No credential the API receives or sends reaches a span, a log line or an error report. Each case
 * is served as the API serves it (the router with its request tracer and request logger), with a
 * tracer recording every span attribute, event and ending failure, a logger recording every line
 * and cause, and an error reporter recording every cause, all beneath `CredentialRedactionLive`.
 * Each has a control without the redaction, showing the credential does reach them there. The
 * credentials are configured as a service key and as the SSH gateway's token, so every request
 * authenticates; they are set before the dynamic imports because runtime-env parses process.env at
 * module load.
 */
import {
  ControlPlaneAPI,
  RequestRefusal,
  type ResolveSshPrincipalRequest,
} from "@sealant/api-contracts";
import {
  AccessTokenRepo,
  SshKeyRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceSessionRepo,
} from "@sealant/db";
import { TelemetryQuery } from "@sealant/telemetry";
import { SealantRuntime } from "@sealant/workspaces";
import { Cause, Effect, ErrorReporter, Exit, Layer, Logger, Tracer } from "effect";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { type HttpApi, HttpApiBuilder, type HttpApiGroup } from "effect/unstable/httpapi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const MARKER = "slt_review347-query-credential-marker";
const GATEWAY_MARKER = "review347-gateway-credential-marker";

process.env["SEALANT_SERVICE_KEYS"] = MARKER;
process.env["WORKSPACE_SSH_GATEWAY_TOKEN"] = GATEWAY_MARKER;

let redaction: typeof import("./credential-redaction.js");
let browserRoutes: Layer.Layer<never, never, HttpRouter.HttpRouter>;
let sshKeysHandlers: Layer.Layer<never>;

const OWNER = "usr_1";

/** A running session on a ready executor: the attach route reaches its socket upgrade. */
const present = Layer.mergeAll(
  Layer.succeed(WorkspaceSessionRepo, {
    getSessionById: (id: string) =>
      Effect.succeed(
        id === "sess_live"
          ? {
              id,
              workspaceId: "wks_1",
              runId: "run_2",
              ownerUserId: OWNER,
              status: "running",
              daemonSessionId: "dsess_1",
              daemonProcessId: "proc_1",
            }
          : undefined,
      ),
  } as never),
  Layer.succeed(WorkspaceRepo, {
    getWorkspaceById: (id: string) =>
      Effect.succeed(id === "wks_1" ? { id, ownerUserId: OWNER, latestRunId: "run_1" } : undefined),
  } as never),
  Layer.succeed(WorkspaceRuntimeInstanceRepo, {
    getRuntimeInstanceByRunId: () =>
      Effect.succeed({
        runId: "run_1",
        status: "ready",
        adapter: "docker",
        resourceId: "container-1",
        reference: "container-1",
        endpoint: null,
      }),
  } as never),
  Layer.succeed(TelemetryQuery, {} as never),
  Layer.succeed(SealantRuntime, {} as never),
  Layer.succeed(AccessTokenRepo, {} as never),
);

type ControlPlaneGroups =
  typeof ControlPlaneAPI extends HttpApi.HttpApi<string, infer G> ? G : never;

beforeAll(async () => {
  const [ws, sse, forward, sshKeys] = await Promise.all([
    import("../routes/sessions/sessions.ws.js"),
    import("../routes/sessions/sessions.sse.js"),
    import("../routes/workspaces/workspaces.ws.js"),
    import("../routes/ssh-keys/ssh-keys.http-api.js"),
  ]);
  redaction = await import("./credential-redaction.js");
  browserRoutes = Layer.mergeAll(
    ws.SessionAttachRoute,
    sse.SessionOutputStreamRoute,
    forward.WorkspaceForwardRoute,
  ).pipe(HttpRouter.provideRequest(present)) as Layer.Layer<never, never, HttpRouter.HttpRouter>;
  // The real SSH key handlers, beside a stub for every other group of the API.
  const others = Object.entries(ControlPlaneAPI.groups)
    .filter(([name]) => name !== "sshKeys")
    .map(([name, group]) =>
      HttpApiBuilder.group(
        ControlPlaneAPI,
        name as never,
        (handlers) =>
          Object.keys(group.endpoints).reduce(
            (acc, endpoint) =>
              (acc as { handle: (n: string, h: unknown) => unknown }).handle(endpoint, () =>
                Effect.die("not under test"),
              ),
            handlers as unknown,
          ) as never,
      ),
    );
  sshKeysHandlers = Layer.mergeAll(
    sshKeys.SshKeysHandlersLive.pipe(
      Layer.provide(
        Layer.succeed(SshKeyRepo, {
          findActiveSshKeyByFingerprint: () => Effect.succeed(undefined),
        } as never),
      ),
    ),
    ...others,
  ) as unknown as Layer.Layer<never>;
});

/** The process's observers, each recording what it is given as text lines. */
const observers = (redacted: boolean) => {
  const lines: string[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const event = span.event.bind(span);
      const end = span.end.bind(span);
      span.event = (name, startTime, attributes) => {
        lines.push(`span event ${name} ${JSON.stringify(attributes ?? {})}`);
        event(name, startTime, attributes);
      };
      span.end = (endTime, exit) => {
        for (const [key, value] of span.attributes) lines.push(`span ${key}=${String(value)}`);
        if (Exit.isFailure(exit)) lines.push(`span failure ${Cause.pretty(exit.cause)}`);
        end(endTime, exit);
      };
      return span;
    },
  });
  const logger = Logger.make((options) => {
    lines.push(`log ${JSON.stringify(options.message)} ${Cause.pretty(options.cause)}`);
  });
  const reporter = ErrorReporter.make(({ cause }) => {
    lines.push(`report ${Cause.pretty(cause)}`);
  });
  const recording = Layer.mergeAll(
    Layer.succeed(Tracer.Tracer, tracer),
    Logger.layer([logger]),
    ErrorReporter.layer([reporter]),
  );
  const layer = redacted
    ? redaction.CredentialRedactionLive.pipe(Layer.provideMerge(recording))
    : recording;
  return { layer, lines };
};

let disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.map((dispose) => dispose()));
  disposers = [];
});

const serve = (app: Layer.Layer<never, never, HttpRouter.HttpRouter>, redacted: boolean) => {
  const observed = observers(redacted);
  const { handler, dispose } = HttpRouter.toWebHandler(Layer.mergeAll(app, observed.layer));
  disposers.push(dispose);
  const send = async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`http://localhost${path}`, init));
    await response.text();
    // The request's span ends in a task scheduled after the response.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response.status;
  };
  return { send, lines: observed.lines };
};

const sshApi = () =>
  HttpApiBuilder.layer(ControlPlaneAPI).pipe(
    Layer.provide(
      sshKeysHandlers as unknown as Layer.Layer<
        HttpApiGroup.ToService<"sealantControlPlaneApi", ControlPlaneGroups>
      >,
    ),
    Layer.provide(Layer.succeed(RequestRefusal, (httpEffect) => httpEffect)),
    Layer.provide(HttpServer.layerServices),
  );

const queryCredentialRoutes = [
  [
    "the terminal attach",
    `/v1/sessions/sess_gone/attach?from=0&ownerUserId=${OWNER}&token=${MARKER}`,
  ],
  [
    "the output stream",
    `/v1/sessions/sess_gone/output/stream?from=0&ownerUserId=${OWNER}&token=${MARKER}`,
  ],
  [
    "the port forward",
    `/v1/workspaces/wks_gone/forward?port=8080&ownerUserId=${OWNER}&token=${MARKER}`,
  ],
] as const;

describe("a credential in a request's URL", () => {
  for (const [name, path] of queryCredentialRoutes) {
    it(`on ${name}: authenticates, and no span attribute carries it`, async () => {
      const server = serve(browserRoutes, true);
      expect(await server.send(path)).toBe(404);
      const observed = server.lines.join("\n");
      expect(observed).toContain("url.full=");
      expect(observed).toContain("token=REDACTED");
      expect(observed).not.toContain(MARKER);
    });
  }

  it("is not in the failure an attach that is no WebSocket ends with, in any observer", async () => {
    const path = `/v1/sessions/sess_live/attach?from=0&ownerUserId=${OWNER}&token=${MARKER}`;
    const server = serve(browserRoutes, true);
    expect(await server.send(path)).toBeGreaterThanOrEqual(400);
    const observed = server.lines.join("\n");
    expect(observed).toContain("span failure");
    expect(observed).toContain("token=REDACTED");
    expect(observed).not.toContain(MARKER);

    // What the redaction guards: the same request quotes the credential in its failure.
    const control = serve(browserRoutes, false);
    await control.send(path);
    expect(control.lines.filter((line) => !line.startsWith("span url")).join("\n")).toContain(
      MARKER,
    );
  });
});

describe("a credential in a request header", () => {
  it("on the SSH gateway's key resolution: authenticates, and no span attribute carries it", async () => {
    const payload: ResolveSshPrincipalRequest = {
      algo: "ssh-ed25519",
      publicKeyBase64: Buffer.from("not a registered key").toString("base64"),
    };
    const request = () => ({
      method: "POST",
      headers: { "content-type": "application/json", "x-sealant-gateway-token": GATEWAY_MARKER },
      body: JSON.stringify(payload),
    });
    const server = serve(sshApi(), true);
    // Authenticated, then no such key.
    expect(await server.send("/v1/ssh-keys/resolve-principal", request())).toBe(404);
    const observed = server.lines.join("\n");
    expect(observed).toContain("http.request.header.x-sealant-gateway-token=REDACTED");
    expect(observed).not.toContain(GATEWAY_MARKER);

    const control = serve(sshApi(), false);
    await control.send("/v1/ssh-keys/resolve-principal", request());
    expect(control.lines.join("\n")).toContain(GATEWAY_MARKER);
  });
});

describe("a credential in an outgoing request's URL", () => {
  const failedRequest = (redacted: boolean) => {
    const observed = observers(redacted);
    return Effect.runPromiseExit(
      HttpClient.get(`http://127.0.0.1:1/control?token=${MARKER}`).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(observed.layer),
      ),
    ).then((exit) => ({ exit, lines: observed.lines }));
  };

  it("is not in the span a failed request ends with", async () => {
    const { exit, lines } = await failedRequest(true);
    expect(Exit.isFailure(exit)).toBe(true);
    const observed = lines.join("\n");
    expect(observed).toContain("span failure");
    expect(observed).not.toContain(MARKER);

    const control = await failedRequest(false);
    expect(control.lines.join("\n")).toContain(MARKER);
  });
});

describe("redactCredentialsInText", () => {
  it("replaces credential parameters, userinfo and bearer credentials, and keeps the rest", () => {
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
    expect(
      redaction.redactCredentialsInText(
        "RequestParseError (GET /v1/sessions/s/attach?ownerUserId=u&token=abc): not upgradeable; Authorization: Bearer slt_abc.def",
      ),
    ).toBe(
      "RequestParseError (GET /v1/sessions/s/attach?ownerUserId=u&token=REDACTED): not upgradeable; Authorization: Bearer REDACTED",
    );
    expect(
      redaction.redactCredentialsInText("git clone https://x-access-token:ghs_1@github.com/a/b"),
    ).toBe("git clone https://REDACTED:REDACTED@github.com/a/b");
  });
});
