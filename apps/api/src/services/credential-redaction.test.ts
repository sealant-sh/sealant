import { inspect } from "node:util";

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
import { ControlPlaneAPI, type ResolveSshPrincipalRequest } from "@sealant/api-contracts";
import {
  AccessTokenRepo,
  SshKeyRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceSessionRepo,
} from "@sealant/db";
import { TelemetryQuery } from "@sealant/telemetry";
import { SealantRuntime } from "@sealant/workspaces";
import { Cause, Context, Effect, ErrorReporter, Exit, Layer, Logger, Tracer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
} from "effect/unstable/http";
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

/**
 * A cause as every way an observer might render it: pretty, and its failures serialised and
 * inspected (a structured exporter keeps the objects, not the text).
 */
const structured = (cause: Cause.Cause<unknown>): string =>
  [
    Cause.pretty(cause),
    ...cause.reasons.flatMap((reason) => {
      const value = Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined;
      return [safeJson(value), inspect(value, { depth: 12, getters: true })];
    }),
  ].join("\n");

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch (error) {
    return String(error);
  }
};

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
        if (Exit.isFailure(exit)) lines.push(`span failure ${structured(exit.cause)}`);
        end(endTime, exit);
      };
      return span;
    },
  });
  const logger = Logger.make((options) => {
    lines.push(`log ${inspect(options.message, { depth: 12 })} ${structured(options.cause)}`);
  });
  const reporter = ErrorReporter.make(({ cause }) => {
    lines.push(`report ${structured(cause)}`);
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
      "RequestParseError (GET /v1/sessions/s/attach?ownerUserId=u&token=REDACTED): not upgradeable; Authorization: REDACTED",
    );
    expect(
      redaction.redactCredentialsInText("git clone https://x-access-token:ghs_1@github.com/a/b"),
    ).toBe("git clone https://REDACTED:REDACTED@github.com/a/b");
  });
});

/** Adversarial texts of about `bytes`: dotted, scheme-like, query-like, auth-like. */
const shapes = (bytes: number) => [
  `/${"a.".repeat(bytes / 2)}`,
  `/${"a.a://".repeat(bytes / 6)}`,
  `${"http://a".repeat(bytes / 8)}`,
  `?${"a&".repeat(bytes / 2)}`,
  `?${"a".repeat(bytes)}`,
  `${"bearer ".repeat(bytes / 7)}`,
  `${'bearer "'.repeat(bytes / 8)}`,
  `${"token: ".repeat(bytes / 7)}`,
  `${'a:"'.repeat(bytes / 3)}`,
  `${":\\/\\/".repeat(bytes / 5)}`,
  `x${"%3A%2F%2Fa".repeat(bytes / 10)}`,
  `${"a%40".repeat(bytes / 4)}`,
];

/** How long one `redactCredentialsInText` call takes, in milliseconds. */
const time = (text: string) => {
  const start = performance.now();
  redaction.redactCredentialsInText(text);
  return performance.now() - start;
};

