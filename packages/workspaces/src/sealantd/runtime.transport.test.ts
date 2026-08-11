import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";

import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ControlTransportLive, SealantTransport, TransportError } from "./runtime.js";

const listen = (server: ReturnType<typeof createServer>, socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

const close = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });

describe("ControlTransportLive", () => {
  it("opens a persisted host Unix socket as a scoped Duplex", async () => {
    const dir = mkdtempSync(`${tmpdir()}/sealant-control-transport-`);
    const socketPath = `${dir}/control.sock`;
    const server = createServer((socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
    });

    await listen(server, socketPath);

    try {
      const response = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* SealantTransport;
            const duplex = yield* transport.open({ kind: "unix-socket", socketPath });

            return yield* Effect.tryPromise(
              () =>
                new Promise<string>((resolve, reject) => {
                  duplex.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
                  duplex.once("error", reject);
                  duplex.write("round-trip");
                }),
            );
          }),
        ).pipe(Effect.provide(ControlTransportLive)),
      );

      expect(response).toBe("round-trip");
    } finally {
      await close(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing Unix socket as a typed TransportError", async () => {
    const dir = mkdtempSync(`${tmpdir()}/sealant-missing-control-transport-`);
    const socketPath = `${dir}/missing.sock`;

    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* SealantTransport;
            return yield* transport.open({ kind: "unix-socket", socketPath });
          }),
        ).pipe(Effect.provide(ControlTransportLive)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toBeInstanceOf(TransportError);
        if (error instanceof TransportError) {
          expect(error.operation).toBe("open");
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
