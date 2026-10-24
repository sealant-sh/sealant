import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { ForwardDialError } from "@sealant/sdk";
import { openForwardV2, type ForwardV2Options } from "@sealant/sdk/internal/forward";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";

interface FakeCore {
  readonly onSocket?: (socket: WebSocket) => void;
  readonly refuseUpgradeWith?: number;
  readonly onRequest?: (request: IncomingMessage, response: ServerResponse) => void;
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

const serverSockets: WebSocket[] = [];

const fakeCore = async (fake: FakeCore): Promise<string> => {
  const sockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) =>
      offered.has("sealant.forward.v2") ? "sealant.forward.v2" : false,
  });
  const server = createServer(
    fake.onRequest ?? ((_request, response) => response.writeHead(404).end()),
  );
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (fake.refuseUpgradeWith !== undefined) {
      socket.end(`HTTP/1.1 ${fake.refuseUpgradeWith} Refused\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      serverSockets.push(ws);
      fake.onSocket?.(ws);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
};

const open = (baseUrl: string, options?: ForwardV2Options) =>
  openForwardV2({ baseUrl, apiKey: "slt_key", ownerUserId: "usr_1" }, "wks_1", 3000, options);

const rejectionOf = (opening: Promise<unknown>) =>
  opening.then(
    () => {
      throw new Error("expected the open to reject");
    },
    (cause: unknown) => cause,
  );

describe("openForwardV2", () => {
  it("keeps a refusal reason this SDK does not know, with Core's status and message", async () => {
    const baseUrl = await fakeCore({
      onSocket: (socket) =>
        socket.send(
          JSON.stringify({
            t: "refused",
            reason: "quota-frozen",
            message: "This workspace's forwards are frozen.",
            status: 423,
          }),
        ),
    });
    const error = await rejectionOf(open(baseUrl));
    expect(error).toBeInstanceOf(ForwardDialError);
    expect(error).toMatchObject({
      reason: "unrecognized-refusal",
      wireReason: "quota-frozen",
      status: 423,
      message: "This workspace's forwards are frozen.",
    });
  });

  it("takes a known refusal's status from the frame", async () => {
    const baseUrl = await fakeCore({
      onSocket: (socket) =>
        socket.send(
          JSON.stringify({ t: "refused", reason: "not-found", message: "gone", status: 410 }),
        ),
    });
    await expect(rejectionOf(open(baseUrl))).resolves.toMatchObject({
      reason: "not-found",
      status: 410,
    });
  });

  it.each([
    { probe: 401, reason: "protocol-unsupported" },
    { probe: 404, reason: "protocol-unsupported" },
    { probe: 426, reason: "transport-unavailable" },
    { probe: 302, reason: "transport-unavailable" },
    { probe: 429, reason: "transport-unavailable" },
    { probe: 502, reason: "transport-unavailable" },
    { probe: 503, reason: "transport-unavailable" },
  ])(
    "reads a failed handshake whose probe answers $probe as $reason",
    async ({ probe, reason }) => {
      const baseUrl = await fakeCore({
        refuseUpgradeWith: probe,
        onRequest: (_request, response) => response.writeHead(probe).end(),
      });
      await expect(rejectionOf(open(baseUrl))).resolves.toMatchObject({ reason });
    },
  );

  it("gives up on a probe that never answers at the open's deadline", async () => {
    const baseUrl = await fakeCore({ refuseUpgradeWith: 503, onRequest: () => {} });
    const startedAt = Date.now();
    await expect(rejectionOf(open(baseUrl, { deadlineMs: 300 }))).resolves.toMatchObject({
      reason: "transport-unavailable",
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("gives up on a Core that accepts the socket and never answers, and closes it", async () => {
    let accepted: WebSocket | undefined;
    const baseUrl = await fakeCore({ onSocket: (socket) => (accepted = socket) });
    await expect(rejectionOf(open(baseUrl, { deadlineMs: 300 }))).resolves.toMatchObject({
      reason: "transport-unavailable",
    });
    await expect(
      new Promise((resolve) =>
        accepted?.readyState === accepted?.CLOSED
          ? resolve(true)
          : accepted?.once("close", resolve),
      ),
    ).resolves.toBeDefined();
  });

  it("rejects with the signal's reason when the caller aborts, and closes the socket", async () => {
    const opened = Promise.withResolvers<WebSocket>();
    const baseUrl = await fakeCore({ onSocket: (socket) => opened.resolve(socket) });
    const controller = new AbortController();
    const opening = open(baseUrl, { signal: controller.signal });
    const socket = await opened.promise;
    const closed = new Promise((resolve) => socket.once("close", resolve));
    const reason = new Error("the preview was closed");
    controller.abort(reason);
    await expect(rejectionOf(opening)).resolves.toBe(reason);
    await closed;
  });

  it("rejects at once for a signal that is already aborted", async () => {
    const baseUrl = await fakeCore({});
    const reason = new Error("never mind");
    await expect(rejectionOf(open(baseUrl, { signal: AbortSignal.abort(reason) }))).resolves.toBe(
      reason,
    );
  });
});

const progress = (bytes: number, frames: number) =>
  JSON.stringify({ t: "progress", bytes: String(bytes), frames: String(frames) });

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("a bounded forward", () => {
  const FRAME = 64 * 1024;
  const WINDOW_BYTES = 256 * 1024;
  const READY = JSON.stringify({ t: "ready", version: 2, binding: { kind: "port" } });

  const recordingCoreOpening = async (grantUpload: boolean) => {
    const texts: unknown[] = [];
    const binary: number[] = [];
    const socket = Promise.withResolvers<WebSocket>();
    const baseUrl = await fakeCore({
      onSocket: (ws) => {
        ws.on("message", (data: Buffer, isBinary: boolean) => {
          if (isBinary) binary.push(data.byteLength);
          else texts.push(JSON.parse(data.toString()));
        });
        ws.send(READY);
        if (grantUpload) ws.send(progress(0, 0));
        servers.unshift(async () => ws.terminate());
        socket.resolve(ws);
      },
    });
    const opening = open(baseUrl);
    return { opening, core: await socket.promise, texts, binary };
  };
  const recordingCore = async (grantUpload: boolean) => {
    const { opening, ...recorded } = await recordingCoreOpening(grantUpload);
    return { forward: await opening, ...recorded };
  };

  it("opens Core's window with a progress of zero, and resolves only once Core opens its own", async () => {
    const { opening, core, texts, binary } = await recordingCoreOpening(false);
    let resolved = false;
    void opening.then(() => (resolved = true));
    await settle();
    expect(texts).toEqual([{ t: "progress", bytes: "0", frames: "0" }]);
    expect(resolved).toBe(false);

    core.send(progress(0, 0));
    const forward = await opening;
    await forward.writable.getWriter().write(new Uint8Array(10));
    await settle();
    expect(binary).toEqual([10]);
  });

  it("splits a large write into frames and sends no more than Core granted", async () => {
    const { forward, core, binary } = await recordingCore(true);
    const writer = forward.writable.getWriter();
    void writer.write(new Uint8Array(WINDOW_BYTES + FRAME + 1));
    await settle();
    expect(binary).toEqual([FRAME, FRAME, FRAME, FRAME]);
    expect(writer.desiredSize).toBeLessThanOrEqual(0);

    core.send(progress(2 * FRAME, 2));
    await settle();
    expect(binary).toEqual([FRAME, FRAME, FRAME, FRAME, FRAME, 1]);
  });

  it("says it has read only what the caller read", async () => {
    const { forward, core, texts } = await recordingCore(true);
    for (let frame = 0; frame < 4; frame++) core.send(new Uint8Array(FRAME));
    await settle();
    expect(texts).toEqual([{ t: "progress", bytes: "0", frames: "0" }]);

    const reader = forward.readable.getReader();
    await reader.read();
    await reader.read();
    await settle();
    expect(texts.at(-1)).toEqual({ t: "progress", bytes: String(2 * FRAME), frames: "2" });
  });

  it("ends the readable after Core's fin, once the caller has read what came before it", async () => {
    const { forward, core } = await recordingCore(true);
    core.send(new Uint8Array([1, 2, 3]));
    core.send(JSON.stringify({ t: "fin", bytes: "3", frames: "1" }));
    core.close(1000);
    await expect(forward.closed).resolves.toEqual({ kind: "end" });
    const chunks: number[] = [];
    for await (const chunk of forward.readable) chunks.push(...chunk);
    expect(chunks).toEqual([1, 2, 3]);
  });

  const resets: ReadonlyArray<{
    readonly name: string;
    readonly core: (core: WebSocket) => void;
    readonly reset: { readonly reason: string; readonly wireReason?: string };
    readonly sent?: object;
  }> = [
    {
      name: "Core sends past the window",
      core: (core) => {
        for (let frame = 0; frame <= WINDOW_BYTES / FRAME; frame++)
          core.send(new Uint8Array(FRAME));
      },
      reset: { reason: "window-exceeded" },
      sent: { t: "reset", reason: "window-exceeded" },
    },
    {
      name: "Core's fin does not match what arrived",
      core: (core) => core.send(JSON.stringify({ t: "fin", bytes: "1", frames: "1" })),
      reset: { reason: "protocol-violation" },
      sent: { t: "reset", reason: "protocol-violation" },
    },
    {
      name: "Core resets with a reason this SDK does not know",
      core: (core) => core.send(JSON.stringify({ t: "reset", reason: "quota-frozen" })),
      reset: { reason: "unrecognized-reset", wireReason: "quota-frozen" },
    },
    {
      name: "the connection closes with neither a fin nor a reset",
      core: (core) => core.terminate(),
      reset: { reason: "connection-lost" },
    },
  ];

  it.each(resets)("resets when $name", async ({ core: act, reset, sent }) => {
    const { forward, core, texts } = await recordingCore(true);
    act(core);
    await expect(forward.closed).resolves.toEqual({ kind: "reset", ...reset });
    await expect(forward.readable.getReader().read()).rejects.toMatchObject({
      name: "ForwardResetError",
      ...reset,
    });
    if (sent !== undefined) {
      await settle();
      expect(texts.at(-1)).toEqual(sent);
    }
  });
});
