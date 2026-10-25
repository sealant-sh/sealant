import { createServer, type Server } from "node:http";
import { format, inspect, types } from "node:util";

import { NodeHttpServer } from "@effect/platform-node";
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
import {
  Cause,
  Context,
  Effect,
  ErrorReporter,
  Exit,
  Layer,
  Logger,
  References,
  Scope,
  Tracer,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { type HttpApi, HttpApiBuilder, type HttpApiGroup } from "effect/http-api";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RequestRefusalLive } from "../routes/request-refusal.js";

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
        lines.push(`span name ${span.name}`);
        for (const link of span.links) lines.push(`span link ${JSON.stringify(link.attributes)}`);
        for (const [key, value] of span.attributes) lines.push(`span ${key}=${String(value)}`);
        if (Exit.isFailure(exit)) lines.push(`span failure ${structured(exit.cause)}`);
        end(endTime, exit);
      };
      return span;
    },
  });
  const logger = Logger.make((options) => {
    lines.push(`log ${inspect(options.message, { depth: 12 })} ${structured(options.cause)}`);
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    const spans = options.fiber.getRef(References.CurrentLogSpans);
    lines.push(`log annotations ${inspect(annotations, { depth: 12 })}`);
    lines.push(`log spans ${spans.map(([label]) => label).join(" ")}`);
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

/**
 * The request tracer records no headers by default; `headers` turns on recording every request and
 * response header, as an operator could, so a case shows the redaction holds there too.
 */
const serve = (
  app: Layer.Layer<never, never, HttpRouter.HttpRouter>,
  redacted: boolean,
  options?: { readonly headers?: boolean },
) => {
  const observed = observers(redacted);
  const headers =
    options?.headers === true
      ? Layer.succeed(HttpMiddleware.TracerHeaderFilter, () => true)
      : Layer.empty;
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(app, observed.layer, headers),
  );
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
    Layer.provide(RequestRefusalLive),
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

  it("carries no provider key in its path or an unnamed parameter into any span attribute", async () => {
    const key = "sk-proj-FAKEcodexkeyinaurl0000wxyz";
    const path = `/v1/sessions/${key}/attach?from=0&ownerUserId=${OWNER}&token=${MARKER}&q=${key}`;
    const server = serve(browserRoutes, true);
    await server.send(path);
    const observed = server.lines.join("\n");
    expect(observed).toContain("url.full=");
    expect(observed).toContain("url.query=");
    expect(observed).not.toContain(key);

    const control = serve(browserRoutes, false);
    await control.send(path);
    expect(control.lines.join("\n")).toContain(key);
  });

  it("is not in the failure an attach that is no WebSocket ends with, in any observer", async () => {
    const path = `/v1/sessions/sess_live/attach?from=0&ownerUserId=${OWNER}&token=${MARKER}`;
    const server = serve(browserRoutes, true);
    expect(await server.send(path)).toBeGreaterThanOrEqual(400);
    const observed = server.lines.join("\n");
    // A 4xx response does not fail the request's span; the error reporter receives the failure.
    expect(observed).toContain("report ");
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

/**
 * The API as its process serves it: a TCP server, the router with its request logger and the
 * service-key gate, the process's own loggers (and every built-in format beside them) printing to
 * the console, all beneath `CredentialRedactionLive`. What the console receives is the process log.
 */
const serveOverTcp = async (
  app: Layer.Layer<never, never, HttpRouter.HttpRouter>,
  redacted: boolean,
) => {
  const { servicePrincipalMiddleware, makeServicePrincipals } =
    await import("./service-principals.js");
  const printed: string[] = [];
  const print = (...args: unknown[]) => {
    printed.push(format(...args));
  };
  const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(print),
  );
  const loggers = Logger.layer(
    [Logger.consoleJson, Logger.consoleLogFmt, Logger.consolePretty({ colors: false })],
    { mergeWithExisting: true },
  );
  let server: Server | undefined;
  const layer = HttpRouter.serve(app, {
    middleware: servicePrincipalMiddleware(makeServicePrincipals(MARKER), GATEWAY_MARKER),
  }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => (server = createServer()), { port: 0 })),
    Layer.provide(redacted ? redaction.CredentialRedactionLive : Layer.empty),
    Layer.provide(loggers),
  );
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const address = server?.address();
  if (typeof address !== "object" || address === null) throw new Error("expected a TCP address");
  disposers.push(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    for (const spy of spies) spy.mockRestore();
  });
  const send = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: { authorization: `Bearer ${MARKER}` },
    });
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response.status;
  };
  return { send, printed };
};

