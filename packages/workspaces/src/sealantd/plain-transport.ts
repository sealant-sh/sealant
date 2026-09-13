import { spawn } from "node:child_process";
import net from "node:net";
import { Duplex } from "node:stream";

import { createWebSocketStream } from "ws";

import { createControlWebSocket, type SealantTarget } from "./runtime.js";

/*
Plain (non-Effect) control transport over a `SealantTarget`.

Two consumers drive sealantd control connections with different lifecycles:

  - The control plane (worker, API) composes Effect programs and uses the scoped
    `SealantTransport` service in `runtime.ts`.
  - Callback-style hosts — the SSH gateway's ssh2 server first among them — hold one long-lived
    connection per client and need a bare Duplex plus an idempotent close, with connect failures
    surfacing as stream errors rather than a failed Effect.

This file is the single home of the callback-style openers so a transport for a new runtime is
added HERE and in `runtime.ts`'s scoped openers, side by side — never re-implemented in an app.
The mechanics per target kind:

  (a) docker-exec + socat — `docker exec` runs as root, satisfying the daemon's `SO_PEERCRED` uid
      gate with no allowlist change. One spawn per connection; no `-t`, a PTY would mangle the
      binary framing. The child is SIGKILLed on close so the daemon observes the disconnect and
      tears down all of this connection's channels.

  (b) bind-mounted unix socket — the adapter bind-mounted the daemon's socket dir to a host path;
      connect directly with `net.connect`. Requires the daemon to allow this host uid
      (`SEALANT_ALLOWED_PEER_UIDS`).

  (c) secure WebSocket — sealantd's `wss://…/control` frontend carries the identical framed byte
      stream as binary messages; mutual TLS authenticates both sides. Nothing about the TLS
      material is logged. A target with `prepare` (per-connection proxy material, minted
      asynchronously) gets a deferred Duplex: writes queue until the upgrade completes, so the
      synchronous `openControlTransport` contract these hosts rely on is unchanged.
*/

/** A live transport: the byte stream plus an idempotent teardown that drops the daemon connection. */
export interface ControlTransport {
  /** Length-prefixed protobuf control frames flow over this Duplex. */
  readonly stream: Duplex;
  /** Tear the transport down (kills the bridge child / destroys the socket). Safe to call twice. */
  readonly close: () => void;
}

const openDockerExec = (target: {
  readonly containerId: string;
  readonly socketPath: string;
}): ControlTransport => {
  const child = spawn(
    "docker",
    ["exec", "-i", target.containerId, "socat", "-", `UNIX-CONNECT:${target.socketPath}`],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const stream = Duplex.from({
    readable: child.stdout as NodeJS.ReadableStream,
    writable: child.stdin as NodeJS.WritableStream,
  });

  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    stream.destroy();
    child.kill("SIGKILL");
  };

  // A bridge child that dies (socat connect failure, daemon gone) must surface as a stream end so
  // the client fails its pending requests/channels rather than hanging.
  child.on("exit", () => {
    stream.destroy();
  });
  child.on("error", (error) => {
    stream.destroy(error);
  });

  return { stream, close };
};

const openUnixSocket = (target: { readonly socketPath: string }): ControlTransport => {
  const socket = net.createConnection(target.socketPath);
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    socket.destroy();
  };
  return { stream: socket, close };
};

const connectWebSocket = (
  target: Extract<SealantTarget, { readonly kind: "websocket" }>,
  material: Awaited<ReturnType<NonNullable<typeof target.prepare>>> | undefined,
): ControlTransport => {
  const socket = createControlWebSocket(target, material);
  const stream = createWebSocketStream(socket, { allowHalfOpen: false });
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    stream.destroy();
    socket.terminate();
  };
  return { stream, close };
};

/**
 * A transport whose inner connection arrives later (after `prepare` resolves). Writes queue in
 * order until then; reads, end, errors and close propagate from the inner stream once it exists.
 * A close before the inner connection arrives discards it on arrival.
 */
const deferredTransport = (pending: Promise<ControlTransport>): ControlTransport => {
  let inner: ControlTransport | undefined;
  let closed = false;
  const queuedWrites: Array<{ chunk: Buffer; callback: (error?: Error | null) => void }> = [];
  let queuedFinal: ((error?: Error | null) => void) | undefined;

  const stream = new Duplex({
    read() {
      inner?.stream.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      if (inner === undefined) {
        queuedWrites.push({ chunk, callback });
        return;
      }
      inner.stream.write(chunk, callback);
    },
    final(callback) {
      if (inner === undefined) {
        queuedFinal = callback;
        return;
      }
      inner.stream.end(callback);
    },
    destroy(error, callback) {
      closed = true;
      inner?.close();
      callback(error);
    },
  });

  const attach = async (): Promise<void> => {
    let transport: ControlTransport;
    try {
      transport = await pending;
    } catch (error: unknown) {
      stream.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (closed) {
      transport.close();
      return;
    }
    inner = transport;
    transport.stream.on("data", (chunk: Buffer) => {
      if (!stream.push(chunk)) {
        transport.stream.pause();
      }
    });
    transport.stream.on("end", () => stream.push(null));
    transport.stream.on("error", (error: Error) => stream.destroy(error));
    transport.stream.on("close", () => stream.destroy());
    for (const queued of queuedWrites.splice(0)) {
      transport.stream.write(queued.chunk, queued.callback);
    }
    if (queuedFinal !== undefined) {
      transport.stream.end(queuedFinal);
    }
  };
  void attach();

  return { stream, close: () => stream.destroy() };
};

const openWebSocket = (
  target: Extract<SealantTarget, { readonly kind: "websocket" }>,
): ControlTransport => {
  const prepare = target.prepare;
  if (prepare === undefined) {
    return connectWebSocket(target, undefined);
  }
  // Validate auth before the async hop so a misconfigured target still fails synchronously.
  if (target.tls === undefined && target.auth === undefined) {
    throw new Error(
      "Refusing an unauthenticated websocket control connection: the target carries neither client TLS material nor a bearer token.",
    );
  }
  return deferredTransport(prepare().then((material) => connectWebSocket(target, material)));
};

/** Open the control transport for a resolved target, preferring the bind-mounted fast path. */
export const openControlTransport = (target: SealantTarget): ControlTransport => {
  switch (target.kind) {
    case "unix-socket":
      return openUnixSocket(target);
    case "docker-exec":
      return openDockerExec(target);
    case "websocket":
      return openWebSocket(target);
  }
};
