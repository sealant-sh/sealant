import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";

import { WebSocketServer, createWebSocketStream } from "ws";

const options = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!["--socket", "--token-file", "--port"].includes(name) || !value || options.has(name)) {
    process.stderr.write("Invalid relay configuration\n");
    process.exit(2);
  }
  options.set(name, value);
}
const socketPath = options.get("--socket");
const tokenPath = options.get("--token-file");
const port = Number(options.get("--port"));
let expected;
try {
  if (
    !socketPath?.startsWith("/") ||
    !tokenPath?.startsWith("/") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error();
  const descriptor = openSync(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size !== 64 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid()
    )
      throw new Error();
    const token = readFileSync(descriptor, "utf8");
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error();
    expected = createHash("sha256").update(`Bearer ${token}`).digest();
  } finally {
    closeSync(descriptor);
  }
} catch {
  process.stderr.write("Invalid relay configuration\n");
  process.exit(2);
}

const authorized = (request) =>
  typeof request.headers.authorization === "string" &&
  timingSafeEqual(createHash("sha256").update(request.headers.authorization).digest(), expected);
const pathname = (request) => {
  try {
    return new URL(request.url, "http://relay.invalid").pathname;
  } catch {
    return undefined;
  }
};
const pending = new Set();
const bridges = new Set();
const server = http.createServer(
  { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
  (request, response) => {
    if (!authorized(request)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "GET" || pathname(request) !== "/sealant/health") {
      response.writeHead(404).end();
      return;
    }
    if (pending.size + bridges.size >= 64) {
      response.writeHead(503).end();
      return;
    }
    const unix = net.createConnection(socketPath);
    pending.add(unix);
    const finish = (reachable) => {
      pending.delete(unix);
      unix.destroy();
      if (!response.writableEnded && !response.destroyed) {
        response
          .writeHead(reachable ? 200 : 503, {
            "content-type": "application/json",
            "cache-control": "no-store",
          })
          .end(
            JSON.stringify({
              controlSocket: reachable ? "reachable" : "unavailable",
              nativeReadiness: "unverified",
            }),
          );
      }
    };
    unix.setTimeout(1000, () => finish(false));
    unix.once("error", () => finish(false));
    unix.once("connect", () => finish(true));
    response.once("close", () => {
      pending.delete(unix);
      unix.destroy();
    });
  },
);
server.setTimeout(5000);

const websockets = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 16 * 1024 * 1024,
});
server.on("upgrade", (request, socket, head) => {
  const reject = (status) =>
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  if (!authorized(request)) {
    reject("401 Unauthorized");
    return;
  }
  if (request.method !== "GET" || pathname(request) !== "/sealant/control") {
    reject("404 Not Found");
    return;
  }
  if (pending.size + bridges.size >= 64) {
    reject("503 Service Unavailable");
    return;
  }
  const unix = net.createConnection(socketPath);
  pending.add(unix);
  let stream;
  let websocket;
  const teardown = () => {
    pending.delete(unix);
    bridges.delete(teardown);
    unix.destroy();
    stream?.destroy();
    websocket?.terminate();
    socket.destroy();
  };
  unix.setTimeout(5000, teardown);
  unix.once("error", teardown);
  unix.once("close", (hadError) => {
    if (hadError || !unix.readableEnded) teardown();
  });
  socket.once("error", teardown);
  socket.once("close", teardown);
  unix.once("connect", () => {
    pending.delete(unix);
    bridges.add(teardown);
    unix.setTimeout(0);
    if (socket.destroyed) {
      teardown();
      return;
    }
    try {
      websockets.handleUpgrade(request, socket, head, (connected) => {
        websocket = connected;
        stream = createWebSocketStream(connected, {
          allowHalfOpen: false,
          highWaterMark: 64 * 1024,
        });
        stream.once("error", teardown);
        stream.once("close", teardown);
        connected.once("close", teardown);
        unix.pipe(stream).pipe(unix);
      });
    } catch {
      teardown();
    }
  });
});

const close = (exitCode = 0) => {
  for (const unix of pending) unix.destroy();
  for (const teardown of bridges) teardown();
  server.closeAllConnections();
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(1), 1500).unref();
};
process.once("SIGTERM", () => close());
process.once("SIGINT", () => close());
server.on("error", () => {
  process.stderr.write("Relay listener failed\n");
  close(1);
});
server.listen(port, "0.0.0.0", () => process.stdout.write("Relay listening\n"));
