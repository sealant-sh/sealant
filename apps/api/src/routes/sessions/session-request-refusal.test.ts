/**
 * A session create the contract cannot decode answers `400` `SessionBadRequestError` with a
 * value-free reason, and neither the body nor the request log carries the rejected input. Served
 * through HttpApiBuilder and the router's default request logger, as the API serves it; the
 * handlers are stubs, since a refused request never reaches them.
 */
import {
  SessionRequestRefusal,
  SessionsGroup,
  type CreateSessionRequest,
  type SessionWire,
} from "@sealant/api-contracts";
import { Cause, Effect, Layer, Logger } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { afterEach, describe, expect, it } from "vitest";

import { SessionRequestRefusalLive } from "./session-request-refusal.js";

const MARKER = "review347-secret-marker";

const TestApi = HttpApi.make("sessionRefusalTest").add(SessionsGroup.prefix("/v1/sessions"));

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

const unreachable = () => Effect.die("not under test");

const handlers = HttpApiBuilder.group(TestApi, "sessions", (h) =>
  h
    .handle("createSession", ({ payload }) =>
      Effect.sync(() => {
        opened.push(payload);
        return session(payload);
      }),
    )
    .handle("createSessionAsUser", ({ payload }) =>
      Effect.sync(() => {
        opened.push(payload);
        return session(payload);
      }),
    )
    .handle("listSessions", unreachable)
    .handle("getSession", unreachable)
    .handle("getSessionOutput", unreachable)
    .handle("sendSessionInput", unreachable)
    .handle("resizeSession", unreachable)
    .handle("signalSession", unreachable)
    .handle("closeSession", unreachable),
);

/** Every log line the server writes, with its message and cause, as text. */
const serve = (refusal: Layer.Layer<SessionRequestRefusal>) => {
  const lines: string[] = [];
  const capture = Logger.make((options) => {
    lines.push(`${JSON.stringify(options.message)} ${Cause.pretty(options.cause)}`);
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(
      HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(handlers),
        Layer.provide(refusal),
        Layer.provide(HttpServer.layerServices),
      ),
      Logger.layer([capture]),
    ),
  );
  const post = async (path: string, body: string) => {
    const response = await handler(
      new Request(`http://localhost/v1/sessions${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    return { status: response.status, text: await response.text() };
  };
  return { post, lines, dispose };
};

let disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.map((dispose) => dispose()));
  disposers = [];
  opened.length = 0;
});

const ids = { workspaceId: "wks_1", ownerUserId: "usr_1" };

/** Requests the contract cannot decode, each carrying the marker where a secret could be. */
const malformed: ReadonlyArray<readonly [string, string, string]> = [
  ["argv of the wrong type", JSON.stringify({ ...ids, argv: MARKER }), "argv must be an array"],
  [
    "an argument of the wrong type",
    JSON.stringify({ ...ids, argv: ["printf", { secret: MARKER }] }),
    "argv[1] must be a string",
  ],
  [
    "a valid request wrapped in an array",
    JSON.stringify([{ ...ids, argv: ["printf", MARKER] }]),
    "the request body must be a JSON object",
  ],
  [
    "a missing field beside a valid argument",
    JSON.stringify({ workspaceId: "wks_1", argv: ["printf", MARKER] }),
    "ownerUserId is required",
  ],
  ["invalid JSON", `{"workspaceId":"wks_1","argv":["printf","${MARKER}"`, "not valid JSON"],
  [
    "an argument the rule refuses",
    JSON.stringify({ ...ids, argv: ["printf", `${MARKER}\u0000`] }),
    "argv[1] contains a NUL byte",
  ],
  [
    "an untrimmed program",
    JSON.stringify({ ...ids, argv: [` ${MARKER}`, "-c", "true"] }),
    "argv[0], the program, must be non-empty",
  ],
  [
    "another field of the wrong type",
    JSON.stringify({ ...ids, argv: ["printf", MARKER], cols: "wide" }),
    "cols is missing or invalid",
  ],
];

describe("a session create the contract cannot decode", () => {
  for (const path of ["", "/as-user"]) {
    const route = path === "" ? "POST /v1/sessions" : "POST /v1/sessions/as-user";
    for (const [name, body, reason] of malformed) {
      it(`${route}: ${name} answers 400 with the reason, and nothing quotes the input`, async () => {
        const server = serve(SessionRequestRefusalLive);
        disposers.push(server.dispose);
        const sent =
          path === "" || body.startsWith("[") || !body.endsWith("}")
            ? body
            : `${body.slice(0, -1)},"user":"m4lice000"}`;
        const response = await server.post(path, sent);
        expect(response.status).toBe(400);
        const answer: unknown = JSON.parse(response.text);
        expect(answer).toMatchObject({ _tag: "SessionBadRequestError" });
        expect(response.text).toContain(reason);
        expect(response.text).not.toContain(MARKER);
        expect(server.lines.length).toBeGreaterThan(0);
        expect(server.lines.join("\n")).not.toContain(MARKER);
        expect(opened).toEqual([]);
      });
    }
  }

  it("takes a valid request with a whitespace-led, multi-line and empty argument", async () => {
    const server = serve(SessionRequestRefusalLive);
    disposers.push(server.dispose);
    const argv = ["bash", "-lc", `\n echo ${MARKER}\n`, ""];
    const response = await server.post("", JSON.stringify({ ...ids, argv }));
    expect(response.status).toBe(201);
    expect(opened.map((payload) => payload.argv)).toEqual([argv]);
    expect(server.lines.join("\n")).not.toContain(MARKER);
  });

  it("is what keeps the input out of the log: Effect's own refusal quotes it", async () => {
    const server = serve(Layer.succeed(SessionRequestRefusal, (httpEffect) => httpEffect));
    disposers.push(server.dispose);
    const response = await server.post("", JSON.stringify({ ...ids, argv: MARKER }));
    expect(response.status).toBe(400);
    expect(response.text).toBe("");
    expect(server.lines.join("\n")).toContain(MARKER);
  });
});
