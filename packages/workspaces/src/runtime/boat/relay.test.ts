import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, createWebSocketStream } from "ws";

import receiverRoutes from "../../../boat-image/receiver-routes.json" with { type: "json" };
import { SealantRuntime, SealantRuntimeControlLive } from "../../sealantd/runtime.js";
import { BoatReadinessError } from "../../worker/boat-readiness.js";
import { BoatSecret } from "./config.js";
import { BoatExecutionError, createBoatGuestTransport } from "./execution.js";
import { boatLaunchDiagnostic } from "./launch-diagnostics.js";

const source = fileURLToPath(new URL("../../../boat-image/control-relay.mjs", import.meta.url));
const builder = fileURLToPath(new URL("../../../boat-image/build-relay.mjs", import.meta.url));
const spike = fileURLToPath(new URL("../../../boat-image/spike.ts", import.meta.url));
const token = "a".repeat(64);
/** guest_control.py's verdict line: written once, before any daemon byte. */
const verdict = (fields: Record<string, string>) =>
  `${JSON.stringify({ format: "sealant-control-bridge-v1", ...fields })}\n`;
const connected = verdict({ control: "connected" });
let directory: string;
let bundled: string;
const resources: Array<() => Promise<void>> = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "sealant-boat-relay-test-"));
  bundled = join(directory, "control-relay.cjs");
  const child = spawn(process.execPath, [builder, bundled], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdio: "ignore",
  });
  expect((await once(child, "exit"))[0]).toBe(0);
});
afterEach(async () => {
  for (const stop of resources.splice(0).toReversed()) await stop();
});
afterAll(async () => {
  const paths = await readdir(directory);
  expect(paths.every((path) => path.startsWith("case-") || path === "control-relay.cjs")).toBe(
    true,
  );
  await rm(directory, { recursive: true });
});
const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise<void>((done) => setTimeout(done, 10));
  }
  throw new Error("condition did not complete");
};
const stopChild = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
};
const fixture = async (
  entry = source,
  behavior: (socket: net.Socket) => void = (socket) => {
    socket.pipe(socket);
  },
  bootstrapSocket?: string,
  bridgeVerdict: string | null = connected,
) => {
  const path = await mkdtemp(join(directory, "case-"));
  const socketPath = join(path, "control.sock");
  const tokenPath = join(path, "relay.token");
  await writeFile(tokenPath, token, { mode: 0o600 });
  const sockets = new Set<net.Socket>();
  const unix = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    if (bridgeVerdict !== null) socket.write(bridgeVerdict);
    behavior(socket);
  });
  await new Promise<void>((done) => unix.listen(socketPath, done));
  resources.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done, failed) =>
      unix.close((error) => {
        if (error) {
          failed(error);
          return;
        }
        done();
      }),
    );
  });
  const listener = net.createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("no test TCP port");
  await new Promise<void>((done) => listener.close(() => done()));
  const child = spawn(
    process.execPath,
    [
      entry,
      "--token-file",
      tokenPath,
      "--socket",
      socketPath,
      "--port",
      String(address.port),
      ...(bootstrapSocket ? ["--bootstrap-socket", bootstrapSocket] : []),
    ],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  resources.push(() => stopChild(child));
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  await waitFor(() => output.includes("Relay listening"));
  return { origin: `http://127.0.0.1:${address.port}`, socketPath, sockets, child, tokenPath };
};
const connect = async (
  origin: string,
  path = "/sealant/control?probe=query",
  headers: Record<string, string> = { Authorization: `Bearer ${token}` },
) => {
  const websocket = new WebSocket(`${origin.replace(/^http:/, "ws:")}${path}`, {
    headers,
    handshakeTimeout: 1000,
    perMessageDeflate: false,
  });
  websocket.on("error", () => undefined);
  await once(websocket, "open");
  resources.push(async () => {
    websocket.terminate();
  });
  return websocket;
};

