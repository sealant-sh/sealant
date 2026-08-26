import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { Duplex } from "node:stream";

import { WebSocket, createWebSocketStream } from "ws";

import type { SealantTarget } from "./runtime.js";

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
      material is logged.
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

const openWebSocket = (
  target: Extract<SealantTarget, { readonly kind: "websocket" }>,
): ControlTransport => {
  const socket = new WebSocket(target.url, {
    ca: readFileSync(target.tls.caPath),
    cert: readFileSync(target.tls.certPath),
    key: readFileSync(target.tls.keyPath),
    ...(target.tls.servername === undefined ? {} : { servername: target.tls.servername }),
    rejectUnauthorized: true,
    perMessageDeflate: false,
    handshakeTimeout: 15_000,
  });
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
