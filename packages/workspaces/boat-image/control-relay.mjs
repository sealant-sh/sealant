import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";

import { WebSocketServer, createWebSocketStream } from "ws";

import receiverRoutes from "./receiver-routes.json" with { type: "json" };

// One list for this relay, the guest receiver and Core. Core aborts at the route budget, so the
// relay allows a little longer and never answers for the receiver while Core is still waiting.
const RELAY_GRACE_MS = 5000;
const IDLE_MS = 5000;
// guest_control.py writes this one line before any daemon byte.
const BRIDGE_FORMAT = "sealant-control-bridge-v1";
const BRIDGE_VERDICT_BYTES = 512;
const routes = new Map(receiverRoutes.routes.map((route) => [route.path, route]));

const options = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (
    !["--socket", "--token-file", "--port", "--bootstrap-socket"].includes(name) ||
    !value ||
    options.has(name)
  ) {
    process.stderr.write("Invalid relay configuration\n");
    process.exit(2);
  }
  options.set(name, value);
}
const socketPath = options.get("--socket");
const tokenPath = options.get("--token-file");
const bootstrapSocket = options.get("--bootstrap-socket");
const port = Number(options.get("--port"));
let expected;
try {
  if (
    !socketPath?.startsWith("/") ||
    !tokenPath?.startsWith("/") ||
    (bootstrapSocket !== undefined && !bootstrapSocket.startsWith("/")) ||
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
const bootstrapRequests = new Set();
const server = http.createServer(
  { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
  (request, response) => {
    if (!authorized(request)) {
      response.writeHead(401).end();
      return;
    }
    const route = bootstrapSocket ? routes.get(request.url) : undefined;
    if (route !== undefined) {
      const length = request.headers["content-length"];
      const isStage = route.method === "POST";
      if (request.method !== route.method) {
        response.writeHead(404).end();
        return;
      }
      if (bootstrapRequests.size >= 4) {
        response.writeHead(503).end();
        return;
      }
      if (
        request.headers["transfer-encoding"] ||
        (isStage &&
          (typeof length !== "string" ||
            !/^[0-9]+$/.test(length) ||
            Number(length) < 1 ||
            Number(length) > 4 * 1024 * 1024 ||
            request.headers["content-type"] !== "application/json")) ||
        (!isStage && length !== undefined && length !== "0")
      ) {
        response.writeHead(400).end();
        return;
      }
      const upstream = http.request({
        socketPath: bootstrapSocket,
        path: request.url,
        method: request.method,
        headers: {
          authorization: request.headers.authorization,
          ...(isStage ? { "content-type": "application/json", "content-length": length } : {}),
        },
        timeout: route.budgetMs + RELAY_GRACE_MS,
      });
      // The listener's idle cutoff guards unauthenticated sockets; a forwarded operation gets its
      // budget. The caller's socket outlives the upstream deadline so the 504 below is delivered.
      request.socket.setTimeout(route.budgetMs + RELAY_GRACE_MS + IDLE_MS);
      response.once("finish", () => request.socket.setTimeout(IDLE_MS));
      bootstrapRequests.add(upstream);
      const teardown = () => {
        bootstrapRequests.delete(upstream);
        upstream.destroy();
      };
      response.once("close", teardown);
      upstream.once("timeout", () => {
        bootstrapRequests.delete(upstream);
        if (!response.headersSent) response.writeHead(504).end();
        else response.destroy();
        upstream.destroy();
      });
      upstream.once("error", () => {
        bootstrapRequests.delete(upstream);
        if (response.writableEnded) return;
        if (!response.headersSent) response.writeHead(503).end();
        else response.destroy();
      });
      upstream.once("response", (reply) => {
        response.writeHead(reply.statusCode ?? 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        reply.once("error", () => response.destroy());
        reply.pipe(response);
      });
      request.pipe(upstream);
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
server.setTimeout(IDLE_MS);

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
  let upgraded = false;
  const teardown = () => {
    pending.delete(unix);
    bridges.delete(teardown);
    unix.destroy();
    stream?.destroy();
    websocket?.terminate();
    socket.destroy();
  };
  // The bridge answers each connection with one verdict line before any daemon byte. Only a bridge
  // that reached the daemon is upgraded; a refusal keeps its reason, in the receiver's error shape.
  const refuse = (reason) => {
    pending.delete(unix);
    unix.destroy();
    if (socket.destroyed) return;
    const body = JSON.stringify({ error: reason });
    socket.once("finish", () => socket.destroy());
    socket.end(
      `HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  };
  const failed = () => (upgraded ? teardown() : refuse("control-unavailable"));
  unix.setTimeout(5000, failed);
  unix.once("error", failed);
  unix.once("end", () => {
    if (!upgraded) refuse("control-unavailable");
  });
  unix.once("close", (hadError) => {
    if (upgraded && (hadError || !unix.readableEnded)) teardown();
  });
  socket.once("error", teardown);
  socket.once("close", () => {
    if (upgraded) teardown();
    else {
      pending.delete(unix);
      unix.destroy();
    }
  });
  let verdict = Buffer.alloc(0);
  const onVerdict = (chunk) => {
    verdict = Buffer.concat([verdict, chunk]);
    const end = verdict.indexOf(0x0a);
    if (end === -1) {
      if (verdict.length > BRIDGE_VERDICT_BYTES) refuse("control-unavailable");
      return;
    }
    unix.off("data", onVerdict);
    unix.pause();
    let status;
    try {
      status = JSON.parse(verdict.subarray(0, end).toString("utf8"));
    } catch {
      status = undefined;
    }
    if (status?.format !== BRIDGE_FORMAT || status.control !== "connected") {
      refuse(
        typeof status?.error === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(status.error)
          ? status.error
          : "control-unavailable",
      );
      return;
    }
    const rest = verdict.subarray(end + 1);
    if (rest.length > 0) unix.unshift(rest);
    upgraded = true;
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
  };
  unix.on("data", onVerdict);
});

const close = (exitCode = 0) => {
  for (const upstream of bootstrapRequests) upstream.destroy();
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
