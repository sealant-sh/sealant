import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { Duplex, getDefaultHighWaterMark } from "node:stream";

import { FORWARD_V2_WINDOW } from "@sealant/api-contracts";
import { ForwardDialError } from "@sealant/sdk";
import { openForwardV2 } from "@sealant/sdk/internal/forward";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  daemonSessions,
  hasSealantd,
  heldArrayBuffers,
  LIVE_OWNER,
  LIVE_WORKSPACE,
  liveDaemonServices,
  type LiveSession,
  type LocalDaemon,
  startSealantd,
  startTarget,
  synSentRemotePorts,
  tcpQueuedBytes,
  defaultSendBufferBytes,
} from "./forward-v2.daemon.fixture.js";
import {
  asForwardService,
  eventually,
  FORWARD_SERVICE_KEY,
  serveForwardRoutes,
  type ServedCore,
} from "./forward-v2.fixture.js";
import { DAEMON_HIGH_WATER_BYTES } from "./workspaces.forward-v2.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const TRANSFER_BYTES = 256 * MiB;
const FRAME_BYTES = 64 * KiB;

const SEALANTD_READ_BUF = FRAME_BYTES;
const SEALANTD_OUTBOUND_CAPACITY = 256;
const SEALANTD_FORWARD_INBOUND_DEPTH = 64;
const SEALANTD_FRAME_IN_WRITE = FRAME_BYTES;
const SEALANTD_FRAME_IN_READ = FRAME_BYTES;
const SEALANTD_DOWNLOAD_QUEUES =
  SEALANTD_READ_BUF + SEALANTD_OUTBOUND_CAPACITY * FRAME_BYTES + SEALANTD_FRAME_IN_WRITE;
const SEALANTD_UPLOAD_QUEUES =
  SEALANTD_FORWARD_INBOUND_DEPTH * FRAME_BYTES + SEALANTD_FRAME_IN_WRITE + SEALANTD_FRAME_IN_READ;
const CORE_TRANSPORT_READ = FRAME_BYTES;
const CORE_PARTIAL_FRAME = FRAME_BYTES;
const CORE_SOCKET_HIGH_WATER = FRAME_BYTES;
const CORE_DOWNLOAD_HOLD =
  DAEMON_HIGH_WATER_BYTES +
  CORE_TRANSPORT_READ +
  CORE_PARTIAL_FRAME +
  CORE_SOCKET_HIGH_WATER +
  FRAME_BYTES;
const CORE_UPLOAD_HOLD = getDefaultHighWaterMark(false);
const SDK_WINDOW = FORWARD_V2_WINDOW.bytes;
const WEBSOCKET_BUFFERED_FRAMES = 2 * FRAME_BYTES;
const MEMORY_CEILING_BYTES = CORE_DOWNLOAD_HOLD + SDK_WINDOW + WEBSOCKET_BUFFERED_FRAMES;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let daemon: LocalDaemon;
let core: ServedCore;
const sessions = new Map<string, LiveSession>();

beforeAll(async () => {
  if (!hasSealantd) return;
  daemon = await startSealantd();
  core = await serveForwardRoutes({
    services: liveDaemonServices(daemon, sessions),
    release: "current",
    requestsPerMinute: 10_000,
  });
});

afterAll(async () => {
  await core?.close();
  daemon?.stop();
});

const corePort = () => Number(new URL(core.baseUrl).port);

const open = (port: number, session?: string) =>
  openForwardV2(
    asForwardService(core.baseUrl, LIVE_OWNER),
    LIVE_WORKSPACE,
    port,
    session === undefined ? {} : { session },
  );

const refusalOf = (opening: Promise<unknown>) =>
  opening.then(
    () => {
      throw new Error("expected the forward to be refused");
    },
    (error: unknown) => {
      if (error instanceof ForwardDialError) return error.reason;
      throw error;
    },
  );