describe("standalone Boat relay", () => {
  it.each(["source", "bundle"])(
    "bounds and authenticates private bootstrap forwarding with %s",
    async (kind) => {
      const path = await mkdtemp(join(directory, "case-bootstrap-"));
      const bootstrapSocket = join(path, "bootstrap.sock");
      const received: Array<{
        path: string | undefined;
        authorization: string | undefined;
        body: string;
      }> = [];
      const upstream = http.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          received.push({ path: request.url, authorization: request.headers.authorization, body });
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ admission: "held" }));
        });
      });
      await new Promise<void>((done) => upstream.listen(bootstrapSocket, done));
      resources.push(async () => {
        upstream.closeAllConnections();
        await new Promise<void>((done) => upstream.close(() => done()));
      });
      const relay = await fixture(kind === "bundle" ? bundled : source, undefined, bootstrapSocket);
      const route = `${relay.origin}/sealant/bootstrap/stage`;
      const body = JSON.stringify({ privatePayload: "not-a-real-secret" });
      expect((await fetch(route, { method: "POST", body })).status).toBe(401);
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const response = await fetch(route, { method: "POST", headers, body });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ admission: "held" });
      expect(received).toEqual([
        { path: "/sealant/bootstrap/stage", authorization: `Bearer ${token}`, body },
      ]);
      expect(
        (
          await fetch(route, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body,
          })
        ).status,
      ).toBe(400);
      expect((await fetch(route, { method: "GET", headers })).status).toBe(404);
      expect(
        (await fetch(`${relay.origin}/sealant/bootstrap/start`, { method: "POST", headers, body }))
          .status,
      ).toBe(200);
      expect((await fetch(`${relay.origin}/sealant/bootstrap/status`, { headers })).status).toBe(
        200,
      );
      expect(
        (
          await fetch(`${relay.origin}/sealant/bootstrap/isolate`, {
            method: "POST",
            headers,
            body,
          })
        ).status,
      ).toBe(200);
      expect(
        (await fetch(`${relay.origin}/sealant/bootstrap/isolate`, { method: "POST", body })).status,
      ).toBe(401);
      for (const name of ["permit", "readiness"]) {
        const target = `${relay.origin}/sealant/bootstrap/${name}`;
        expect((await fetch(target, { method: "POST", body })).status).toBe(401);
        expect((await fetch(target, { method: "POST", headers, body })).status).toBe(200);
        expect(received.at(-1)).toEqual({
          path: `/sealant/bootstrap/${name}`,
          authorization: `Bearer ${token}`,
          body,
        });
      }
      expect(received).toHaveLength(6);
      expect(relay.sockets.size).toBe(0);
      await new Promise<void>((done) => upstream.close(() => done()));
      expect((await fetch(`${relay.origin}/sealant/bootstrap/status`, { headers })).status).toBe(
        503,
      );
    },
  );

  it.each(["source", "bundle"])(
    "forwards every route in the shared receiver list and refuses its other method with %s",
    async (kind) => {
      const path = await mkdtemp(join(directory, "case-routes-"));
      const bootstrapSocket = join(path, "bootstrap.sock");
      const received: string[] = [];
      const upstream = http.createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          received.push(`${request.method} ${request.url}`);
          response.writeHead(200, { "content-type": "application/json" }).end("{}");
        });
      });
      await new Promise<void>((done) => upstream.listen(bootstrapSocket, done));
      resources.push(async () => {
        upstream.closeAllConnections();
        await new Promise<void>((done) => upstream.close(() => done()));
      });
      const relay = await fixture(kind === "bundle" ? bundled : source, undefined, bootstrapSocket);
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      for (const route of receiverRoutes.routes) {
        const response = await fetch(`${relay.origin}${route.path}`, {
          method: route.method,
          headers,
          ...(route.method === "POST" ? { body: "{}" } : {}),
        });
        expect([route.path, response.status]).toEqual([route.path, 200]);
        const other = await fetch(`${relay.origin}${route.path}`, {
          method: route.method === "POST" ? "GET" : "POST",
          headers,
          ...(route.method === "GET" ? { body: "{}" } : {}),
        });
        expect([route.path, other.status]).toEqual([route.path, 404]);
      }
      expect(received).toEqual(
        receiverRoutes.routes.map((route) => `${route.method} ${route.path}`),
      );
    },
  );

  it("keeps a forwarded request open past the 5 s idle cutoff, within its route budget", async () => {
    const path = await mkdtemp(join(directory, "case-slow-"));
    const bootstrapSocket = join(path, "bootstrap.sock");
    const upstream = http.createServer((request, response) => {
      request.resume();
      // Longer than the relay's 5 s idle cutoff, well inside the route budget.
      setTimeout(() => response.writeHead(200).end(JSON.stringify({ slow: true })), 7_000);
    });
    await new Promise<void>((done) => upstream.listen(bootstrapSocket, done));
    resources.push(async () => {
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
    });
    const relay = await fixture(source, undefined, bootstrapSocket);
    const began = Date.now();
    const response = await fetch(`${relay.origin}/sealant/bootstrap/permit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slow: true });
    expect(Date.now() - began).toBeGreaterThan(6_500);
  }, 20_000);

  it("answers 504 when the receiver overruns its route budget, before closing the caller", async () => {
    const path = await mkdtemp(join(directory, "case-overrun-"));
    const bootstrapSocket = join(path, "bootstrap.sock");
    const held = new Set<http.ServerResponse>();
    // Never answers: status's 5 s budget plus the relay's 5 s grace must end in a 504.
    const upstream = http.createServer((request, response) => {
      request.resume();
      held.add(response);
    });
    await new Promise<void>((done) => upstream.listen(bootstrapSocket, done));
    resources.push(async () => {
      for (const response of held) response.destroy();
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
    });
    const relay = await fixture(source, undefined, bootstrapSocket);
    const status = receiverRoutes.routes.find((route) => route.name === "status");
    if (status === undefined) throw new Error("status route missing from the shared list");
    const began = Date.now();
    const response = await fetch(`${relay.origin}${status.path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(504);
    expect(Date.now() - began).toBeGreaterThanOrEqual(status.budgetMs + 5_000 - 100);
  }, 20_000);

  it.each(["source", "bundle"])(
    "authenticates both routes and forwards binary bytes with %s artifact",
    async (kind) => {
      const relay = await fixture(kind === "bundle" ? bundled : source);
      for (const path of [
        "/sealant/health",
        "/sealant/launch",
        "/aws/lambda-microvms/runtime/v1/terminate",
      ]) {
        expect((await fetch(`${relay.origin}${path}`)).status).toBe(401);
      }
      const headers = { Authorization: `Bearer ${token}` };
      const response = await fetch(`${relay.origin}/sealant/health?probe=1`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        controlSocket: "reachable",
        nativeReadiness: "unverified",
      });
      expect(
        (await fetch(`${relay.origin}/sealant/launch`, { method: "POST", headers })).status,
      ).toBe(404);
      expect(
        (await fetch(`${relay.origin}/sealant/health`, { method: "POST", headers })).status,
      ).toBe(404);
      const websocket = await connect(relay.origin);
      const stream = createWebSocketStream(websocket, { allowHalfOpen: false });
      stream.on("error", () => undefined);
      const received = once(stream, "data");
      const bytes = Buffer.from([0, 0, 0, 5, 255, 0, 128, 42, 13]);
      stream.write(bytes);
      expect((await received)[0]).toEqual(bytes);
      stream.destroy();
      await waitFor(() => relay.sockets.size === 0);
    },
  );

  it.each([
    { path: "/sealant/control?probe=1", headers: {}, status: 401 },
    { path: "/sealant/control", headers: { Authorization: "Bearer wrong" }, status: 401 },
    { path: "/sealant/recover", headers: { Authorization: `Bearer ${token}` }, status: 404 },
  ])("refuses unauthenticated or unknown WebSocket upgrades", async (input) => {
    const relay = await fixture();
    const websocket = new WebSocket(`${relay.origin.replace(/^http:/, "ws:")}${input.path}`, {
      headers: input.headers,
      handshakeTimeout: 1000,
    });
    websocket.on("error", () => undefined);
    const status = await new Promise<number | undefined>((done) =>
      websocket.once("unexpected-response", (_request, response) => {
        response.resume();
        done(response.statusCode);
        websocket.terminate();
      }),
    );
    expect(status).toBe(input.status);
    expect(relay.sockets.size).toBe(0);
  });

  const refusal = async (origin: string) => {
    const websocket = new WebSocket(`${origin.replace(/^http:/, "ws:")}/sealant/control`, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 7000,
    });
    websocket.on("error", () => undefined);
    return new Promise<{ status: number | undefined; body: string }>((done) =>
      websocket.once("unexpected-response", (_request, response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.once("end", () => {
          done({ status: response.statusCode, body });
          websocket.terminate();
        });
      }),
    );
  };

  it.each(["source", "bundle"])(
    "answers the bridge's refusal reason instead of upgrading with %s artifact",
    async (kind) => {
      const relay = await fixture(
        kind === "bundle" ? bundled : source,
        (socket) => socket.end(),
        undefined,
        verdict({ error: "control-peer-changed" }),
      );
      expect(await refusal(relay.origin)).toEqual({
        status: 503,
        body: JSON.stringify({ error: "control-peer-changed" }),
      });
      await waitFor(() => relay.sockets.size === 0);
    },
  );

  it.each([
    { name: "closes without a verdict", answer: null },
    { name: "sends a malformed verdict", answer: "connected\n" },
    { name: "names a free-text reason", answer: verdict({ error: "Peer Was Wrong" }) },
  ])("answers control-unavailable when the bridge $name", async ({ answer }) => {
    const relay = await fixture(source, (socket) => socket.end(), undefined, answer);
    expect(await refusal(relay.origin)).toEqual({
      status: 503,
      body: JSON.stringify({ error: "control-unavailable" }),
    });
  });

  it.each([
    {
      name: "the bridge's refusal",
      verdict: verdict({ error: "control-peer-changed" }),
      behavior: (socket: net.Socket) => socket.end(),
      control: { operation: "open", status: 503, reason: "control-peer-changed" },
    },
    {
      name: "a daemon that closes before answering",
      verdict: connected,
      behavior: (socket: net.Socket) => socket.once("data", () => socket.end()),
      control: { operation: "health" },
    },
  ])("keeps $name in Core's readiness diagnostic", async (input) => {
    const relay = await fixture(source, input.behavior, undefined, input.verdict);
    const parse = (value: string) => {
      const parsed = BoatSecret.parse(value);
      if (!parsed.ok) throw parsed.error;
      return parsed.value;
    };
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const unused = async (): Promise<never> => {
          throw new Error("the probe must not contact the provider");
        };
        const transport = createBoatGuestTransport(
          { get: unused, execute: unused, hostControl: unused },
          runtime,
        );
        return yield* Effect.promise(() =>
          transport
            .probe({ origin: relay.origin, cookie: parse("local-cookie-only") }, parse(token))
            .then(
              () => undefined,
              (error: unknown) => error,
            ),
        );
      }).pipe(Effect.provide(SealantRuntimeControlLive)),
    );
    expect(failure).toBeInstanceOf(BoatExecutionError);
    const diagnostic = boatLaunchDiagnostic(failure, "readiness");
    expect(diagnostic).toEqual({
      step: "readiness",
      errorClass: "TransportError",
      code: "transport-unavailable",
      control: input.control,
    });
    // The readiness boundary's message is what the runtime row keeps.
    expect(new BoatReadinessError("unavailable", diagnostic).message).toContain(
      JSON.stringify(input.control),
    );
  });

  it("delivers daemon bytes that arrive in the same read as the verdict", async () => {
    const relay = await fixture(
      source,
      (socket) => socket.write(Buffer.concat([Buffer.from(connected), Buffer.from([7, 0, 9])])),
      undefined,
      null,
    );
    const websocket = await connect(relay.origin);
    const stream = createWebSocketStream(websocket, { allowHalfOpen: false });
    stream.on("error", () => undefined);
    expect((await once(stream, "data"))[0]).toEqual(Buffer.from([7, 0, 9]));
    stream.destroy();
    await waitFor(() => relay.sockets.size === 0);
  });

  it("returns unavailable when the Unix socket is absent", async () => {
    const relay = await fixture();
    await rm(relay.socketPath);
    const response = await fetch(`${relay.origin}/sealant/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      controlSocket: "unavailable",
      nativeReadiness: "unverified",
    });
  });

  it("propagates guest disconnect and closes every paired resource on shutdown", async () => {
    const relay = await fixture();
    const websocket = await connect(relay.origin);
    await waitFor(() => relay.sockets.size === 1);
    const closed = once(websocket, "close");
    for (const socket of relay.sockets) socket.destroy();
    await closed;
    await waitFor(() => relay.sockets.size === 0);
    const second = await connect(relay.origin);
    const secondClosed = once(second, "close");
    await stopChild(relay.child);
    await secondClosed;
    await waitFor(() => relay.sockets.size === 0);
  });

  it("keeps a multi-message transfer intact when the Unix peer applies backpressure", async () => {
    const relay = await fixture(source, (socket) => {
      socket.pause();
      setTimeout(() => {
        socket.pipe(socket);
        socket.resume();
      }, 100);
    });
    const websocket = await connect(relay.origin);
    const stream = createWebSocketStream(websocket, { allowHalfOpen: false, highWaterMark: 4096 });
    stream.on("error", () => undefined);
    const bytes = Buffer.alloc(4 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const chunks: Buffer[] = [];
    let length = 0;
    const complete = new Promise<Buffer>((done) =>
      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        length += chunk.length;
        if (length === bytes.length) done(Buffer.concat(chunks));
      }),
    );
    let backpressured = false;
    for (let index = 0; index < bytes.length; index += 64 * 1024) {
      if (!stream.write(bytes.subarray(index, index + 64 * 1024))) {
        backpressured = true;
        await once(stream, "drain");
      }
    }
    expect((await complete).equals(bytes)).toBe(true);
    expect(backpressured).toBe(true);
    stream.destroy();
    await waitFor(() => relay.sockets.size === 0);
  });

  it("closes oversized messages and the corresponding Unix connection", async () => {
    const relay = await fixture(source, () => undefined);
    const websocket = await connect(relay.origin);
    const closed = once(websocket, "close");
    websocket.send(Buffer.alloc(16 * 1024 * 1024 + 1));
    await closed;
    await waitFor(() => relay.sockets.size === 0);
    expect(
      (
        await fetch(`${relay.origin}/sealant/health`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
  });

  it("delivers the final guest bytes before closing a slow WebSocket reader", async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024, 173);
    const relay = await fixture(source, (socket) => {
      socket.once("data", () => socket.end(bytes));
    });
    const websocket = await connect(relay.origin);
    const stream = createWebSocketStream(websocket, { highWaterMark: 4096 });
    const closed = once(websocket, "close");
    stream.on("error", () => undefined);
    stream.pause();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = once(stream, "end");
    stream.write(Buffer.from("finish"));
    await new Promise<void>((done) => setTimeout(done, 100));
    stream.resume();
    await ended;
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect((await closed)[0]).toBe(1005);
    await waitFor(() => relay.sockets.size === 0);
  });

  it("rejects a readable-by-others token file without exposing the token", async () => {
    const path = await mkdtemp(join(directory, "case-"));
    const tokenPath = join(path, "token");
    await writeFile(tokenPath, token, { mode: 0o644 });
    const child = spawn(
      process.execPath,
      [source, "--token-file", tokenPath, "--socket", join(path, "none.sock"), "--port", "8080"],
      { env: {}, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    expect((await once(child, "exit"))[0]).toBe(2);
    expect(output).toBe("Invalid relay configuration\n");
    expect(output).not.toContain(token);
  });

  it("exits unsuccessfully when its listener cannot bind", async () => {
    const path = await mkdtemp(join(directory, "case-"));
    const tokenPath = join(path, "token");
    await writeFile(tokenPath, token, { mode: 0o600 });
    const listener = net.createServer();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    resources.push(() => new Promise<void>((done) => listener.close(() => done())));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("no occupied TCP port");
    const child = spawn(
      process.execPath,
      [
        source,
        "--token-file",
        tokenPath,
        "--socket",
        join(path, "control.sock"),
        "--port",
        String(address.port),
      ],
      {
        env: {},
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    resources.push(() => stopChild(child));
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    expect((await once(child, "exit"))[0]).toBe(1);
    expect(output).toBe("Relay listener failed\n");
  });

  it("fails the opt-in runner before allocation when no native daemon is supplied", async () => {
    const tsx = fileURLToPath(
      new URL("../../../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    await readFile(tsx);
    const child = spawn(process.execPath, [tsx, spike], {
      env: { BOAT_API_KEY: "boat_fake_key_for_local_cli_test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    expect((await once(child, "exit"))[0]).toBe(1);
    expect(output).toContain("native_daemon_required");
    expect(output).not.toContain("boat_fake_key");
  });

  it("rejects a non-amd64 ELF before allocation", async () => {
    const path = await mkdtemp(join(directory, "case-"));
    const daemon = join(path, "wrong-architecture");
    const bytes = Buffer.alloc(64);
    bytes.write("7f454c46", "hex");
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(183, 18);
    await writeFile(daemon, bytes, { mode: 0o700 });
    const tsx = fileURLToPath(
      new URL("../../../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [tsx, spike, "--sealantd", daemon], {
      env: { BOAT_API_KEY: "boat_fake_key_for_local_cli_test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    expect((await once(child, "exit"))[0]).toBe(1);
    expect(output).toContain("invalid_native_daemon");
    expect(output).not.toContain("boat_fake_key");
  });
});
