/**
 * Every control plane route answers a request it cannot decode with `400` `RequestRefusedError`
 * and a value-free reason, and nothing the server observes (the request log, `ErrorReporter`s, the
 * request's tracing spans) carries the rejected input. Served as the API serves it: the real
 * `ControlPlaneAPI` through HttpApiBuilder and the router's request logger, with every handler a
 * stub, since a refused request never reaches one.
 */
import {
  ControlPlaneAPI,
  REQUEST_BODY_NOT_JSON,
  RequestRefusal,
  type CreateSessionRequest,
  type SessionWire,
} from "@sealant/api-contracts";
import { Cause, Effect, ErrorReporter, Exit, Layer, Logger, Tracer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { type HttpApi, HttpApiBuilder, type HttpApiGroup } from "effect/unstable/httpapi";
import { afterEach, describe, expect, it } from "vitest";

import { RequestRefusalLive } from "./request-refusal.js";

const MARKER = "review347-secret-marker";

const opened: CreateSessionRequest[] = [];

const session = (payload: CreateSessionRequest): SessionWire => ({
  sessionId: "sess_1",
  workspaceId: payload.workspaceId,
  runId: "run_1",
  ownerUserId: payload.ownerUserId,
  status: "running",
  argv: payload.argv.slice(0, 1),
  cols: 80,
  rows: 24,
  outputHighWater: "0",
  createdAt: new Date(0).toISOString(),
});

/** The program that makes the handler fail as the server's fault: parsing its own data. */
const HANDLER_SYNTAX_ERROR = "handler-syntax-error";

const createSession = ({ payload }: { readonly payload: CreateSessionRequest }) =>
  Effect.sync(() => {
    if (payload.argv[0] === HANDLER_SYNTAX_ERROR) JSON.parse("{ server data");
    opened.push(payload);
    return session(payload);
  });

type ControlPlaneGroups =
  typeof ControlPlaneAPI extends HttpApi.HttpApi<string, infer G> ? G : never;

// Every endpoint of every group, a stub: the handler builder is typed per endpoint name, and this
// test wants all of them without naming each, so the builder is driven untyped and the merged
// layer is typed as the groups the API requires.
const stubs = Layer.mergeAll(
  Layer.empty,
  ...Object.entries(ControlPlaneAPI.groups).map(([name, group]) =>
    HttpApiBuilder.group(
      ControlPlaneAPI,
      name as never,
      (handlers) =>
        Object.keys(group.endpoints).reduce(
          (acc, endpoint) =>
            (acc as { handle: (n: string, h: unknown) => unknown }).handle(
              endpoint,
              endpoint === "createSession" || endpoint === "createSessionAsUser"
                ? createSession
                : () => Effect.die("not under test"),
            ),
          handlers as unknown,
        ) as never,
    ),
  ),
) as unknown as Layer.Layer<HttpApiGroup.ToService<"sealantControlPlaneApi", ControlPlaneGroups>>;

/** A server with every observer captured: log lines, reported errors, ended spans' exits. */
const serve = (refusal: Layer.Layer<RequestRefusal>) => {
  const observed: string[] = [];
  const logger = Logger.make((options) => {
    observed.push(`log ${JSON.stringify(options.message)} ${Cause.pretty(options.cause)}`);
  });
  const reporter = ErrorReporter.make(({ cause, error, attributes }) => {
    observed.push(`report ${Cause.pretty(cause)} ${String(error)} ${JSON.stringify(attributes)}`);
  });
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        observed.push(
          `span ${options.name} ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "ok"} ${JSON.stringify([...span.attributes])}`,
        );
        end(endTime, exit);
      };
      return span;
    },
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(
      HttpApiBuilder.layer(ControlPlaneAPI).pipe(
        Layer.provide(stubs),
        Layer.provide(refusal),
        Layer.provide(HttpServer.layerServices),
      ),
      Logger.layer([logger]),
      ErrorReporter.layer([reporter]),
      Layer.succeed(Tracer.Tracer, tracer),
    ),
  );
  const send = async (method: string, path: string, body?: string) => {
    const response = await handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
      }),
    );
    const text = await response.text();
    // The request's span ends in a task scheduled after the response.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: response.status, text };
  };
  return { send, observed, dispose };
};

let disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.map((dispose) => dispose()));
  disposers = [];
  opened.length = 0;
});

const ids = { workspaceId: "wks_1", ownerUserId: "usr_1" };
const brokenJson = `{"ownerUserId":"usr_1","note":"${MARKER}"`;
const wrapped = (body: object) => JSON.stringify([body]);

/** [route, method, path, body, a fragment of the reason]: each carries the marker somewhere. */
const cases: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ...["/v1/sessions", "/v1/sessions/as-user"].flatMap(
    (path) =>
      [
        [path, "POST", path, JSON.stringify({ ...ids, argv: MARKER }), "argv must be an array"],
        [
          path,
          "POST",
          path,
          JSON.stringify({ ...ids, argv: ["printf", { secret: MARKER }] }),
          "argv[1] must be a string",
        ],
        [
          path,
          "POST",
          path,
          wrapped({ ...ids, argv: ["printf", MARKER] }),
          "the request body must be an object",
        ],
        [
          path,
          "POST",
          path,
          JSON.stringify({ workspaceId: "wks_1", argv: ["printf", MARKER] }),
          "ownerUserId is required",
        ],
        [path, "POST", path, brokenJson, REQUEST_BODY_NOT_JSON],
        [
          path,
          "POST",
          path,
          JSON.stringify({ ...ids, argv: ["printf", `${MARKER}\u0000`] }),
          "argv[1] contains a NUL byte",
        ],
        [
          path,
          "POST",
          path,
          JSON.stringify({ ...ids, argv: [` ${MARKER}`, "-c", "true"] }),
          "argv[0], the program, must be non-empty",
        ],
        [
          path,
          "POST",
          path,
          JSON.stringify({ ...ids, argv: ["printf", MARKER], cols: "wide" }),
          "cols must be a number",
        ],
        [
          path,
          "POST",
          path,
          JSON.stringify({ ...ids, argv: ["printf"], env: { [MARKER]: 5 } }),
          "env[…] must be a string",
        ],
      ] as const,
  ),
  ...["input", "resize", "signal", "close"].flatMap(
    (verb) =>
      [
        [
          `POST /v1/sessions/:id/${verb}`,
          "POST",
          `/v1/sessions/sess_1/${verb}`,
          wrapped({ ownerUserId: "usr_1", dataBase64: MARKER, note: MARKER }),
          "the request body must be an object",
        ],
        [
          `POST /v1/sessions/:id/${verb}`,
          "POST",
          `/v1/sessions/sess_1/${verb}`,
          brokenJson,
          REQUEST_BODY_NOT_JSON,
        ],
        [
          `POST /v1/sessions/:id/${verb}`,
          "POST",
          `/v1/sessions/sess_1/${verb}`,
          JSON.stringify({ ownerUserId: { secret: MARKER } }),
          "ownerUserId must be a string",
        ],
      ] as const,
  ),
  ...["exec", "exec-as-user"].flatMap(
    (route) =>
      [
        [
          `POST /v1/workspaces/:id/${route}`,
          "POST",
          `/v1/workspaces/wks_1/${route}`,
          JSON.stringify({
            ownerUserId: "usr_1",
            user: "m4lice000",
            commands: [{ executable: "sh", args: ["-c", { secret: MARKER }] }],
          }),
          "commands[0].args[1] must be a string",
        ],
        [
          `POST /v1/workspaces/:id/${route}`,
          "POST",
          `/v1/workspaces/wks_1/${route}`,
          wrapped({
            ownerUserId: "usr_1",
            commands: [{ executable: "sh", args: ["-c", MARKER] }],
          }),
          "the request body must be an object",
        ],
        [
          `POST /v1/workspaces/:id/${route}`,
          "POST",
          `/v1/workspaces/wks_1/${route}`,
          brokenJson,
          REQUEST_BODY_NOT_JSON,
        ],
      ] as const,
  ),
  [
    "POST /v1/runs",
    "POST",
    "/v1/runs",
    wrapped({
      ...ids,
      harnessId: "custom",
      command: { executable: "sh", args: ["-c", MARKER] },
    }),
    "the request body must be an object",
  ],
  [
    "POST /v1/runs",
    "POST",
    "/v1/runs",
    JSON.stringify({
      ...ids,
      harnessId: "custom",
      command: { executable: "sh", args: [MARKER, 7] },
    }),
    "command.args[1] must be a string",
  ],
  [
    "GET /v1/sessions",
    "GET",
    // No marker: the request's span records the URL, query included, for every request.
    "/v1/sessions?workspaceId=wks_1&status=sleeping",
    undefined as never,
    "ownerUserId is required",
  ],
];

