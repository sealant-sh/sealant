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
