import { EventEmitter } from "node:events";

import type { SealantForwardChannel } from "@sealant/workspaces";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { relayBoundedForward } from "./forward-relay.js";

class BackedUpSocket extends EventEmitter {
  bufferedAmount = 0;
  readyState = 1;
  readonly texts: unknown[] = [];
  #pending: Array<() => void> = [];

  send(data: string | Uint8Array, _options: unknown, callback?: () => void) {
    if (typeof data === "string") this.texts.push(JSON.parse(data));
    if (callback !== undefined) this.#pending.push(callback);
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }

  drain() {
    this.bufferedAmount = 0;
    for (const callback of this.#pending.splice(0)) callback();
  }

  upload(frames: number) {
    for (let frame = 0; frame < frames; frame++) this.emit("message", Buffer.alloc(1), true);
  }

  progress() {
    return this.texts.filter((text) => (text as { t?: string }).t === "progress");
  }
}

const acceptingChannel = (): SealantForwardChannel => {
  const closed = Promise.withResolvers<Awaited<SealantForwardChannel["closed"]>>();
  return {
    write: () => true,
    isOutboundClosed: false,
    drained: () => Promise.resolve(),
    end: () => {},
    destroy: () => closed.resolve({ kind: "local" }),
    closed: closed.promise,
    [Symbol.asyncIterator]: () => ({
      next: () => closed.promise.then(() => ({ done: true, value: undefined })),
    }),
  };
};

const relay = async (socket: BackedUpSocket) => {
  void Effect.runPromise(
    Effect.scoped(relayBoundedForward(socket, { kind: "port" }, acceptingChannel())),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("the forward relay's acknowledgements", () => {
  it("grants a client no more upload while its socket is backed up", async () => {
    const socket = new BackedUpSocket();
    await relay(socket);
    socket.bufferedAmount = 1024 * 1024;

    socket.upload(32);
    expect(socket.progress()).toEqual([{ t: "progress", bytes: "0", frames: "0" }]);

    socket.upload(1);
    expect(socket.texts.at(-1)).toEqual({ t: "reset", reason: "window-exceeded" });
  });

  it("sends the latest progress, once, when its socket drains", async () => {
    const socket = new BackedUpSocket();
    await relay(socket);
    socket.bufferedAmount = 1024 * 1024;
    socket.upload(20);

    socket.drain();

    expect(socket.progress()).toEqual([
      { t: "progress", bytes: "0", frames: "0" },
      { t: "progress", bytes: "20", frames: "20" },
    ]);
  });
});