describe("a request a control plane route cannot decode", () => {
  for (const [route, method, path, body, reason] of cases) {
    it(`${route}: answers 400 "${reason}", and no observer sees the input`, async () => {
      const server = serve(RequestRefusalLive);
      disposers.push(server.dispose);
      const response = await server.send(method, path, body);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.text)).toMatchObject({ _tag: "RequestRefusedError" });
      expect(response.text).toContain(reason);
      expect(response.text).not.toContain(MARKER);
      expect(server.observed.some((line) => line.startsWith("log "))).toBe(true);
      expect(server.observed.some((line) => line.startsWith("span "))).toBe(true);
      expect(server.observed.join("\n")).not.toContain(MARKER);
      expect(opened).toEqual([]);
    });
  }

  it("takes a valid session with a whitespace-led, multi-line and empty argument", async () => {
    const server = serve(RequestRefusalLive);
    disposers.push(server.dispose);
    const argv = ["bash", "-lc", `\n echo ${MARKER}\n`, ""];
    const response = await server.send("POST", "/v1/sessions", JSON.stringify({ ...ids, argv }));
    expect(response.status).toBe(201);
    expect(opened.map((payload) => payload.argv)).toEqual([argv]);
    expect(server.observed.join("\n")).not.toContain(MARKER);
  });

  it("is what keeps the input out: without it, Effect's refusal reaches the observers", async () => {
    const server = serve(Layer.succeed(RequestRefusal, (httpEffect) => httpEffect));
    disposers.push(server.dispose);
    const response = await server.send(
      "POST",
      "/v1/workspaces/wks_1/exec",
      wrapped({ ownerUserId: "usr_1", commands: [{ executable: "sh", args: [MARKER] }] }),
    );
    expect(response.status).toBe(400);
    expect(response.text).toBe("");
    expect(server.observed.join("\n")).toContain(MARKER);
  });
});

describe("a valid request whose handler fails", () => {
  it("stays the server's failure (500, reported), even when the failure is a SyntaxError", async () => {
    const server = serve(RequestRefusalLive);
    disposers.push(server.dispose);
    const response = await server.send(
      "POST",
      "/v1/sessions",
      JSON.stringify({ ...ids, argv: [HANDLER_SYNTAX_ERROR] }),
    );
    expect(response.status).toBe(500);
    expect(response.text).not.toContain("RequestRefusedError");
    const reported = server.observed.filter((line) => line.startsWith("report "));
    expect(reported.join("\n")).toContain("SyntaxError");
  });
});

describe("RequestRefusal", () => {
  it("reaches every endpoint of the control plane API, so a new route cannot forget it", () => {
    const missing = Object.entries(ControlPlaneAPI.groups).flatMap(([group, { endpoints }]) =>
      Object.entries(endpoints)
        .filter(([, endpoint]) => !endpoint.middlewares.has(RequestRefusal))
        .map(([name]) => `${group}.${name}`),
    );
    expect(missing).toEqual([]);
  });
});