const echoes = async (forward: Awaited<ReturnType<typeof open>>, text: string) => {
  const writer = forward.writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  const reader = forward.readable.getReader();
  let echoed = "";
  while (echoed.length < text.length) {
    const next = await reader.read();
    if (next.done) break;
    echoed += new TextDecoder().decode(next.value);
  }
  reader.releaseLock();
  writer.releaseLock();
  return echoed;
};

describe.skipIf(!hasSealantd)("/forward/v2 against a real sealantd", () => {
  it(
    "holds back a fast producer while the client does not read, in bounded memory",
    { timeout: 120_000 },
    async () => {
      const producer = await startTarget({ mode: "produce", bytes: TRANSFER_BYTES });
      try {
        const baseline = heldArrayBuffers();
        const forward = await open(producer.port);
        const reader = forward.readable.getReader();
        const hash = createHash("sha256");
        let received = 0;
        let held = 0;
        const read = async () => {
          const next = await reader.read();
          if (next.done) return false;
          hash.update(next.value);
          received += next.value.byteLength;
          return true;
        };
        const readAtLeast = async (bytes: number) => {
          const until = received + bytes;
          for (;;) if (received >= until || !(await read())) return;
        };

        await readAtLeast(FRAME_BYTES);

        await sleep(1_000);
        const stalledAt = producer.latest().bytes;
        await sleep(2_000);
        held = Math.max(held, heldArrayBuffers() - baseline);
        expect(producer.latest().bytes).toBe(stalledAt);
        const inKernel = tcpQueuedBytes(producer.port) + tcpQueuedBytes(corePort());
        expect(stalledAt - received - inKernel).toBeLessThanOrEqual(
          SEALANTD_DOWNLOAD_QUEUES + defaultSendBufferBytes() + CORE_DOWNLOAD_HOLD + SDK_WINDOW,
        );

        const pacedUntil = Date.now() + 2_000;
        while (Date.now() < pacedUntil) {
          await readAtLeast(MiB / 10);
          await sleep(100);
        }
        held = Math.max(held, heldArrayBuffers() - baseline);

        let nextSample = received + 32 * MiB;
        while (await read()) {
          if (received >= nextSample) {
            held = Math.max(held, heldArrayBuffers() - baseline);
            nextSample += 32 * MiB;
          }
        }

        const produced = await producer.finished;
        expect(received).toBe(TRANSFER_BYTES);
        expect(hash.digest("hex")).toBe(produced.sha256);
        await expect(forward.closed).resolves.toEqual({ kind: "end" });
        expect(held).toBeLessThan(MEMORY_CEILING_BYTES);
      } finally {
        producer.stop();
      }
    },
  );

  it(
    "holds back the client's writer while the workspace does not read, in bounded memory",
    { timeout: 120_000 },
    async () => {
      const sink = await startTarget({ mode: "sink" });
      try {
        const baseline = heldArrayBuffers();
        const forward = await open(sink.port);
        const writer = forward.writable.getWriter();
        const block = new Uint8Array(FRAME_BYTES);
        const hash = createHash("sha256");
        let accepted = 0;
        let lowestDesiredSize = Number.POSITIVE_INFINITY;
        let held = 0;

        const writing = (async () => {
          for (let index = 0; index * FRAME_BYTES < TRANSFER_BYTES; index++) {
            await writer.ready;
            const chunk = new Uint8Array(block);
            new DataView(chunk.buffer).setUint32(0, index);
            hash.update(chunk);
            void writer.write(chunk).then(() => (accepted += chunk.byteLength));
            lowestDesiredSize = Math.min(lowestDesiredSize, writer.desiredSize ?? 0);
          }
          await writer.close();
        })();

        await sleep(1_000);
        const stalledAt = accepted;
        await sleep(2_000);
        held = Math.max(held, heldArrayBuffers() - baseline);
        expect(accepted).toBe(stalledAt);
        expect(stalledAt - tcpQueuedBytes(sink.port)).toBeLessThanOrEqual(
          SDK_WINDOW + CORE_UPLOAD_HOLD + defaultSendBufferBytes() + SEALANTD_UPLOAD_QUEUES,
        );
        expect(lowestDesiredSize).toBeLessThanOrEqual(0);

        sink.send("pace");
        await sleep(2_000);
        held = Math.max(held, heldArrayBuffers() - baseline);
        sink.send("drain");

        let nextSample = 32 * MiB;
        for (;;) {
          if (accepted === TRANSFER_BYTES) break;
          await sleep(20);
          if (accepted >= nextSample) {
            held = Math.max(held, heldArrayBuffers() - baseline);
            nextSample += 32 * MiB;
          }
        }
        await writing;

        const sunk = await sink.finished;
        expect(sunk.bytes).toBe(TRANSFER_BYTES);
        expect(sunk.sha256).toBe(hash.digest("hex"));
        await expect(forward.closed).resolves.toEqual({ kind: "end" });
        expect(held).toBeLessThan(MEMORY_CEILING_BYTES);
      } finally {
        sink.stop();
      }
    },
  );

  it("keeps reading after the client half-closes, through Duplex.fromWeb", async () => {
    const echo = await startTarget({ mode: "echo" });
    try {
      const forward = await open(echo.port);
      const duplex = Duplex.fromWeb(forward, { allowHalfOpen: true });
      const payload = new Uint8Array(3 * MiB).map((_, index) => index % 251);
      const chunks: Buffer[] = [];
      duplex.on("data", (chunk: Buffer) => chunks.push(chunk));
      const ended = new Promise((resolve) => duplex.once("end", resolve));
      duplex.end(payload);
      await ended;
      expect(Buffer.concat(chunks).equals(payload)).toBe(true);
      await expect(forward.closed).resolves.toEqual({ kind: "end" });
    } finally {
      echo.stop();
    }
  });

  it("releases the workspace's connection when the client closes an open forward", async () => {
    const echo = await startTarget({ mode: "echo" });
    try {
      const forward = await open(echo.port);
      const writer = forward.writable.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));
      await forward.readable.getReader().read();

      const closedAt = Date.now();
      forward.close();

      await echo.connectionClosed;
      expect(Date.now() - closedAt).toBeLessThan(1_000);
    } finally {
      echo.stop();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "cancels sealantd's dial when the client leaves during it",
    async () => {
      const { port, fill, close } = await unacceptingListener();
      try {
        await fill();
        const socket = new WebSocket(
          new URL(
            `/v1/workspaces/${LIVE_WORKSPACE}/forward/v2?port=${port}&ownerUserId=${LIVE_OWNER}&token=${FORWARD_SERVICE_KEY}`,
            core.baseUrl.replace("http:", "ws:"),
          ),
          "sealant.forward.v2",
        );
        await eventually(() => synSentRemotePorts().includes(port));
        const leftAt = Date.now();
        socket.close();
        await eventually(() => !synSentRemotePorts().includes(port), 1_000);
        expect(Date.now() - leftAt).toBeLessThan(1_000);
      } finally {
        close();
      }
    },
  );
});

