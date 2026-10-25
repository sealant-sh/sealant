import { Duplex } from "node:stream";

import { create, encodeFrame, encodeServer, ServerMessageSchema } from "@sealant/runtime-protocol";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  SealantForwardBindingUnsupported,
  SealantRuntime,
  SealantRuntimeLive,
  SealantTransport,
} from "./runtime.js";

const daemonOpening = (boundSessionId: string | undefined) =>
  new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
      const opened = create(ServerMessageSchema, {
        message: {
          case: "response",
          value: {
            requestId: "req_forward",
            outcome: {
              outcome: {
                case: "ok",
                value: {
                  result: {
                    case: "forwardOpened",
                    value: {
                      channelId: "chan_1",
                      ...(boundSessionId === undefined ? {} : { boundSessionId }),
                    },
                  },
                },
              },
            },
          },
        },
      });
      this.push(encodeFrame(encodeServer(opened)));
    },
  });

const openOn = (daemon: Duplex, ownerSessionId?: string) =>
  Effect.runPromise(
    Effect.scoped(
      SealantRuntime.use((runtime) =>
        runtime
          .openForwardConnection(
            { kind: "unix-socket", socketPath: "/unused" },
            {
              host: "127.0.0.1",
              port: 3000,
              highWaterMarkBytes: 1024,
              ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
            },
          )
          .pipe(
            Effect.map(({ bound }) => bound),
            Effect.exit,
            Effect.map((exit) => ({ exit, droppedBeforeScopeClosed: daemon.destroyed })),
          ),
      ),
    ).pipe(
      Effect.provide(
        SealantRuntimeLive.pipe(
          Layer.provide(Layer.succeed(SealantTransport, { open: () => Effect.succeed(daemon) })),
        ),
      ),
    ),
  );

describe("openForwardConnection bound to a session", () => {
  it("opens bound to the session sealantd echoes", async () => {
    const { exit } = await openOn(daemonOpening("sess_a"), "sess_a");
    expect(exit).toEqual(Exit.succeed({ kind: "session", daemonSessionId: "sess_a" }));
  });

  it.each([
    { name: "does not echo it", echo: undefined },
    { name: "echoes another session", echo: "sess_b" },
  ])(
    "fails with SealantForwardBindingUnsupported, and drops the connection at once, when sealantd $name",
    async ({ echo }) => {
      const { exit, droppedBeforeScopeClosed } = await openOn(daemonOpening(echo), "sess_a");
      expect(exit).toEqual(
        Exit.fail(new SealantForwardBindingUnsupported({ ownerSessionId: "sess_a" })),
      );
      expect(droppedBeforeScopeClosed).toBe(true);
    },
  );

  it("opens an unbound forward with no echo", async () => {
    const { exit } = await openOn(daemonOpening(undefined));
    expect(exit).toEqual(Exit.succeed({ kind: "port" }));
  });
});
