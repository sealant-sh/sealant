import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { Duplex } from "node:stream";

import { WebSocket, createWebSocketStream } from "ws";

/*
Gateway -> daemon-socket transport (gateway-spec §2).

The gateway drives one sealantd control connection per client SSH connection. That connection is a
length-prefixed protobuf stream that must reach the daemon's `control.sock` *inside* the workspace
container. We deliberately reject a localhost TCP listener (it would defeat the daemon's
`SO_PEERCRED` uid gate and be reachable by the untrusted workload). Three reaches are supported:

  (a) docker-exec + socat — the universal default (§2.1). `docker exec` runs as root, satisfying the
      daemon's uid gate with no allowlist change. One spawn per SSH session (long-lived control
      connection) is negligible vs the SSH handshake.

  (b) bind-mounted unix socket — an opt-in fast path (§2.2) for connection-churn workloads. The
      docker adapter bind-mounts the daemon's socket dir to a host path; the gateway connects
      directly with `net.connect`. This requires the daemon to allow the gateway's host uid
      (`SEALANT_ALLOWED_PEER_UIDS`), so it is selected only when the adapter advertises a socketPath.

  (c) secure WebSocket — Kubernetes. sealantd's `wss://…/control` frontend carries the identical
      framed byte stream as binary messages; mutual TLS with the cluster-internal CA authenticates
      the gateway (client cert) and the workspace (server cert for its Service DNS name).
*/

/** Client-side mTLS material (PEM file paths, read at open time). */
export interface WebSocketClientTls {
  readonly caPath: string;
  readonly certPath: string;
  readonly keyPath: string;
  readonly servername?: string;
}

/** Where the control socket lives, and how the gateway reaches it. */
export type ControlTarget =
  | {
      /** Default: bridge into the container with `docker exec ... socat`. */
      readonly kind: "docker-exec";
      /** Container id (or name) to `docker exec` into. */
      readonly containerId: string;
      /** Absolute path of the control socket *inside* the container. */
      readonly socketPath: string;
    }
  | {
      /** Fast path: the adapter bind-mounted the socket to a host path we can connect to directly. */
      readonly kind: "unix-socket";
      /** Absolute path of the control socket on the gateway host. */
      readonly socketPath: string;
    }
  | {
      /** Kubernetes: sealantd's secure WebSocket frontend. */
      readonly kind: "websocket";
      readonly url: string;
      readonly tls: WebSocketClientTls;
    };

/** A live transport: the byte stream plus an idempotent teardown that drops the daemon connection. */
export interface ControlTransport {
  /** Length-prefixed protobuf control frames flow over this Duplex. */
  readonly stream: Duplex;
  /** Tear the transport down (kills the bridge child / destroys the socket). Safe to call twice. */
  readonly close: () => void;
}

/**
 * (a) `docker exec -i <ctr> socat - UNIX-CONNECT:<sock>`: adapt the child's (stdout, stdin) into one
 * Duplex. No `-t` — a PTY would mangle the binary framing. The child is SIGKILLed on close so the
 * daemon observes the disconnect and tears down all of this connection's channels (§0.3).
 */
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

  // A bridge child that dies (socat connect failure, daemon gone) must surface as a stream end so the
  // SealantClient fails its pending requests/channels rather than hanging.
  child.on("exit", () => {
    stream.destroy();
  });
  child.on("error", (error) => {
    stream.destroy(error);
  });

  return { stream, close };
};

/**
 * (b) Direct `net.connect` to a bind-mounted socket on the gateway host. Sub-ms, no child process.
 */
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

/**
 * (c) `wss://` with client-certificate authentication. `createWebSocketStream` yields a Duplex
 * whose bytes are exactly the binary message payloads; a handshake failure destroys the stream so
 * the SealantClient fails fast. Nothing about the TLS material is logged.
 */
const openWebSocket = (target: {
  readonly url: string;
  readonly tls: WebSocketClientTls;
}): ControlTransport => {
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
export const openControlTransport = (target: ControlTarget): ControlTransport => {
  switch (target.kind) {
    case "unix-socket":
      return openUnixSocket(target);
    case "docker-exec":
      return openDockerExec(target);
    case "websocket":
      return openWebSocket(target);
  }
};
