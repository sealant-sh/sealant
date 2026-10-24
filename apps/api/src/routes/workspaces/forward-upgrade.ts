import type { IncomingMessage, Server } from "node:http";

import {
  FORWARD_REFUSED_CLOSE_CODE,
  FORWARD_V2_MAX_FRAME_BYTES,
  FORWARD_V2_SUBPROTOCOL,
  type ForwardBinding,
  type ForwardReadyFrame,
  type ForwardRefusalReason,
  forwardRefusedFrame,
} from "@sealant/api-contracts";
import { Data, Duration, Effect } from "effect";
import { WebSocket, WebSocketServer } from "ws";

const upgradeHeads = new WeakMap<IncomingMessage, Buffer>();

/**
 * Node hands an upgrade's first bytes past the request head only to `upgrade` listeners. This one
 * is registered at creation, before Effect's, so the v2 route can pass them on to `ws`.
 */
export const captureUpgradeHeads = <S extends Server>(server: S): S => {
  server.on("upgrade", (request: IncomingMessage, _socket, head: Buffer) => {
    upgradeHeads.set(request, head);
  });
  return server;
};

/**
 * The bytes after the head of a request Node delivered as an upgrade. Any other request has none,
 * even one with an `Upgrade` header: without `Connection: upgrade` its socket still belongs to the
 * HTTP parser.
 */
export const upgradeHeadOf = (request: IncomingMessage): Buffer | undefined =>
  upgradeHeads.get(request);

const forwardSockets = new WebSocketServer({
  noServer: true,
  clientTracking: false,
  perMessageDeflate: false,
  maxPayload: FORWARD_V2_MAX_FRAME_BYTES,
  handleProtocols: (offered) =>
    offered.has(FORWARD_V2_SUBPROTOCOL) ? FORWARD_V2_SUBPROTOCOL : false,
});

export const offersForwardV2 = (header: string | undefined): boolean =>
  header !== undefined &&
  header
    .split(",")
    .map((protocol) => protocol.trim())
    .includes(FORWARD_V2_SUBPROTOCOL);

export class ForwardSocketNeverOpened extends Data.TaggedError("ForwardSocketNeverOpened") {}

/** Without a bound `ws` waits 30 s for the peer to answer a close. */
const CLOSE_GRACE = Duration.millis(1_500);

export const socketClosed = (socket: WebSocket) =>
  Effect.callback<void>((resume) => {
    if (socket.readyState === WebSocket.CLOSED) return resume(Effect.void);
    const onClose = () => resume(Effect.void);
    socket.once("close", onClose);
    return Effect.sync(() => socket.off("close", onClose));
  });

const closeWithinGrace = (socket: WebSocket, code: number, reason: string) =>
  Effect.suspend(() => {
    if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    return socketClosed(socket).pipe(
      Effect.timeoutOrElse({
        duration: CLOSE_GRACE,
        orElse: () =>
          Effect.sync(() => socket.terminate()).pipe(Effect.andThen(socketClosed(socket))),
      }),
    );
  });

function refuseDataBeforeReady(this: WebSocket) {
  this.close(1002, "data before ready");
}

export const acceptForwardSocket = (request: IncomingMessage, head: Buffer) =>
  Effect.acquireRelease(
    Effect.callback<WebSocket, ForwardSocketNeverOpened>((resume) => {
      const raw = request.socket;
      const onClose = () => resume(Effect.fail(new ForwardSocketNeverOpened()));
      if (raw.destroyed) return onClose();
      raw.once("close", onClose);
      forwardSockets.handleUpgrade(request, raw, head, (socket) => {
        raw.off("close", onClose);
        // `ws` closes the socket itself after a protocol error (an oversized frame is 1009); an
        // unheard `error` event would take the whole process down.
        socket.on("error", () => {});
        socket.on("message", refuseDataBeforeReady);
        resume(Effect.succeed(socket));
      });
      return Effect.sync(() => raw.off("close", onClose));
    }),
    (socket) => closeWithinGrace(socket, 1011, "forward ended"),
  );

export const refuseForward = (
  socket: WebSocket,
  refusal: { readonly reason: ForwardRefusalReason; readonly message: string },
) =>
  Effect.suspend(() => {
    socket.send(JSON.stringify(forwardRefusedFrame(refusal.reason, refusal.message)));
    return closeWithinGrace(socket, FORWARD_REFUSED_CLOSE_CODE, "refused");
  });

export interface ForwardChannel extends AsyncIterable<Uint8Array> {
  write(data: Uint8Array): void;
  end(): void;
}

const isEof = (text: string): boolean => {
  try {
    const frame: unknown = JSON.parse(text);
    return typeof frame === "object" && frame !== null && Reflect.get(frame, "t") === "eof";
  } catch {
    return false;
  }
};

export const relayForward = (socket: WebSocket, binding: ForwardBinding, channel: ForwardChannel) =>
  Effect.gen(function* () {
    socket.off("message", refuseDataBeforeReady);
    // `ws` delivers binary frames as a Buffer: the socket's binaryType is "nodebuffer".
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      try {
        if (isBinary) channel.write(data);
        else if (isEof(data.toString())) channel.end();
      } catch {
        socket.close(1011, "forward ended");
      }
    });
    const ready: ForwardReadyFrame = { t: "ready", version: 2, binding };
    socket.send(JSON.stringify(ready));

    const iterator = channel[Symbol.asyncIterator]();
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        for (;;) {
          const next = yield* Effect.tryPromise(() => iterator.next());
          if (next.done === true) break;
          socket.send(next.value);
        }
        socket.send(JSON.stringify({ t: "end" }));
        socket.close(1000, "remote closed");
      }).pipe(Effect.catch(() => Effect.sync(() => socket.close(1011, "forward ended")))),
    );
    yield* socketClosed(socket);
  });