describe.skipIf(!hasSealantd || process.platform !== "linux")(
  "/forward/v2 bound to a session, against a real sealantd",
  () => {
    let control: Awaited<ReturnType<typeof daemonSessions>>;
    beforeAll(async () => {
      control = await daemonSessions(daemon);
    });
    afterAll(() => control?.close());

    const register = (session: string, daemonSessionId: string) =>
      sessions.set(session, { status: "running", daemonSessionId });

    it("opens a forward bound to the session that serves the port, and says so", async () => {
      const a = await control.serve();
      try {
        register("ses_a", a.sessionId);
        const forward = await open(a.port, "ses_a");
        expect(forward.binding).toEqual({ kind: "session", session: "ses_a" });
        await expect(echoes(forward, "bound")).resolves.toBe("bound");
        forward.close();
      } finally {
        await a.exit();
      }
    });

    it("refuses owner-exited once the session exited, though another now serves its port", async () => {
      const a = await control.serve();
      register("ses_a", a.sessionId);
      await a.exit();
      const b = await control.serve({ port: a.port });
      try {
        register("ses_b", b.sessionId);
        await expect(refusalOf(open(a.port, "ses_a"))).resolves.toBe("owner-exited");
        const forward = await open(a.port, "ses_b");
        await expect(echoes(forward, "b")).resolves.toBe("b");
        forward.close();
      } finally {
        await b.exit();
      }
    });

    it("refuses peer-mismatch when a process outside the session holds the port, which an unbound forward still reaches", async () => {
      const a = await control.serve();
      const foreign = await startTarget({ mode: "echo" });
      try {
        register("ses_a", a.sessionId);
        await expect(refusalOf(open(foreign.port, "ses_a"))).resolves.toBe("peer-mismatch");
        const unbound = await open(foreign.port);
        expect(unbound.binding).toEqual({ kind: "port" });
        await expect(echoes(unbound, "unbound")).resolves.toBe("unbound");
        unbound.close();
      } finally {
        foreign.stop();
        await a.exit();
      }
    });

    it("resets a bound forward with owner-exited when the session's leader exits", async () => {
      const a = await control.serve({ detached: true });
      try {
        register("ses_a", a.sessionId);
        const forward = await open(a.port, "ses_a");
        await expect(echoes(forward, "before")).resolves.toBe("before");
        await a.exit();
        await expect(forward.closed).resolves.toEqual({ kind: "reset", reason: "owner-exited" });
      } finally {
        a.stopServer();
      }
    });

    it("resets with owner-exited at once, ahead of what Core holds that the client has not read", async () => {
      const a = await control.serve({ mode: "burst", bytes: (3 * SDK_WINDOW) / 2, detached: true });
      try {
        register("ses_a", a.sessionId);
        const forward = await open(a.port, "ses_a");
        await sleep(500);

        const exitedAt = Date.now();
        await a.exit();

        await expect(forward.closed).resolves.toEqual({ kind: "reset", reason: "owner-exited" });
        expect(Date.now() - exitedAt).toBeLessThan(1_000);
        await expect(forward.readable.getReader().read()).rejects.toMatchObject({
          reason: "owner-exited",
        });
      } finally {
        a.stopServer();
      }
    });
  },
);

