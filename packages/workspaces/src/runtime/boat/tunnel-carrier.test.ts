import dgram from "node:dgram";

import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { BoatTunnelCarrier, makeBoatTunnelCarrierLayer } from "./tunnel-carrier.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * The agent's `/sealant/tunnel`, as far as sealant can tell: a WebSocket that checks the bearer.
 */
const startAgent = async (options: { readonly refuse?: number } = {}) => {
  const sockets: WebSocket[] = [];
  const received: Buffer[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  let refuse = options.refuse;
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: (info, done) => {
      headers.push(info.req.headers);
      if (refuse !== undefined) return done(false, refuse);
      done(info.req.headers.authorization === "Bearer relay-token");
    },
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data: Buffer) => received.push(Buffer.from(data)));
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server is not on TCP");
  return {
    url: `ws://127.0.0.1:${String(address.port)}/sealant/tunnel`,
    sockets,
    received,
    headers,
    refuseWith: (status: number | undefined) => {
      refuse = status;
    },
  };
};

/** The gateway's published WireGuard port. */
const startGateway = async () => {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const received: { data: Buffer; port: number }[] = [];
  socket.on("message", (data, remote) => received.push({ data, port: remote.port }));
  cleanups.push(() => new Promise<void>((resolve) => socket.close(() => resolve())));
  return { socket, port: socket.address().port, received };
};

const carrierRuntime = (goneAttempts = 3, replacedHoldOffMs = 400) => {
  const runtime = ManagedRuntime.make(
    makeBoatTunnelCarrierLayer({
      reconnectMinMs: 20,
      reconnectMaxMs: 40,
      goneAttempts,
      replacedHoldOffMs,
    }),
  );
  cleanups.push(() => runtime.dispose());
  return runtime;
};
const connection = (url: string) =>
  Effect.succeed(
    Redacted.make({
      url,
      headers: { Authorization: "Bearer relay-token", Cookie: "_port_auth=c" },
    }),
  );

