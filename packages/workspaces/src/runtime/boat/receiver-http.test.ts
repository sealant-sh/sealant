import http from "node:http";
import { connect } from "node:net";

import { Effect, Redacted } from "effect";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { BoatSecret } from "./config.js";
import { createBoatGuestTransport } from "./execution.js";

const secret = (value: string) => {
  const parsed = BoatSecret.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const bearer = secret("b".repeat(64));
const access = {
  origin: "https://receiver-8080.on.boat.dev",
  cookie: secret("test-cookie-which-must-not-be-recorded"),
};
const close: Array<() => Promise<void>> = [];
const unexpected = async (): Promise<never> => {
  throw new Error("unexpected provider request");
};
afterEach(async () => {
  for (const stop of close.splice(0).toReversed()) await stop();
});
const fixture = async (handler: http.RequestListener) => {
  const server = http.createServer(handler);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture port");
  const previous = getGlobalDispatcher();
  // Keep the real HTTPS origin validation and fetch path, while routing its socket to the fixture.
  const dispatcher = new Agent({
    connect: (_options, callback) => {
      const socket = connect({ host: "127.0.0.1", port: address.port });
      socket.once("connect", () => callback(null, socket));
      socket.once("error", (error) => callback(error, null));
      return socket;
    },
  });
  setGlobalDispatcher(dispatcher);
  close.push(async () => {
    setGlobalDispatcher(previous);
    await dispatcher.destroy();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return createBoatGuestTransport(
    { get: unexpected, execute: unexpected, hostControl: unexpected },
    {
      connect: () => Effect.die("unexpected daemon connection"),
      openForwardConnection: () => Effect.die("unexpected forward connection"),
    },
  );
};

describe("hosted Boat receiver HTTP", () => {
  it("waits for a transient hosted receiver 503 using only authenticated GETs", async () => {
    let reads = 0;
    const transport = await fixture((request, response) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("/sealant/bootstrap/status");
      expect(request.headers.cookie).toBe(`_port_auth=${access.cookie.reveal()}`);
      if (++reads < 3) response.writeHead(503).end("upstream not ready");
      else response.end(JSON.stringify({ status: "ready" }));
    });
    expect(await transport.call(access, bearer, "status")).toEqual({ status: "ready" });
    expect(reads).toBe(3);
  });
  it("stops polling at launch cancellation", async () => {
    let reads = 0;
    const received = Promise.withResolvers<void>();
    const transport = await fixture((_request, response) => {
      reads++;
      response.writeHead(503).end("receiver not ready");
      received.resolve();
    });
    const controller = new AbortController();
    const result = transport
      .call(access, bearer, "status", undefined, controller.signal)
      .catch((error: unknown) => error);
    await received.promise;
    controller.abort();
    expect(await result).toMatchObject({
      diagnostic: {
        provider: { operation: "receiver-status" },
        receiver: { pathClass: "/sealant/bootstrap/status" },
      },
    });
    expect(reads).toBe(1);
  });
  it("bounds persistent startup failures without relying on caller cancellation", async () => {
    let reads = 0;
    const transport = await fixture((_request, response) => {
      reads++;
      response.writeHead(503).end("persistent proxy refusal");
    });
    await expect(transport.call(access, bearer, "status")).rejects.toMatchObject({
      diagnostic: {
        provider: { operation: "receiver-status", status: 503 },
        receiver: { responseTail: "persistent proxy refusal" },
      },
    });
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(20);
  }, 25_000);
  it("does not retry an authentication refusal or a non-idempotent request", async () => {
    let reads = 0,
      posts = 0;
    const transport = await fixture((request, response) => {
      if (request.method === "GET") {
        reads++;
        response.writeHead(401).end();
      } else {
        posts++;
        response.writeHead(503).end("proxy unavailable");
      }
    });
    await expect(transport.call(access, bearer, "status")).rejects.toMatchObject({
      diagnostic: { provider: { operation: "receiver-status", status: 401 } },
    });
    await expect(
      transport.call(access, bearer, "start", Redacted.make("{}")),
    ).rejects.toMatchObject({
      diagnostic: { provider: { operation: "receiver-start", status: 503 } },
    });
    expect({ reads, posts }).toEqual({ reads: 1, posts: 1 });
  });
  it("cancels a stalled HTTP response within the launch budget", async () => {
    const received = Promise.withResolvers<void>();
    const transport = await fixture((_request, response) => {
      response.writeHead(503);
      response.flushHeaders();
      response.write("proxy waiting");
      received.resolve();
    });
    const controller = new AbortController();
    const result = transport
      .call(access, bearer, "status", undefined, controller.signal)
      .catch((error: unknown) => error);
    await received.promise;
    controller.abort();
    expect(await result).toMatchObject({
      diagnostic: {
        provider: { operation: "receiver-status" },
        receiver: { pathClass: "/sealant/bootstrap/status" },
      },
    });
  });
  it("bounds and cancels oversized failure bodies without awaiting their end", async () => {
    const transport = await fixture((_request, response) => {
      response.writeHead(503);
      response.write("upstream unavailable\n" + "x".repeat(40_000));
    });
    const failure = await transport
      .call(access, bearer, "stage", Redacted.make("{}"))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ diagnostic: { provider: { status: 503 } } });
    expect(String(failure).length).toBeLessThan(5_000);
  });
  it.each([
    {
      status: 400,
      body: '{"class":"ValueError","detail":"/usr/bin/systemctl","error":"semantic-command-failed"}',
      code: "receiver-rejected",
      reason: "semantic-command-failed",
      detail: "/usr/bin/systemctl",
    },
    {
      status: 401,
      body: '{"error":"unauthorized"}',
      code: "receiver-unauthorized",
      reason: "unauthorized",
    },
    { status: 404, body: "", code: "receiver-route-missing" },
    {
      status: 409,
      body: '{"error":"workspace-limits-unavailable"}',
      code: "receiver-refused",
      reason: "workspace-limits-unavailable",
    },
    {
      // Same status, transient reason: a lost DNS answer is retried, a policy refusal is not.
      status: 409,
      body: '{"error":"tunnel-dns-unavailable","retryable":true}',
      code: "receiver-not-ready",
      reason: "tunnel-dns-unavailable",
    },
    {
      status: 503,
      body: '{"class":"OSError","error":"receiver-unavailable"}',
      code: "transport-unavailable",
      reason: "receiver-unavailable",
    },
  ])("classifies a receiver $status as $code and keeps its reason", async (input) => {
    const transport = await fixture((_request, response) => {
      response.writeHead(input.status).end(input.body);
    });
    const failure = await transport
      .call(access, bearer, "permit", Redacted.make("{}"))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: input.code,
      diagnostic: {
        code: input.code,
        provider: { operation: "receiver-permit", status: input.status },
        receiver: {
          pathClass: "/sealant/bootstrap/permit",
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.detail === undefined ? {} : { detail: input.detail }),
        },
      },
    });
    expect(String(failure)).toContain(input.code);
  });
  it("retains the failing operation, fixed path and redacted response through a real HTTP 503", async () => {
    const transport = await fixture((request, response) => {
      expect(request.url).toBe("/sealant/bootstrap/stage");
      expect(request.headers.authorization).toBe(`Bearer ${bearer.reveal()}`);
      response
        .writeHead(503)
        .end(
          `upstream unavailable ${bearer.reveal()} ${access.cookie.reveal()} ${"private-stage-data"} ` +
            "https://host.invalid/?secret=private-url token=private-token",
        );
    });
    const failure = await transport
      .call(access, bearer, "stage", Redacted.make(JSON.stringify({ data: "private-stage-data" })))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      diagnostic: {
        step: "receiver-request",
        provider: { operation: "receiver-stage", status: 503 },
        receiver: {
          pathClass: "/sealant/bootstrap/stage",
          responseTail: expect.stringContaining("upstream unavailable"),
        },
      },
    });
    const logged = String(failure);
    for (const value of [
      bearer.reveal(),
      access.cookie.reveal(),
      "private-stage-data",
      "private-url",
      "private-token",
    ])
      expect(logged).not.toContain(value);
  });
});
