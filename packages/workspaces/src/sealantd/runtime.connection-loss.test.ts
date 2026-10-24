import { Duplex } from "node:stream";

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { SealantRuntime, SealantRuntimeLive, SealantTransport, TransportError } from "./runtime.js";

const droppedAfterFirstRequest = () =>
  new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
      setImmediate(() => this.destroy());
    },
  });

const runtimeOver = (open: () => Duplex) =>
  SealantRuntimeLive.pipe(
    Layer.provide(Layer.succeed(SealantTransport, { open: () => Effect.sync(open) })),
  );

describe("a control connection lost mid-request", () => {
  it("fails the request with a TransportError", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const daemon = yield* runtime.connect({ kind: "unix-socket", socketPath: "/unused" });
          return yield* Effect.flip(daemon.openForward(3000, "127.0.0.1", "tcp"));
        }),
      ).pipe(Effect.provide(runtimeOver(droppedAfterFirstRequest))),
    );
    expect(error).toBeInstanceOf(TransportError);
  });
});
