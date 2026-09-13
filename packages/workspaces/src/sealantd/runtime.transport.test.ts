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

describe("websocket control transport auth", () => {
  it("presents the bearer token on upgrade and refuses targets with no auth at all", async () => {
    const { createServer: createHttpServer } = await import("node:http");
    const { WebSocketServer, createWebSocketStream } = await import("ws");

    const seenAuth: Array<string | undefined> = [];
    const httpServer = createHttpServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (socket, request) => {
      seenAuth.push(request.headers.authorization);
      const stream = createWebSocketStream(socket, { allowHalfOpen: false });
      stream.on("data", (chunk: Buffer) => stream.write(chunk));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server has no port");
    }
    // ws:// (not wss://) is fine here: the scheme is the test server's, and the transport under
    // test only decides auth material — target derivation is what enforces wss endpoints.
    const url = `ws://127.0.0.1:${address.port}/control`;

    try {
      const response = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* SealantTransport;
            const duplex = yield* transport.open({
              kind: "websocket",
              url,
              auth: { bearerToken: "token-abc" },
            });
            return yield* Effect.tryPromise(
              () =>
                new Promise<string>((resolve, reject) => {
                  duplex.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
                  duplex.once("error", reject);
                  duplex.write("authed-round-trip");
                }),
            );
          }),
        ).pipe(Effect.provide(ControlTransportLive)),
      );
      expect(response).toBe("authed-round-trip");
      expect(seenAuth).toEqual(["Bearer token-abc"]);

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* SealantTransport;
            return yield* transport.open({ kind: "websocket", url });
          }),
        ).pipe(Effect.provide(ControlTransportLive)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toBeInstanceOf(TransportError);
        if (error instanceof TransportError) {
          expect(error.message).toContain("unauthenticated");
        }
      }
    } finally {
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

describe("websocket control transport prepare", () => {
  it("mints per-connection headers and subprotocols on both openers", async () => {
    const { createServer: createHttpServer } = await import("node:http");
    const { WebSocketServer, createWebSocketStream } = await import("ws");
    const { openControlTransport } = await import("./plain-transport.js");

    const seen: Array<{
      readonly authorization: string | undefined;
      readonly proxyAuth: string | undefined;
      readonly protocols: string | undefined;
    }> = [];
    const httpServer = createHttpServer();
    const wss = new WebSocketServer({
      server: httpServer,
      // Echo the first offered subprotocol back so the client accepts the upgrade.
      handleProtocols: (protocols) => [...protocols][0] ?? false,
    });
    wss.on("connection", (socket, request) => {
      seen.push({
        authorization: request.headers.authorization,
        proxyAuth: request.headers["x-aws-proxy-auth"]?.toString(),
        protocols: request.headers["sec-websocket-protocol"],
      });
      const stream = createWebSocketStream(socket, { allowHalfOpen: false });
      stream.on("data", (chunk: Buffer) => stream.write(chunk));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server has no port");
    }
    const url = `ws://127.0.0.1:${address.port}/sealant/control`;
    let minted = 0;
    const target = {
      kind: "websocket" as const,
      url,
      auth: { bearerToken: "control-token" },
      prepare: () => {
        minted += 1;
        return Promise.resolve({
          headers: { "X-aws-proxy-auth": `endpoint-token-${minted}` },
          protocols: ["lambda-microvms", `lambda-microvms.authentication.endpoint-token-${minted}`],
        });
      },
    };

    try {
      const effectEcho = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* SealantTransport;
            const duplex = yield* transport.open(target);
            return yield* Effect.tryPromise(
              () =>
                new Promise<string>((resolve, reject) => {
                  duplex.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
                  duplex.once("error", reject);
                  duplex.write("effect-round-trip");
                }),
            );
          }),
        ).pipe(Effect.provide(ControlTransportLive)),
      );
      expect(effectEcho).toBe("effect-round-trip");

      // The plain opener returns synchronously; the write below queues until the upgrade lands.
      const plain = openControlTransport(target);
      const plainEcho = await new Promise<string>((resolve, reject) => {
        plain.stream.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
        plain.stream.once("error", reject);
        plain.stream.write("plain-round-trip");
      });
      plain.close();
      expect(plainEcho).toBe("plain-round-trip");

      expect(minted).toBe(2);
      expect(seen).toEqual([
        {
          authorization: "Bearer control-token",
          proxyAuth: "endpoint-token-1",
          protocols: "lambda-microvms,lambda-microvms.authentication.endpoint-token-1",
        },
        {
          authorization: "Bearer control-token",
          proxyAuth: "endpoint-token-2",
          protocols: "lambda-microvms,lambda-microvms.authentication.endpoint-token-2",
        },
      ]);

      // A failing prepare fails the open on the typed channel (Effect) and the stream (plain).
      const failing = { ...target, prepare: () => Promise.reject(new Error("mint refused")) };
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* SealantTransport;
            return yield* transport.open(failing);
          }),
        ).pipe(Effect.provide(ControlTransportLive)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toBeInstanceOf(TransportError);
        if (error instanceof TransportError) {
          expect(error.message).toContain("mint refused");
        }
      }
      const plainFailing = openControlTransport(failing);
      const plainError = await new Promise<Error>((resolve) => {
        plainFailing.stream.once("error", resolve);
      });
      expect(plainError.message).toContain("mint refused");
    } finally {
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