describe("observe", () => {
  const SECRET = "review347-r5-secret-marker";
  const leaks = (value: unknown) =>
    [safeJson(value), inspect(value, { depth: 20, getters: true }), String(value)].some((text) =>
      text.includes(SECRET),
    );

  it("gives an HTTP error's request as plain, redacted data, never the live request", async () => {
    const serverError = new HttpServerError.HttpServerError({
      reason: new HttpServerError.RequestParseError({
        request: HttpServerRequest.fromWeb(
          new Request(`http://localhost/v1/sessions/s/attach?ownerUserId=u&token=${SECRET}`, {
            headers: { authorization: `Bearer ${SECRET}`, "x-sealant-gateway-token": SECRET },
          }),
        ),
        description: "not an upgradeable ServerRequest",
      }),
    });
    expect(leaks(serverError)).toBe(true);
    const copy = redaction.observe(serverError);
    // Observers get the plain form: its name and tag, never the class with its live request.
    expect(copy).toMatchObject({ name: "HttpServerError", _tag: "HttpServerError" });
    expectPlainData(copy);
    expect(leaks(copy)).toBe(false);
    expect(safeJson(copy)).toContain("token=REDACTED");

    const exit = await Effect.runPromiseExit(
      HttpClient.get(`http://127.0.0.1:1/control?token=${SECRET}`).pipe(
        Effect.provide(FetchHttpClient.layer),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error("expected the request to fail");
    const clientError = Cause.squash(exit.cause);
    expect(leaks(clientError)).toBe(true);
    expect(leaks(redaction.observe(clientError))).toBe(false);
    // The effect's own error is untouched.
    expect(leaks(clientError)).toBe(true);
  });

  it("redacts a repeated reference each time, and what lies too deep as a placeholder", () => {
    const shared = { url: `https://example.com/x?token=${SECRET}` };
    expect(leaks(redaction.observe([shared, shared, { again: shared }]))).toBe(false);
    let deep: unknown = { url: `https://example.com/x?token=${SECRET}` };
    for (let level = 0; level < 20; level++) deep = { level, deep };
    expect(leaks(redaction.observe(deep))).toBe(false);
    expect(safeJson(redaction.observe(deep))).toContain("nested too deep");
  });

  it("replaces a field whose name holds a credential, and keeps one that only mentions it", () => {
    expect(
      redaction.observe({
        "x-sealant-gateway-token": SECRET,
        accessToken: SECRET,
        client_secret: SECRET,
        tokenCount: 3,
        sessionId: "sess_1",
      }),
    ).toEqual({
      "x-sealant-gateway-token": "REDACTED",
      accessToken: "REDACTED",
      client_secret: "REDACTED",
      tokenCount: 3,
      sessionId: "sess_1",
    });
  });
});

describe("redactCredentialsInText", () => {
  it("replaces a bearer or basic credential in any case, bare, quoted or escaped", () => {
    const SECRET = "slt_r6_credential_marker";
    for (const scheme of ["Bearer", "bearer", "BEARER", "Basic", "basic"]) {
      expect(redaction.redactCredentialsInText(`sent ${scheme} ${SECRET}.b/c+d= to it`)).toBe(
        `sent ${scheme} REDACTED to it`,
      );
    }
    for (const text of [
      `Authorization: Bearer "${SECRET}"`,
      `Authorization: Bearer ${SECRET}`,
      `authorization='Bearer ${SECRET}'`,
      JSON.stringify({ authorization: `Bearer "${SECRET}"` }),
      JSON.stringify({ header: `Bearer "${SECRET}"` }),
      JSON.stringify(JSON.stringify({ authorization: `Bearer ${SECRET}` })),
      `{ 'x-sealant-gateway-token': '${SECRET}', other: 1 }`,
      `x-sealant-gateway-token=${SECRET}&page=2`,
      `cookie: session=${SECRET}`,
    ]) {
      expect(redaction.redactCredentialsInText(text), text).not.toContain(SECRET);
    }
    expect(redaction.redactCredentialsInText("tokenCount: 30, sessionId: sess_1")).toBe(
      "tokenCount: 30, sessionId: sess_1",
    );
  });

  it("replaces userinfo written plainly, with escaped slashes or percent-encoded", () => {
    const SECRET = "slt_r6_credential_marker";
    for (const text of [
      `https://user:${SECRET}@example.com/path`,
      `https:\\/\\/user:${SECRET}@example.com\\/path`,
      `https%3A%2F%2Fuser%3A${SECRET}%40example.com%2Fpath`,
      `next=https%3a%2f%2fuser%3a${SECRET}%40example.com`,
    ]) {
      const redacted = redaction.redactCredentialsInText(text);
      expect(redacted, text).not.toContain(SECRET);
      expect(redacted, text).toContain("example.com");
    }
  });

  it("costs linear time on adversarial text", () => {
    // Quadratic matching took 16-97 ms at 8 KiB and would take minutes at 1 MiB.
    for (const text of shapes(8 * 1024)) expect(time(text)).toBeLessThan(25);
    for (const text of shapes(1024 * 1024)) expect(time(text)).toBeLessThan(1000);
  });
});

describe("observeCause", () => {
  it("keeps a reason's trace annotations", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.fail(new Error(`GET https://example.com/x?token=${MARKER}`)).pipe(
        Effect.withSpan("Review.probe"),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error("expected a failure");
    const redacted = redaction.observeCause(exit.cause);
    expect(Cause.pretty(redacted)).not.toContain(MARKER);
    expect(Cause.pretty(redacted)).toContain("Review.probe");
    expect(redacted.reasons[0]?.annotations.size).toBe(exit.cause.reasons[0]?.annotations.size);
  });
});

describe("a reporter beneath the redaction", () => {
  it("gets one report per report, however many sensitive failures it holds", async () => {
    const run = async (redacted: boolean) => {
      const reports: string[] = [];
      const recorder = ErrorReporter.make(({ error }) => {
        reports.push(error.message);
      });
      const reporters = redacted ? [redaction.redactingReporter(recorder)] : [recorder];
      await Effect.runPromiseExit(
        Effect.failCause(
          Cause.combine(
            Cause.fail(new Error(`first https://a.example/?token=${MARKER}`)),
            Cause.fail(new Error(`second https://b.example/?token=${MARKER}`)),
          ),
        ).pipe(Effect.withErrorReporting, Effect.provide(ErrorReporter.layer(reporters))),
      );
      return reports;
    };
    const plain = await run(false);
    const redacted = await run(true);
    expect(plain).toHaveLength(2);
    expect(redacted).toHaveLength(plain.length);
    expect(redacted.join("\n")).not.toContain(MARKER);
  });
});

/** Whether `value` is plain data all the way down: primitives, plain arrays and plain objects. */
const expectPlainData = (value: unknown, path = "value"): void => {
  if (typeof value === "function") throw new Error(`${path} is a function`);
  if (typeof value !== "object" || value === null) return;
  const prototype: unknown = Object.getPrototypeOf(value);
  const plain =
    (Array.isArray(value) && prototype === Array.prototype) ||
    prototype === Object.prototype ||
    prototype === null;
  if (!plain) throw new Error(`${path} is a ${String(Reflect.get(value, "constructor")?.name)}`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && !("value" in descriptor)) {
      throw new Error(`${path}.${String(key)} is an accessor`);
    }
    expectPlainData(descriptor?.value, `${path}.${String(key)}`);
  }
};

describe("what an observer receives", () => {
  const SECRET = "slt_r6_credential_marker";
  const leaks = (value: unknown) =>
    [safeJson(value), inspect(value, { depth: 20, getters: true }), String(value)].some((text) =>
      text.includes(SECRET),
    );
  const liveRequest = () =>
    HttpServerRequest.fromWeb(
      new Request(`http://localhost/attach?token=${SECRET}`, {
        headers: { cookie: `session=${SECRET}`, "x-sealant-gateway-token": SECRET },
      }),
    );

  it("is plain data, whatever it was given: maps, URLs, headers, requests, class instances", () => {
    class Holder {
      readonly url = new URL(`https://u:${SECRET}@example.com/?token=${SECRET}`);
      get request() {
        return liveRequest();
      }
    }
    const given = {
      map: new Map<unknown, unknown>([
        ["authorization", `Bearer ${SECRET}`],
        ["next", `https://example.com/?token=${SECRET}`],
      ]),
      url: new URL(`https://u:${SECRET}@example.com/?token=${SECRET}&page=1`),
      params: new URLSearchParams({ token: SECRET, page: "1" }),
      headers: new Headers({ authorization: `Bearer ${SECRET}`, "x-request-id": "r1" }),
      request: new Request(`https://example.com/?access_token=${SECRET}`),
      serverRequest: liveRequest(),
      holder: new Holder(),
      set: new Set([`https://example.com/?token=${SECRET}`]),
      bytes: new TextEncoder().encode(SECRET),
      when: new Date(0),
      fn: () => SECRET,
      withGetter: Object.defineProperty({}, "secretly", { get: () => SECRET, enumerable: true }),
    };
    const observed = redaction.observe(given);
    expectPlainData(observed);
    expect(leaks(observed)).toBe(false);
    expect(observed).toMatchObject({
      url: "https://REDACTED:REDACTED@example.com/?token=REDACTED&page=1",
      params: "token=REDACTED&page=1",
      headers: { authorization: "REDACTED", "x-request-id": "r1" },
      holder: "[Holder]",
      when: "1970-01-01T00:00:00.000Z",
      withGetter: { secretly: "[accessor]" },
    });
  });

  it("is built fresh each time, so a later change to what it was given is observed too", () => {
    const error = Object.assign(new Error("failed"), { detail: { note: "ordinary" } });
    const first = redaction.observe(error);
    error.detail.note = `retry https://example.com/?token=${SECRET}`;
    const second = redaction.observe(error);
    expect(leaks(first)).toBe(false);
    expect(leaks(second)).toBe(false);
    expect(safeJson(second)).toContain("token=REDACTED");
    // The program's own error is untouched.
    expect(error.detail.note).toContain(SECRET);
  });

  it("keeps an error's reporting flags", () => {
    const error = Object.assign(new Error(`https://example.com/?token=${SECRET}`), {
      [ErrorReporter.ignore]: true,
      [ErrorReporter.severity]: "Warn",
      [ErrorReporter.attributes]: { route: "/x", apiKey: SECRET },
    });
    const observed = redaction.observe(error);
    expect(ErrorReporter.isIgnored(observed)).toBe(true);
    expect(observed).toMatchObject({
      [ErrorReporter.severity]: "Warn",
      [ErrorReporter.attributes]: { route: "/x", apiKey: "REDACTED" },
    });
    expect(leaks(observed)).toBe(false);
  });

  it("gets every reason's annotations observed, even when its failure held nothing", async () => {
    const reason = Cause.makeFailReason(new Error("benign")).annotate(
      Context.makeUnsafe(
        new Map<string, unknown>([
          ["url", `https://example.com/?token=${SECRET}`],
          ["authorization", SECRET],
        ]),
      ),
    );
    const observed = redaction.observeCause(Cause.fromReasons([reason]));
    const annotations = observed.reasons[0]?.annotations;
    expect(annotations?.get("url")).toBe("https://example.com/?token=REDACTED");
    expect(annotations?.get("authorization")).toBe("REDACTED");

    // The logical trace still prints.
    const exit = await Effect.runPromiseExit(
      Effect.fail(new Error("plain")).pipe(Effect.withSpan("Review.probe")),
    );
    if (!Exit.isFailure(exit)) throw new Error("expected a failure");
    expect(Cause.pretty(redaction.observeCause(exit.cause))).toContain("Review.probe");
  });
});