/**
 * A listener whose accept queue is full, so a further connect waits in `SYN_SENT` until it
 * gives up.
 */
const unacceptingListener = async () => {
  const python = await import("node:child_process").then(({ spawn }) =>
    spawn(
      "python3",
      [
        "-c",
        "import socket,sys,time\ns=socket.socket()\ns.bind(('127.0.0.1',0))\ns.listen(0)\nprint(s.getsockname()[1],flush=True)\ntime.sleep(120)",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  const port = await new Promise<number>((resolve) =>
    python.stdout.once("data", (data: Buffer) => resolve(Number(data.toString().trim()))),
  );
  const fillers: Socket[] = [];
  const fill = async () => {
    for (let attempt = 0; attempt < 16; attempt++) {
      const socket = connect(port, "127.0.0.1");
      fillers.push(socket);
      socket.on("error", () => {});
      const connected = await Promise.race([
        new Promise<boolean>((resolve) => socket.once("connect", () => resolve(true))),
        sleep(300).then(() => false),
      ]);
      if (!connected) {
        socket.destroy();
        await eventually(() => !synSentRemotePorts().includes(port));
        return;
      }
    }
    throw new Error("the listener's accept queue never filled");
  };
  return {
    port,
    fill,
    close: () => {
      for (const socket of fillers) socket.destroy();
      python.kill("SIGKILL");
    },
  };
};
