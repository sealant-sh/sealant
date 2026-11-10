/**
 * Core's end of a Boat resource tunnel carried over HTTPS. The VM's WireGuard sends its datagrams
 * to the agent's loopback relay, and the agent puts each one in a binary frame on
 * `/sealant/tunnel`. This end opens that WebSocket through Boat's hosted endpoint, the same
 * outbound HTTPS Core uses for every agent route, and relays each frame to the gateway's WireGuard
 * port on this host, and each of the gateway's datagrams back. Neither the VM nor the gateway's
 * host takes an inbound connection, as with a MicroVM.
 *
 * WireGuard is the authority on both ends: a lost frame is a lost datagram, which it retransmits,
 * and a dropped carrier is reopened while WireGuard re-handshakes on its keepalive. A carrier that
 * cannot keep up drops, as UDP would, and never buffers.
 */
import dgram from "node:dgram";

import { Context, Effect, Layer, Redacted } from "effect";
import { WebSocket } from "ws";

import type { BoatTunnelConnection } from "./execution.js";

/** What one run's carrier connects: the agent (fresh material per connect) and the gateway. */
export interface BoatTunnelCarrierInput {
  readonly runId: string;
  /** Read again for every (re)connect: the hosted cookie may expire. */
  readonly connection: Effect.Effect<Redacted.Redacted<BoatTunnelConnection>, unknown>;
  /** The gateway's published WireGuard port, as this worker reaches it. */
  readonly gateway: { readonly host: string; readonly port: number };
}

export class BoatTunnelCarrier extends Context.Service<
  BoatTunnelCarrier,
  {
    /** Keep a carrier open for the run; a no-op while one is. Never fails: it reconnects itself. */
    readonly ensure: (input: BoatTunnelCarrierInput) => Effect.Effect<void>;
    /** Close the run's carrier, if any: the run is held or gone. */
    readonly release: (runId: string) => Effect.Effect<void>;
    /** Whether the run's carrier is connected to the agent now. */
    readonly attached: (runId: string) => Effect.Effect<boolean>;
    /**
     * Completes once the run's carrier has made its first attempt to connect, attached or not: at
     * once for a run with no carrier, or one that already tried (one holding off included). A
     * caller that opens many carriers waits on it to bound how many upgrades are in flight.
     */
    readonly settled: (runId: string) => Effect.Effect<void>;
  }
>()("@sealant/workspaces/boat/BoatTunnelCarrier") {}

export interface BoatTunnelCarrierOptions {
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  readonly pingIntervalMs?: number;
  /**
   * Refusals in a row that say the run is gone (401, 403, 404, 409, 410), after which the carrier
   * stops until the next `ensure`. A transient one (a 5xx, a reset) is retried without limit.
   */
  readonly goneAttempts?: number;
  /**
   * How long a carrier the agent replaced with a newer one (1012) waits before it tries again. It
   * stays registered meanwhile, so `ensure` does not restart it: two workers that each think they
   * own a run do not keep displacing each other, and one that does own it gets it back.
   */
  readonly replacedHoldOffMs?: number;
  readonly log?: (message: string) => void;
}

const MAX_DATAGRAM_BYTES = 65_535;
const BACKLOG_BYTES = 1024 * 1024;
const GONE_STATUSES = new Set([401, 403, 404, 409, 410]);
/** The agent closes a carrier another one replaced with 1012: that one owns the run now. */
const REPLACED = 1012;

interface Carrier {
  /** The gateway port it relays to: a carrier only ever bridges its own run's gateway. */
  readonly gateway: BoatTunnelCarrierInput["gateway"];
  readonly attached: () => boolean;
  /** Resolves when its first connection attempt ends, or it stops. Never rejects. */
  readonly settled: Promise<void>;
  readonly stop: () => void;
}

