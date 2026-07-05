import { spawn } from "node:child_process";
import net from "node:net";
import { Duplex } from "node:stream";

/*
Gateway -> daemon-socket transport (gateway-spec §2).

The gateway drives one sealantd control connection per client SSH connection. That connection is a
length-prefixed protobuf stream that must reach the daemon's `control.sock` *inside* the sandbox
container. We deliberately reject a localhost TCP listener (it would defeat the daemon's
`SO_PEERCRED` uid gate and be reachable by the untrusted workload). Two reaches are supported:

  (a) docker-exec + socat — the universal default (§2.1). `docker exec` runs as root, satisfying the
      daemon's uid gate with no allowlist change. One spawn per SSH session (long-lived control
      connection) is negligible vs the SSH handshake.

  (b) bind-mounted unix socket — an opt-in fast path (§2.2) for connection-churn workloads. The
      docker adapter bind-mounts the daemon's socket dir to a host path; the gateway connects
      directly with `net.connect`. This requires the daemon to allow the gateway's host uid
      (`SEALANT_ALLOWED_PEER_UIDS`), so it is selected only when the adapter advertises a socketPath.
*/

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

/** Open the control transport for a resolved target, preferring the bind-mounted fast path. */
export const openControlTransport = (target: ControlTarget): ControlTransport => {
  if (target.kind === "unix-socket") {
    return openUnixSocket(target);
  }
  return openDockerExec(target);
};