describe("what the API process prints", () => {
  const key = ["sk", "proj", `FAKE${"O".repeat(35)}O101`].join("-");
  const probe = HttpRouter.add(
    "GET",
    "/v1/probe",
    Effect.log("probe").pipe(
      Effect.annotateLogs({
        nested: { deep: [{ value: key }] },
        link: new URL(`https://example.test/a?token=${MARKER}&q=${key}`),
        apiKey: "fake-plain-value",
        [`label ${key}`]: 1,
      }),
      Effect.withLogSpan(`probe ${key}`),
      Effect.withSpan(`probe ${key}`, {
        links: [
          {
            span: Tracer.externalSpan({ spanId: "span_1", traceId: "trace_1" }),
            attributes: { note: `linked ${key}` },
          },
        ],
      }),
      Effect.as(HttpServerResponse.text("ok")),
    ),
  );
  const app = () =>
    Layer.mergeAll(browserRoutes, probe) as Layer.Layer<never, never, HttpRouter.HttpRouter>;
  const requests = [
    [`/v1/no-such/${key}?q=${key}`, 404],
    [`/v1/workspaces/${key}?ownerUserId=${OWNER}&q=${key}`, 404],
    [`/v1/sessions/${key}/output/stream?from=0&ownerUserId=${OWNER}&q=${key}`, 404],
    ["/v1/probe", 200],
  ] as const;

  it("carries no provider key from a request's path or an unnamed parameter, nor from a log's annotations or span", async () => {
    const server = await serveOverTcp(app(), true);
    for (const [path, status] of requests) expect(await server.send(path)).toBe(status);
    const printed = server.printed.join("\n");
    expect(printed).toContain("http.url");
    expect(printed).not.toContain(key);
    expect(printed).not.toContain(MARKER);
    expect(printed).toContain("/v1/no-such/REDACTED");
    expect(printed).toContain("probe REDACTED");
    expect(printed).not.toContain("fake-plain-value");

    const control = await serveOverTcp(app(), false);
    for (const [path] of requests) await control.send(path);
    expect(control.printed.join("\n")).toContain(key);
  });

  it("gives no span a provider key in its name, links or attributes", async () => {
    const bearer = { headers: { authorization: `Bearer ${MARKER}` } };
    const server = serve(app(), true);
    for (const [path, status] of requests) expect(await server.send(path, bearer)).toBe(status);
    const observed = server.lines.join("\n");
    expect(observed).toContain("span name probe REDACTED");
    expect(observed).toContain('span link {"note":"linked REDACTED"}');
    expect(observed).not.toContain(key);
    expect(observed).not.toContain(MARKER);

    const control = serve(app(), false);
    for (const [path] of requests) await control.send(path, bearer);
    expect(control.lines.join("\n")).toContain(`span name probe ${key}`);
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
    const server = serve(sshApi(), true, { headers: true });
    // Authenticated, then no such key.
    expect(await server.send("/v1/ssh-keys/resolve-principal", request())).toBe(404);
    const observed = server.lines.join("\n");
    expect(observed).toContain("http.request.header.x-sealant-gateway-token=REDACTED");
    expect(observed).not.toContain(GATEWAY_MARKER);

    const control = serve(sshApi(), false, { headers: true });
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
  `bearer "${"a".repeat(bytes)}`,
  `${'bearer \\"'.repeat(bytes / 9)}`,
  `https://u:${"%2F".repeat(bytes / 3)}`,
  `${"a%40".repeat(bytes / 4)}`,
  `${"sk-".repeat(bytes / 3)}`,
  `${"sk-ant-api0".repeat(bytes / 11)}`,
  `${`sk-${"a".repeat(31)} `.repeat(bytes / 35)}`,
];

/**
 * The expressions allowed to inspect more than a name's length of text (64 characters), each linear
 * by construction. A query pair starts only at a separator, and its name excludes the separators,
 * so a failed attempt reads at most to the next one; its value never fails. An auth scheme is a
 * literal of at most six characters, then blanks it never gives back. A provider key starts only at
 * the literal `sk-`, after one character that is no letter or digit (a lookbehind of one
 * character); each branch is a literal prefix and one run of key characters it never gives back,
 * so a failed attempt reads no further than that run. An expression added or changed here needs the
 * same argument.
 */
const LINEAR_SEARCHES = new Set([
  String.raw`/([?&;])([^=&\s#?;]+)=([^&\s#;"'<>)\\]*)/g`,
  String.raw`/\b(bearer|basic)[ \t]+/gi`,
  String.raw`/(?<![A-Za-z0-9])sk-(?:(?:ant-(?:api|oat|ort|admin)\d*|proj|svcacct|admin)-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})/g`,
]);

/** The built-ins redaction calls today, each charged below. Calling any other needs review first. */
const REVIEWED_TRAVERSALS = new Set([
  "String.prototype.charAt",
  "String.prototype.slice",
  "String.prototype.toLowerCase",
  "String.prototype.replace",
  "String.prototype.replaceAll",
  "RegExp.prototype.exec",
  "RegExp.prototype.test",
  "globalThis.decodeURIComponent",
]);

/** The longest text a name is read from; an expression may inspect this much without review. */
const NAME_LENGTH = 64;

const lengthOf = (value: unknown) => (typeof value === "string" ? value.length : 0);

/** A position argument as a string method reads it, within `[0, length]`. */
const positionOf = (value: unknown, fallback: number, length: number) =>
  typeof value === "number" && !Number.isNaN(value)
    ? Math.min(Math.max(Math.trunc(value), 0), length)
    : fallback;

/**
 * The characters one `String.prototype` call reads or writes: one for a single position; the part
 * a slice copies; from the start position to the end for a forward search, back to the start for
 * `lastIndexOf`; the prefix or suffix `startsWith` and `endsWith` compare; and for anything else the
 * whole receiver or the string it builds, whichever is longer.
 */
const stringCharge = (
  method: PropertyKey,
  text: string,
  args: readonly unknown[],
  result: unknown,
): number => {
  const length = text.length;
  switch (method) {
    case "charAt":
    case "charCodeAt":
    case "codePointAt":
    case "at":
    case "toString":
    case "valueOf":
      return 1;
    case "slice":
    case "substring":
    case "substr":
      return Math.max(lengthOf(result), 1);
    case "indexOf":
    case "includes":
      return Math.max(length - positionOf(args[1], 0, length), 1);
    case "lastIndexOf":
      return Math.max(Math.min(positionOf(args[1], length, length) + 1, length), 1);
    case "startsWith":
    case "endsWith":
      return Math.max(Math.min(lengthOf(args[0]), length), 1);
    default:
      return Math.max(length, lengthOf(result), 1);
  }
};

/** String methods that search with an expression when given one. */
const TAKES_EXPRESSION = new Set<PropertyKey>([
  "match",
  "matchAll",
  "replace",
  "replaceAll",
  "search",
  "split",
]);

const URI_CODERS = [
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
];

const descriptorsOf = (owner: object, keys: ReadonlyArray<PropertyKey>) => {
  const descriptors = new Map<PropertyKey, PropertyDescriptor>();
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(owner, key);
    if (descriptor !== undefined) descriptors.set(key, descriptor);
  }
  return descriptors;
};

/**
 * The built-ins as they were before the module under test loaded (it is imported in `beforeAll`):
 * every property of `String.prototype` and `RegExp.prototype`, `RegExp`'s species and the URI
 * coders. A built-in reaches an operand's inherited hooks through these, so one changed would run
 * module code inside a built-in, where nothing is charged.
 */
const NATIVE = new Map<object, ReadonlyMap<PropertyKey, PropertyDescriptor>>([
  [String.prototype, descriptorsOf(String.prototype, Reflect.ownKeys(String.prototype))],
  [RegExp.prototype, descriptorsOf(RegExp.prototype, Reflect.ownKeys(RegExp.prototype))],
  [RegExp, descriptorsOf(RegExp, [Symbol.species])],
  [globalThis, descriptorsOf(globalThis, URI_CODERS)],
]);
/** Owners of which `NATIVE` holds every property, so one added there is a change too. */
const CLOSED = new Set<object>([String.prototype, RegExp.prototype]);

/** Where an operand sits: an expression a string method searches with, a replacer, or data. */
type Role = "pattern" | "callback" | "data";

const isPrimitive = (value: unknown) =>
  (typeof value !== "object" && typeof value !== "function") || value === null;

/**
 * The cursor of a plain, native expression, read once and only as data: no proxy, `RegExp.prototype`
 * as its prototype, no own property but `lastIndex`, and that a non-negative integer. Undefined for
 * anything else, whose own hooks or cursor coercion would run module code inside a built-in.
 */
const cursorOf = (value: unknown): number | undefined => {
  if (!types.isRegExp(value) || types.isProxy(value)) return undefined;
  if (Reflect.getPrototypeOf(value) !== RegExp.prototype || Reflect.ownKeys(value).length !== 1) {
    return undefined;
  }
  // A real expression's own `lastIndex` is always a data property, so reading it calls nothing.
  const cursor: unknown = value.lastIndex;
  return typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0 ? cursor : undefined;
};

/** A replacer with nothing of its own a built-in could call: a plain function, no proxy. */
const isPlainCallback = (value: unknown) =>
  typeof value === "function" &&
  !types.isProxy(value) &&
  Reflect.getPrototypeOf(value) === Function.prototype &&
  Reflect.ownKeys(value).every((key) => key === "length" || key === "name" || key === "prototype");

const accepts = (role: Role, value: unknown) =>
  isPrimitive(value) ||
  (role === "pattern" && cursorOf(value) !== undefined) ||
  (role === "callback" && isPlainCallback(value));

/**
 * The work one `redactCredentialsInText` call does, counted instead of timed so the machine's speed
 * plays no part. Every function on `String.prototype` and `RegExp.prototype`, and the URI coders, is
 * wrapped for the one synchronous call and restored after it, so the module under test runs
 * unchanged. Only calls the module makes are charged: a built-in's calls into another built-in pass
 * through, and a replacer callback is charged again as the module's own code.
 *
 * A string method is charged by `stringCharge`; a URI coder its input or output, whichever is
 * longer. An expression is charged what it could inspect, from where it starts (`lastIndex` for a
 * global or sticky `exec` or `test`, otherwise 0) to the end of the input. One in `LINEAR_SEARCHES`
 * stepping through the text with `exec` or `test` is charged instead from its start to the end of
 * its match, the reviewed argument being that it reads no further; charged to the end of the input,
 * the scanner's loop over auth schemes would count every remaining character again at each match.
 *
 * `unreviewed` names each built-in called that `REVIEWED_TRAVERSALS` lacks, and `searches` each
 * expression that could inspect more than `NAME_LENGTH` characters that `LINEAR_SEARCHES` lacks: a
 * new traversal's charge, and an expression's own backtracking, are claims a person has to check.
 * The rest name where module code could run inside a built-in, uncharged: `operands` each built-in
 * given something other than a primitive, a native expression to search with or a plain replacer
 * (or a replacer that returned an object), and `modified` each call that found a built-in changed
 * from `NATIVE`: before and after the measurement, at each call that dispatches through an
 * expression's inherited hooks, and at each `test` for the `exec` it calls.
 *
 * This is a regression check for accidental repeated scans and unreviewed regex searches, not a
 * complexity proof or a defense against code written to bypass the meter. Indexed reads, operators,
 * JSON serialization, Array operations and hashing are not fully metered. The sampled sizes (1, 8
 * and 16 KiB) do not cover every future length-dependent path: add boundary cases when introducing
 * one. Deliberately bypassing the wrappers, or changing a built-in and restoring it between two
 * observation points, is outside this test's threat model.
 */
const steps = (text: string) => {
  let count = 0;
  let depth = 0;
  const unreviewed = new Set<string>();
  const searches = new Set<string>();
  const operands = new Set<string>();
  const modified = new Set<string>();
  const restore: Array<() => void> = [];
  const installed = new Map<object, Map<PropertyKey, unknown>>();

  /** Whether `owner` holds its `NATIVE` properties exactly, but for the wrappers installed here. */
  const unchanged = (owner: object) => {
    const native = NATIVE.get(owner);
    if (native === undefined) return false;
    if (CLOSED.has(owner) && Reflect.ownKeys(owner).length !== native.size) return false;
    const wrappers = installed.get(owner);
    for (const [key, then] of native) {
      const now = Reflect.getOwnPropertyDescriptor(owner, key);
      const value = wrappers?.has(key) ? wrappers.get(key) : then.value;
      if (
        now === undefined ||
        now.value !== value ||
        now.get !== then.get ||
        now.set !== then.set ||
        now.writable !== then.writable ||
        now.enumerable !== then.enumerable ||
        now.configurable !== then.configurable
      ) {
        return false;
      }
    }
    return true;
  };
  const expressionsUnchanged = () => unchanged(RegExp.prototype) && unchanged(RegExp);

  const reentrant = (replacer: Function, label: string) =>
    function (this: unknown, ...inner: unknown[]) {
      const outer = depth;
      depth = 0;
      try {
        const result: unknown = Reflect.apply(replacer, this, inner);
        if (!isPrimitive(result)) operands.add(`${label} replacer result`);
        return result;
      } finally {
        depth = outer;
      }
    };

  const install = (
    owner: object,
    prefix: string,
    role: (key: PropertyKey, index: number) => Role,
    meter: (
      key: PropertyKey,
      receiver: unknown,
      args: unknown[],
      call: () => unknown,
      label: string,
    ) => unknown,
  ) => {
    const wrappers = new Map<PropertyKey, unknown>();
    installed.set(owner, wrappers);
    for (const key of NATIVE.get(owner)?.keys() ?? []) {
      const descriptor = Reflect.getOwnPropertyDescriptor(owner, key);
      const original: unknown = descriptor?.value;
      if (descriptor === undefined || key === "constructor" || typeof original !== "function") {
        continue;
      }
      const label =
        typeof key === "symbol" ? `${prefix}[${key.description}]` : `${prefix}.${String(key)}`;
      const wrapper = function (this: unknown, ...args: unknown[]) {
        if (depth > 0) return Reflect.apply(original, this, args);
        if (!REVIEWED_TRAVERSALS.has(label)) unreviewed.add(label);
        for (let index = 0; index < args.length; index += 1) {
          const arg = args[index];
          if (!isPrimitive(arg) && !accepts(role(key, index), arg)) operands.add(label);
        }
        const call = () => {
          depth += 1;
          try {
            const callbacks = args.some((arg) => typeof arg === "function");
            return Reflect.apply(
              original,
              this,
              callbacks
                ? args.map((arg, index) =>
                    role(key, index) === "callback" && typeof arg === "function"
                      ? reentrant(arg, label)
                      : arg,
                  )
                : args,
            );
          } finally {
            depth -= 1;
          }
        };
        return meter(key, this, args, call, label);
      };
      Reflect.defineProperty(owner, key, { ...descriptor, value: wrapper });
      wrappers.set(key, wrapper);
      restore.push(() => Reflect.defineProperty(owner, key, descriptor));
    }
  };

  /** What an expression could inspect of `input` from `from`, or its reviewed stride to `end`. */
  const search = (pattern: RegExp, input: string, from: number, end: number | undefined) => {
    const id = `/${pattern.source}/${pattern.flags}`;
    const reviewed = LINEAR_SEARCHES.has(id);
    const potential = input.length - from;
    if (!reviewed && potential > NAME_LENGTH) searches.add(id);
    return Math.max(reviewed && end !== undefined ? end - from : potential, 1);
  };

  try {
    for (const owner of NATIVE.keys()) if (!unchanged(owner)) modified.add("before measurement");
    install(
      String.prototype,
      "String.prototype",
      (key, index) =>
        index === 0 && TAKES_EXPRESSION.has(key)
          ? "pattern"
          : index === 1 && (key === "replace" || key === "replaceAll")
            ? "callback"
            : "data",
      (key, receiver, args, call, label) => {
        if (typeof receiver !== "string") operands.add(label);
        const own = typeof receiver === "string" ? receiver : "";
        const pattern = args[0];
        const expression =
          TAKES_EXPRESSION.has(key) && types.isRegExp(pattern) ? pattern : undefined;
        if (expression !== undefined && !expressionsUnchanged()) modified.add(label);
        const result = call();
        count +=
          expression === undefined
            ? stringCharge(key, own, args, result)
            : search(expression, own, 0, undefined);
        return result;
      },
    );
    install(
      RegExp.prototype,
      "RegExp.prototype",
      (key, index) => (key === Symbol.replace && index === 1 ? "callback" : "data"),
      (key, receiver, args, call, label) => {
        const cursor = cursorOf(receiver);
        if (!types.isRegExp(receiver) || cursor === undefined) {
          operands.add(label);
          return call();
        }
        const execCalled = RegExp.prototype.exec === installed.get(RegExp.prototype)?.get("exec");
        if (key === "test" ? !execCalled : key !== "exec" && !expressionsUnchanged()) {
          modified.add(label);
        }
        const input = typeof args[0] === "string" ? args[0] : "";
        const stepping = (key === "exec" || key === "test") && (receiver.global || receiver.sticky);
        const from = stepping ? Math.min(cursor, input.length) : 0;
        const result = call();
        const after: unknown = receiver.lastIndex;
        const end = stepping && result !== null && result !== false && typeof after === "number";
        count +=
          key === "compile" || key === "toString"
            ? 1
            : search(receiver, input, from, end ? after : undefined);
        return result;
      },
    );
    install(
      globalThis,
      "globalThis",
      () => "data",
      (_key, _receiver, args, call) => {
        const result = call();
        count += Math.max(lengthOf(args[0]), lengthOf(result), 1);
        return result;
      },
    );
    redaction.redactCredentialsInText(text);
    for (const owner of NATIVE.keys()) if (!unchanged(owner)) modified.add("after measurement");
  } finally {
    for (const undo of restore) undo();
  }
  return {
    count,
    unreviewed: [...unreviewed],
    searches: [...searches],
    operands: [...operands],
    modified: [...modified],
  };
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
  it("replaces a provider key by its shape, wherever it stands", () => {
    const keys = [
      "sk-ant-api03-FAKEclaudekeyforthetests000000wxyz",
      "sk-ant-oat01-FAKEsetuptoken0000wxyz",
      "sk-proj-FAKEcodexkey0000wxyz",
      "sk-FAKElegacyopenaikey00000000000000000000wxyz",
    ];
    for (const key of keys) {
      const redacted = redaction.redactCredentialsInText(
        `401 from the provider: invalid x-api-key ${key}, (key=${key})`,
      );
      expect(redacted).not.toContain(key);
      expect(redacted).not.toContain("wxyz");
      expect(redacted).toContain("401 from the provider: invalid x-api-key REDACTED");
    }
    expect(redaction.redactCredentialsInText("task-runner sk-learn sk-short risk-assessment")).toBe(
      "task-runner sk-learn sk-short risk-assessment",
    );
    expect(redaction.redactCredentialsInText(`OPENAI_API_KEY_${keys[2]}`)).toBe(
      "OPENAI_API_KEY_REDACTED",
    );
  });

  it("replaces a provider key in an observed URL, its path and its parameters", () => {
    const key = "sk-proj-FAKEcodexkeyinaurl0000wxyz";
    const observed = redaction.observe({
      url: new URL(`https://api.example.test/v1/${key}?q=${key}`),
      params: new URLSearchParams({ q: key }),
    });
    expect(JSON.stringify(observed)).not.toContain(key);
  });

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

  // Metered, this takes about 250 ms unloaded and 3 s on a saturated machine; the timeout is only a
  // hang guard, with room above the 5 s default.
  it("costs linear time on adversarial text", { timeout: 30_000 }, () => {
    // Quadratic matching took 16-97 ms at 8 KiB and would take minutes at 1 MiB. Counted, a scan
    // that restarts at each position reads each character more often as the text grows; this one
    // reads each at most 19 times at every size, so 32 leaves room without hiding growth.
    // Metering slows every call many times over, so the sizes stay small enough for a loaded runner.
    for (const bytes of [1024, 8 * 1024, 16 * 1024]) {
      for (const text of shapes(bytes)) {
        const work = steps(text);
        expect(work.count, text.slice(0, 12)).toBeLessThanOrEqual(32 * text.length);
        expect(work.unreviewed, "unmetered traversal, review needed").toEqual([]);
        expect(work.searches, "an expression over long text, review needed").toEqual([]);
        expect(work.operands, "custom protocol operand, review needed").toEqual([]);
        expect(work.modified, "modified built-in, review needed").toEqual([]);
      }
    }
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

  it("reads the log annotations and log spans of the fiber it is given observed", async () => {
    const key = ["sk", "proj", `FAKE${"O".repeat(35)}O202`].join("-");
    const run = async (redacted: boolean) => {
      const reports: string[] = [];
      const recorder = ErrorReporter.make(({ fiber }) => {
        const annotations = fiber.getRef(References.CurrentLogAnnotations);
        const spans = fiber.getRef(References.CurrentLogSpans);
        reports.push(inspect({ annotations, spans }, { depth: 12 }));
      });
      const reporters = redacted ? [redaction.redactingReporter(recorder)] : [recorder];
      await Effect.runPromiseExit(
        Effect.fail(new Error("failed")).pipe(
          Effect.withErrorReporting,
          Effect.annotateLogs({ request: { path: `/v1/no-such/${key}` } }),
          Effect.withLogSpan(`span ${key}`),
          Effect.provide(ErrorReporter.layer(reporters)),
        ),
      );
      return reports.join("\n");
    };
    expect(await run(false)).toContain(key);
    const redacted = await run(true);
    expect(redacted).toContain("/v1/no-such/REDACTED");
    expect(redacted).toContain("span REDACTED");
    expect(redacted).not.toContain(key);
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

describe("round 1 of the review of #351", () => {
  const SECRET = "slt_review351_marker";
  const leaks = (value: unknown) =>
    [safeJson(value), inspect(value, { depth: 20, getters: true }), String(value)].some((text) =>
      text.includes(SECRET),
    );

  it("F1: walks an array by index into a fresh array, never calling the array's own code", () => {
    const overridden = [{ authorization: SECRET }];
    Object.defineProperty(overridden, "map", { value: () => overridden });
    const species = [{ authorization: SECRET }];
    const item = species[0];
    Object.defineProperty(species, "constructor", {
      value: { [Symbol.species]: () => species },
    });
    let calls = 0;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      get: () => {
        calls += 1;
        return SECRET;
      },
      enumerable: true,
    });
    class Subclassed extends Array<unknown> {}
    const subclassed = Subclassed.from([SECRET]);

    const observed = [overridden, species, accessor, subclassed].map((input) =>
      redaction.observe(input),
    );
    // Counted before any assertion: a matcher may read the input's elements itself.
    expect(calls).toBe(0);
    for (const [index, input] of [overridden, species, accessor, subclassed].entries()) {
      expect(observed[index] === input).toBe(false);
      expectPlainData(observed[index]);
      expect(leaks(observed[index])).toBe(false);
    }
    expect(species[0] === item).toBe(true);
    expect(redaction.observe(accessor)).toEqual(["[accessor]"]);
    expect(redaction.observe(subclassed)).toBe("[Subclassed]");
  });

  it("F1: takes an HTTP response's status only as a number", () => {
    const response = HttpClientResponse.fromWeb(
      HttpClientRequest.get("https://example.com/"),
      new Response(null, { status: 503 }),
    );
    Object.defineProperty(response, "status", { value: { authorization: SECRET } });
    const observed = redaction.observe(response);
    expectPlainData(observed);
    expect(leaks(observed)).toBe(false);
    expect(observed).toMatchObject({ status: undefined });
  });

  it("F2: puts names, tags, symbols, keys and labels through the text rules, calling no getter", () => {
    let calls = 0;
    class Named {
      readonly kind = "named";
    }
    Object.defineProperty(Named, "name", { value: `https://example.com/x?token=${SECRET}` });
    class Guarded {
      readonly kind = "guarded";
    }
    Object.defineProperty(Guarded.prototype, "constructor", {
      get: () => {
        calls += 1;
        return Named;
      },
    });
    const observed = redaction.observe({
      error: Object.assign(new Error("failed"), {
        name: `https://example.com/x?token=${SECRET}`,
        _tag: `Bearer ${SECRET}`,
      }),
      symbol: Symbol(`https://example.com/x?token=${SECRET}`),
      map: new Map([[`https://example.com/x?token=${SECRET}`, "failed"]]),
      object: { [`https://example.com/x?token=${SECRET}`]: "failed" },
      named: new Named(),
      guarded: new Guarded(),
    });
    expectPlainData(observed);
    expect(leaks(observed)).toBe(false);
    expect(calls).toBe(0);
    expect(observed).toMatchObject({ guarded: "[object]" });
  });

  it("F3: replaces a quoted Bearer or Basic credential of any length, plain or escaped", () => {
    const long = `${"x".repeat(5000)}${SECRET}`;
    for (const text of [
      `Authorization: Bearer "${long}"`,
      `sent basic "${long}" then`,
      JSON.stringify({ header: `Bearer "${long}"` }),
      JSON.stringify(JSON.stringify({ header: `Bearer "${long}"` })),
      `Bearer "${long}`,
    ]) {
      expect(redaction.redactCredentialsInText(text).includes(SECRET), text.slice(0, 40)).toBe(
        false,
      );
    }
  });

  it("F4: replaces a literal URL's userinfo to its last @, encoded delimiters included", () => {
    for (const password of [
      `pa%2Fss${SECRET}`,
      `pa%3Fss${SECRET}`,
      `pa%23ss${SECRET}`,
      `a@b${SECRET}`,
    ]) {
      const text = `failed https://user:${password}@registry.example/v2/ here`;
      const redacted = redaction.redactCredentialsInText(text);
      expect(redacted, password).not.toContain(SECRET);
      expect(redacted).toContain("registry.example/v2/");
    }
  });

  it("F5: keeps an AggregateError's failures, each plain and redacted", () => {
    const observed = redaction.observe(
      new AggregateError(
        [new Error(`https://example.com/x?token=${SECRET}`), new Error("second")],
        "both failed",
      ),
    );
    expectPlainData(observed);
    expect(leaks(observed)).toBe(false);
    expect(observed).toMatchObject({
      name: "AggregateError",
      message: "both failed",
      errors: [{ message: "https://example.com/x?token=REDACTED" }, { message: "second" }],
    });
  });

  it("F6: a main effect's failure reaches the runtime's own logger observed", async () => {
    const run = async (observed: boolean) => {
      const lines: string[] = [];
      const capture = Logger.make((options) => {
        lines.push(`${inspect(options.message, { depth: 12 })} ${structured(options.cause)}`);
      });
      const main = Effect.fail(new Error(`startup https://example.com/x?token=${SECRET}`));
      // What NodeRuntime.runMain does with a failed main effect, outside every layer it provides.
      await Effect.runPromiseExit(
        (observed ? redaction.observedMain(main) : main).pipe(
          Effect.tapCause((cause) => Effect.logError(cause)),
          Effect.provide(Logger.layer([capture])),
        ),
      );
      return lines.join("\n");
    };
    expect(await run(true)).not.toContain(SECRET);
    expect(await run(false)).toContain(SECRET);

    const interrupted = await Effect.runPromiseExit(redaction.observedMain(Effect.interrupt));
    expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
  });

  it("F7: keeps a `__proto__` field a plain field, never the copy's prototype", () => {
    const input: unknown = JSON.parse(`{"__proto__": {"token": "${SECRET}"}, "ok": 1}`);
    const observed = redaction.observe(input);
    expect(Object.getPrototypeOf(observed)).toBe(Object.prototype);
    expect(Object.hasOwn(observed as object, "__proto__")).toBe(true);
    expect(leaks(observed)).toBe(false);
  });
});
