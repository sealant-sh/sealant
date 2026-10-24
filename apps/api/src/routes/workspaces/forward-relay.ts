import {
  FORWARD_V2_MAX_FRAME_BYTES,
  type ForwardBinding,
  ForwardFlow,
  forwardFrames,
  type ForwardReadyFrame,
  type ForwardResetReason,
} from "@sealant/api-contracts";
import type { SealantForwardChannel } from "@sealant/workspaces";
import { Effect } from "effect";
import { WebSocket } from "ws";

export interface ForwardSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(
    data: string | Uint8Array,
    options: { readonly binary: boolean },
    callback: (error?: Error) => void,
  ): void;
  close(code: number, reason: string): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): unknown;
  once(event: "close", listener: () => void): unknown;
}

const SOCKET_HIGH_WATER_BYTES = FORWARD_V2_MAX_FRAME_BYTES;

export const relayBoundedForward = (
  socket: ForwardSocket,
  binding: ForwardBinding,
  channel: SealantForwardChannel,
) =>
  Effect.suspend(() => {
    const flow = new ForwardFlow();
    const finished = Promise.withResolvers<void>();
    let open = true;
    let waiter: (() => void) | undefined;
    const uploadsAwaitingDrain: number[] = [];

    const wake = () => {
      // Taken first: resuming the pump runs it at once, and it may wait again before this returns.
      const next = waiter;
      waiter = undefined;
      next?.();
    };
    const until = (ready: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => (!open || ready() ? resolve() : (waiter = check));
        check();
      });
    const socketHasRoom = () => socket.bufferedAmount <= SOCKET_HIGH_WATER_BYTES;

    const send = (data: string | Uint8Array, binary: boolean) =>
      socket.send(data, { binary }, () => {
        sendProgress();
        wake();
      });
    const sendText = (frame: object) => send(JSON.stringify(frame), false);
    const sendProgress = () => {
      if (!open || !socketHasRoom()) return;
      const progress = flow.takeProgress();
      if (progress !== undefined) sendText(progress);
    };

    const stop = () => {
      open = false;
      wake();
    };
    const finish = (reason: string) => {
      if (!open) return;
      stop();
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, reason);
      finished.resolve();
    };
    const reset = (reason: ForwardResetReason) => {
      if (!open) return;
      if (socket.readyState === WebSocket.OPEN) sendText({ t: "reset", reason });
      channel.destroy();
      finish("reset");
    };

    const consumedUpload = (bytes: number) => {
      flow.consumed(bytes);
      sendProgress();
    };
    const consumeDrainedUploads = () => {
      for (const bytes of uploadsAwaitingDrain.splice(0)) consumedUpload(bytes);
    };
    const onUpload = (data: Buffer) => {
      const workspaceEnded = channel.isOutboundClosed;
      if (workspaceEnded) return;
      const accepted = channel.write(data);
      if (accepted && uploadsAwaitingDrain.length === 0) return consumedUpload(data.byteLength);
      if (uploadsAwaitingDrain.push(data.byteLength) === 1) {
        channel.drained().then(consumeDrainedUploads, () => {});
      }
    };
    socket.on("message", (data, isBinary) => {
      if (!open) return;
      const inbound = flow.receive(isBinary ? data : data.toString());
      switch (inbound.kind) {
        case "data":
          return onUpload(data);
        case "progress":
          return wake();
        case "fin":
          return channel.end();
        case "reset":
          channel.destroy();
          return finish("reset");
        case "violation":
          return reset(inbound.reason);
      }
    });
    socket.once("close", () => finish("closed"));

    const resetAheadOfUnreadData = (cause: Awaited<SealantForwardChannel["closed"]>) => {
      if (cause.kind === "error") return reset("runtime-lost");
      if (cause.kind === "remote" && cause.end.error !== undefined && cause.end.error !== "") {
        return reset("target-error");
      }
    };
    void channel.closed.then(resetAheadOfUnreadData);

    const pumpDownload = async () => {
      for await (const chunk of channel) {
        for (const frame of forwardFrames(chunk)) {
          await until(() => flow.canSend(frame.byteLength) && socketHasRoom());
          if (!open) return;
          flow.sent(frame.byteLength);
          send(frame, true);
        }
      }
      const cause = await channel.closed;
      if (!open || cause.kind !== "remote" || (cause.end.error ?? "") !== "") return;
      const delivered = flow.takeFinalProgress();
      if (delivered !== undefined) sendText(delivered);
      sendText(flow.fin());
      finish("end");
    };

    const ready: ForwardReadyFrame = { t: "ready", version: 2, binding };
    sendText(ready);
    sendText(flow.open());
    pumpDownload().catch(() => reset("runtime-lost"));

    return Effect.promise(() => finished.promise).pipe(Effect.ensuring(Effect.sync(stop)));
  });