describe("Boat tunnel carrier", () => {
  it("relays each WireGuard datagram between the agent's WebSocket and the gateway's port", async () => {
    const agent = await startAgent();
    const gateway = await startGateway();
    const runtime = carrierRuntime();
    await runtime.runPromise(
      Effect.flatMap(BoatTunnelCarrier, (carrier) =>
        carrier.ensure({
          runId: "run-1",
          connection: connection(agent.url),
          gateway: { host: "127.0.0.1", port: gateway.port },
        }),
      ),
    );
    await waitFor(() => agent.sockets.length === 1);
    expect(agent.headers[0]?.cookie).toBe("_port_auth=c");
    // The agent accepts the connection before the carrier's own `open` has run: attached is
    // waited for, not read straight after the accept.
    await waitFor(() =>
      runtime.runPromise(Effect.flatMap(BoatTunnelCarrier, (c) => c.attached("run-1"))),
    );
    // The VM's handshake initiation, as the agent frames it: one datagram at the gateway.
    agent.sockets[0]?.send(Buffer.from("initiation"), { binary: true });
    await waitFor(() => gateway.received.length === 1);
    expect(gateway.received[0]?.data.toString()).toBe("initiation");
    // The gateway's response goes back to the carrier's own UDP port, and on to the agent.
    const carrierPort = gateway.received[0]?.port ?? 0;
    gateway.socket.send(Buffer.from("response"), carrierPort, "127.0.0.1");
    await waitFor(() => agent.received.length === 1);
    expect(agent.received[0]?.toString()).toBe("response");
    // Text frames are not datagrams.
    agent.sockets[0]?.send("not-a-datagram");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gateway.received).toHaveLength(1);
    // A second ensure for a carried run is a no-op: one connection per run.
    await runtime.runPromise(
      Effect.flatMap(BoatTunnelCarrier, (carrier) =>
        carrier.ensure({
          runId: "run-1",
          connection: connection(agent.url),
          gateway: { host: "127.0.0.1", port: gateway.port },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(agent.sockets).toHaveLength(1);
    // Only the run's own gateway: a datagram from any other port is not the gateway, and is dropped.
    const other = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => other.bind(0, "127.0.0.1", resolve));
    other.send(Buffer.from("not-the-gateway"), carrierPort, "127.0.0.1");
    await new Promise((resolve) => setTimeout(resolve, 150));
    other.close();
    expect(agent.received.map(String)).toEqual(["response"]);
    // The run's gateway moved: the carrier is replaced, and relays to the new port only.
    const moved = await startGateway();
    await runtime.runPromise(
      Effect.flatMap(BoatTunnelCarrier, (carrier) =>
        carrier.ensure({
          runId: "run-1",
          connection: connection(agent.url),
          gateway: { host: "127.0.0.1", port: moved.port },
        }),
      ),
    );
    await waitFor(() => agent.sockets.length === 2);
    await waitFor(() => agent.sockets[1]?.readyState === 1);
    agent.sockets[1]?.send(Buffer.from("after-move"), { binary: true });
    await waitFor(() => moved.received.length === 1);
    expect(gateway.received).toHaveLength(1);
  });

  it("reopens a dropped carrier, holds off when another replaced it, and stops when the agent no longer offers it", async () => {
    const agent = await startAgent();
    const gateway = await startGateway();
    const runtime = carrierRuntime(3);
    const ensure = (runId: string, url = agent.url) =>
      runtime.runPromise(
        Effect.flatMap(BoatTunnelCarrier, (carrier) =>
          carrier.ensure({
            runId,
            connection: connection(url),
            gateway: { host: "127.0.0.1", port: gateway.port },
          }),
        ),
      );
    const attached = (runId: string) =>
      runtime.runPromise(Effect.flatMap(BoatTunnelCarrier, (c) => c.attached(runId)));
    await ensure("run-1");
    await waitFor(() => agent.sockets.length === 1);
    // A dropped connection (the hosted proxy, a restart of the agent): reopened.
    agent.sockets[0]?.terminate();
    await waitFor(() => agent.sockets.length === 2);
    // Replaced by a newer carrier (1012): it does not reconnect at once, and an `ensure` meanwhile
    // (the next reconcile pass) does not restart it either. After its hold-off it tries again.
    agent.sockets[1]?.close(1012);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await ensure("run-1");
    expect(agent.sockets).toHaveLength(2);
    expect(await attached("run-1")).toBe(false);
    await waitFor(() => agent.sockets.length === 3);
    // The run's agent refuses it as gone (404, 409): after the configured attempts, it stops.
    agent.refuseWith(409);
    agent.sockets[2]?.terminate();
    await waitFor(() => agent.headers.length === 3 + 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(agent.headers).toHaveLength(6);
    // Released: closed on demand.
    agent.refuseWith(undefined);
    await ensure("run-2");
    await waitFor(() => agent.sockets.length === 4);
    await runtime.runPromise(Effect.flatMap(BoatTunnelCarrier, (c) => c.release("run-2")));
    await waitFor(() => agent.sockets[3]?.readyState === 3);
    expect(await attached("run-2")).toBe(false);
  });

  it("settles on its first attempt, and neither restarts nor waits on a carrier holding off after a 1012", async () => {
    const agent = await startAgent();
    const gateway = await startGateway();
    const runtime = carrierRuntime(3, 1_000);
    const ensure = (runId: string) =>
      runtime.runPromise(
        Effect.flatMap(BoatTunnelCarrier, (carrier) =>
          carrier.ensure({
            runId,
            connection: connection(agent.url),
            gateway: { host: "127.0.0.1", port: gateway.port },
          }),
        ),
      );
    const settled = (runId: string) =>
      runtime.runPromise(Effect.flatMap(BoatTunnelCarrier, (c) => c.settled(runId)));
    // No carrier: nothing to wait for.
    await settled("run-0");
    // Attached: settled once the upgrade is answered.
    await ensure("run-1");
    await settled("run-1");
    expect(
      await runtime.runPromise(Effect.flatMap(BoatTunnelCarrier, (c) => c.attached("run-1"))),
    ).toBe(true);
    // Replaced by another worker's carrier: it holds off. A worker start's pass (ensure, then
    // settled) neither opens another upgrade nor waits out the hold-off.
    await waitFor(() => agent.sockets.length === 1);
    agent.sockets[0]?.close(1012);
    await waitFor(() => agent.sockets[0]?.readyState === 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await ensure("run-1");
    await settled("run-1");
    expect(Date.now() - started).toBeLessThan(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(agent.headers).toHaveLength(1);
    // After its hold-off it tries again, on its own.
    await waitFor(() => agent.headers.length === 2);
    // Refused: settled too, whatever the answer.
    agent.refuseWith(409);
    await ensure("run-2");
    await settled("run-2");
    expect(
      await runtime.runPromise(Effect.flatMap(BoatTunnelCarrier, (c) => c.attached("run-2"))),
    ).toBe(false);
  });

  it("closes every carrier with its layer", async () => {
    const agent = await startAgent();
    const gateway = await startGateway();
    const runtime = ManagedRuntime.make(Layer.fresh(makeBoatTunnelCarrierLayer()));
    await runtime.runPromise(
      Effect.flatMap(BoatTunnelCarrier, (carrier) =>
        carrier.ensure({
          runId: "run-1",
          connection: connection(agent.url),
          gateway: { host: "127.0.0.1", port: gateway.port },
        }),
      ),
    );
    await waitFor(() => agent.sockets.length === 1);
    await runtime.dispose();
    await waitFor(() => agent.sockets[0]?.readyState === 3);
  });
});