const startCarrier = (
  input: BoatTunnelCarrierInput,
  options: Required<Omit<BoatTunnelCarrierOptions, "log">> & {
    readonly log: (message: string) => void;
  },
  stopped: () => void,
): Carrier => {
  let done = false;
  let socket: WebSocket | null = null;
  let delay = options.reconnectMinMs;
  let gone = 0;
  let timer: NodeJS.Timeout | undefined;
  const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
  // Connected to the run's own gateway port: the kernel hands it that peer's datagrams only.
  const udp = dgram.createSocket("udp4");
  udp.on("error", () => {});
  udp.on("message", (datagram) => {
    if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < BACKLOG_BYTES)
      socket.send(datagram, { binary: true });
  });
  const stop = () => {
    if (done) return;
    done = true;
    settle();
    clearTimeout(timer);
    socket?.close(1000);
    socket = null;
    try {
      udp.close();
    } catch {
      // Never connected.
    }
    stopped();
  };
  const schedule = () => {
    if (done) return;
    timer = setTimeout(() => void connect(), delay);
    delay = Math.min(delay * 2, options.reconnectMaxMs);
  };
  const connect = async () => {
    if (done) return;
    let material: BoatTunnelConnection;
    try {
      material = Redacted.value(await Effect.runPromise(input.connection));
    } catch {
      // The run's record no longer offers a carrier (held, gone) or could not be read now.
      settle();
      gone += 1;
      if (gone >= options.goneAttempts) return stop();
      return schedule();
    }
    if (done) return;
    const ws = new WebSocket(material.url, { headers: material.headers, perMessageDeflate: false });
    socket = ws;
    let replaced = false;
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, options.pingIntervalMs);
    ws.on("open", () => {
      settle();
      delay = options.reconnectMinMs;
      gone = 0;
      options.log(`Boat tunnel carrier · run ${input.runId}: attached`);
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const datagram = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (datagram.length <= MAX_DATAGRAM_BYTES) udp.send(datagram);
    });
    ws.on("unexpected-response", (request, response) => {
      if (GONE_STATUSES.has(response.statusCode ?? 0)) gone += 1;
      response.resume();
      request.destroy();
      ws.terminate();
    });
    ws.on("error", () => {});
    ws.on("close", (code) => {
      settle();
      clearInterval(ping);
      if (socket === ws) socket = null;
      if (code === REPLACED) replaced = true;
      if (done) return;
      if (replaced) {
        options.log(
          `Boat tunnel carrier · run ${input.runId}: replaced by another carrier; trying again in ${String(Math.round(options.replacedHoldOffMs / 1000))} s`,
        );
        delay = options.reconnectMinMs;
        timer = setTimeout(() => void connect(), options.replacedHoldOffMs);
        return;
      }
      if (gone >= options.goneAttempts) {
        options.log(`Boat tunnel carrier · run ${input.runId}: the agent no longer offers it`);
        return stop();
      }
      schedule();
    });
  };
  udp.connect(input.gateway.port, input.gateway.host, () => void connect());
  return {
    gateway: input.gateway,
    attached: () => socket?.readyState === WebSocket.OPEN,
    settled,
    stop,
  };
};

/** The live carrier: one per run in this process, closed with the layer. */
export const makeBoatTunnelCarrierLayer = (
  options: BoatTunnelCarrierOptions = {},
): Layer.Layer<BoatTunnelCarrier> =>
  Layer.effect(
    BoatTunnelCarrier,
    Effect.gen(function* () {
      const resolved = {
        reconnectMinMs: options.reconnectMinMs ?? 500,
        reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
        pingIntervalMs: options.pingIntervalMs ?? 20_000,
        goneAttempts: options.goneAttempts ?? 5,
        replacedHoldOffMs: options.replacedHoldOffMs ?? 300_000,
        log: options.log ?? (() => {}),
      };
      const carriers = new Map<string, Carrier>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // A stopped carrier deletes itself; a Map tolerates that while it is iterated.
          for (const carrier of carriers.values()) carrier.stop();
          carriers.clear();
        }),
      );
      const ensure = Effect.fn("BoatTunnelCarrier.ensure")((input: BoatTunnelCarrierInput) =>
        Effect.sync(() => {
          const existing = carriers.get(input.runId);
          if (
            existing !== undefined &&
            existing.gateway.host === input.gateway.host &&
            existing.gateway.port === input.gateway.port
          )
            return;
          // The run's gateway moved (a new port): the old carrier must not relay to it any more.
          existing?.stop();
          const carrier = startCarrier(input, resolved, () => {
            if (carriers.get(input.runId) === carrier) carriers.delete(input.runId);
          });
          carriers.set(input.runId, carrier);
        }),
      );
      const release = Effect.fn("BoatTunnelCarrier.release")((runId: string) =>
        Effect.sync(() => carriers.get(runId)?.stop()),
      );
      const attached = Effect.fn("BoatTunnelCarrier.attached")((runId: string) =>
        Effect.sync(() => carriers.get(runId)?.attached() ?? false),
      );
      const settled = Effect.fn("BoatTunnelCarrier.settled")((runId: string) =>
        Effect.promise(() => carriers.get(runId)?.settled ?? Promise.resolve()),
      );
      return BoatTunnelCarrier.of({ ensure, release, attached, settled });
    }),
  );
