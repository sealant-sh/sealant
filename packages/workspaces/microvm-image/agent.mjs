#!/usr/bin/env node
// The Sealant MicroVM agent: PID 1 of the workspace image built by `build-image.sh`.
//
// It mirrors the typed contract in `src/runtime/microvm/agent-contract.ts` by hand (this file
// runs inside an AWS Lambda MicroVM with nothing but Node's standard library) and exists for
// three reasons the platform imposes:
//
//   1. Lifecycle hooks. Lambda POSTs `/aws/lambda-microvms/runtime/v1/<hook>` to the image's
//      hook port: `ready`/`validate` at image build, `run` when a VM starts (with the RunMicrovm
//      payload), `resume`, and `suspend`/`terminate` before the VM is checkpointed or ends. The
//      last two run `sealantctl capture flush` so no captured work is lost, bounded by the flush
//      timeout the launch delivered (the platform's own hook timeout is at most 60 s; what it
//      does when a hook overruns is undocumented).
//   2. Launch material. RunMicrovm takes no environment and no secrets, so the control plane
//      pushes boot env, the secret env file and dotfiles to `POST /sealant/launch` over the VM's
//      authenticated endpoint, and only then does `sealantd boot` start. The push is authorised
//      by the one-launch secret from the run-hook payload.
//   3. Control reach. sealantd's own WebSocket frontend is mutual-TLS only and the endpoint
//      proxy terminates TLS, so `GET /sealant/control` relays a plaintext WebSocket to the
//      daemon's Unix control socket. Authorised by the deployment's control token, which
//      arrived inside the launch push.
//
// One listener serves all three; the image registers the same port for hooks and the endpoint
// targets it by default.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const CONTRACT_VERSION = 1;
const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1";
const LAUNCH_ROUTE = "/sealant/launch";
const HEALTH_ROUTE = "/sealant/health";
const CONTROL_ROUTE = "/sealant/control";

const PORT = Number(process.env.SEALANT_MICROVM_AGENT_PORT ?? 8080);
const CONTROL_SOCKET = process.env.SEALANT_CONTROL_SOCKET ?? "/run/sealant/control.sock";
// Where launch material is written; overridable so the agent can be tested outside a VM.
const STATE_DIR = process.env.SEALANT_MICROVM_AGENT_STATE_DIR ?? "/run/sealant";
const SECRET_ENV_FILE = path.join(STATE_DIR, "secrets", "env.json");
const DOTFILES_DIR = path.join(STATE_DIR, "dotfiles");
const SEALANTD = process.env.SEALANT_MICROVM_SEALANTD ?? "/usr/local/bin/sealantd";
const SEALANTCTL = process.env.SEALANT_MICROVM_SEALANTCTL ?? "sealantctl";
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const state = {
  microvmId: null,
  runId: null,
  /** Authorises exactly one launch push; cleared once the daemon is started. */
  launchSecret: null,
  /** Authorises health and control connections; arrives inside the launch push. */
  controlToken: null,
  flushTimeoutMs: 50_000,
  booted: false,
  daemon: null,
  daemonExit: null,
};

const log = (line) => {
  console.log(`${new Date().toISOString()} agent: ${line}`);
};

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const message = (res, status, text) => json(res, status, { message: text });

const readBody = async (req) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`request body over ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/** Constant-time bearer comparison; a missing or differently sized value never short-circuits. */
const bearerMatches = (header, expected) => {
  if (typeof header !== "string" || expected === null) {
    return false;
  }
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && presented.length > 0;
};

const isEnvName = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

// --------------------------------------------------------------------------------------------
// Lifecycle hooks
// --------------------------------------------------------------------------------------------

/** `sealantctl capture flush`, bounded; never throws — the hook reports what happened. */
const flushCaptures = async () => {
  const startedAt = Date.now();
  const child = spawn(SEALANTCTL, ["--socket", CONTROL_SOCKET, "capture", "flush"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk) => {
    output = (output + chunk.toString("utf8")).slice(-4096);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, state.flushTimeoutMs);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    });
    return {
      ok: code === 0 && !timedOut,
      exitCode: code,
      signal,
      timedOut,
      durationMs: Date.now() - startedAt,
      output,
    };
  } catch (error) {
    return { ok: false, exitCode: null, timedOut: false, error: error.message, output };
  } finally {
    clearTimeout(timer);
  }
};

const handleHook = async (hook, req, res) => {
  switch (hook) {
    case "ready":
    case "validate":
      // Image build time: nothing session-specific exists yet. Safe to snapshot.
      return json(res, 200, { status: "ok", hook });
    case "run": {
      const raw = await readBody(req);
      const envelope = raw === "" ? {} : JSON.parse(raw);
      const payload =
        typeof envelope.runHookPayload === "string" ? JSON.parse(envelope.runHookPayload) : null;
      if (
        payload === null ||
        payload.version !== CONTRACT_VERSION ||
        typeof payload.runId !== "string" ||
        !/^[0-9a-f]{64}$/.test(String(payload.launchSecret))
      ) {
        // A 500 here fails the VM start, which is right: the payload is the control plane's
        // and a malformed one means this VM would never receive its launch material.
        throw new Error("run hook payload does not match the sealant agent contract v1");
      }
      state.microvmId = typeof envelope.microvmId === "string" ? envelope.microvmId : null;
      state.runId = payload.runId;
      state.launchSecret = payload.launchSecret;
      log(`run: microvm ${state.microvmId} run ${state.runId}`);
      return json(res, 200, { status: "ok", hook });
    }
    case "resume":
      return json(res, 200, { status: "ok", hook, booted: state.booted });
    case "suspend":
    case "terminate": {
      if (!state.booted) {
        return json(res, 200, { status: "ok", hook, flush: "not-booted" });
      }
      const flush = await flushCaptures();
      log(`${hook}: capture flush ${flush.ok ? "ok" : "FAILED"} ${JSON.stringify(flush)}`);
      // Always 200: the platform's behaviour on a non-200 suspend/terminate is undocumented,
      // and a refused hook cannot recover a failed flush anyway. The report is the evidence.
      return json(res, 200, { status: "ok", hook, flush });
    }
    default:
      return message(res, 404, `unknown hook ${hook}`);
  }
};

// --------------------------------------------------------------------------------------------
// Launch material and the daemon
// --------------------------------------------------------------------------------------------

const writePrivate = async (file, content, mode) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, content, { mode });
  await chmod(file, mode);
};

const startDaemon = (bootEnv) => {
  const env = { ...process.env, ...bootEnv, SEALANT_CONTROL_SOCKET: CONTROL_SOCKET };
  const child = spawn(SEALANTD, ["boot"], { env, stdio: ["ignore", "inherit", "inherit"] });
  state.daemon = child;
  child.on("exit", (code, signal) => {
    state.daemonExit = { code, signal };
    log(`sealantd boot exited (code ${code}, signal ${signal})`);
  });
  child.on("error", (error) => {
    state.daemonExit = { code: null, signal: null, error: error.message };
    log(`sealantd boot could not start: ${error.message}`);
  });
};

const handleLaunch = async (req, res) => {
  if (state.booted) {
    return json(res, 409, { message: "already booted" });
  }
  if (state.launchSecret === null) {
    return message(res, 503, "the run hook has not delivered a launch secret yet");
  }
  if (!bearerMatches(req.headers.authorization, state.launchSecret)) {
    return message(res, 401, "launch secret does not match this VM's run");
  }
  const body = JSON.parse((await readBody(req)) || "{}");
  if (
    body.version !== CONTRACT_VERSION ||
    typeof body.runId !== "string" ||
    body.runId !== state.runId ||
    typeof body.controlToken !== "string" ||
    body.controlToken.length === 0 ||
    !Number.isInteger(body.flushTimeoutMs) ||
    body.flushTimeoutMs <= 0 ||
    typeof body.bootEnv !== "object" ||
    body.bootEnv === null ||
    !Object.entries(body.bootEnv).every(([k, v]) => isEnvName(k) && typeof v === "string")
  ) {
    return message(res, 400, "launch request does not match the sealant agent contract v1");
  }
  const bootEnv = { ...body.bootEnv };
  if (typeof body.secretEnvJson === "string" && body.secretEnvJson.length > 0) {
    await writePrivate(SECRET_ENV_FILE, body.secretEnvJson, 0o600);
    bootEnv.SEALANT_SECRET_ENV_FILE = SECRET_ENV_FILE;
  } else {
    delete bootEnv.SEALANT_SECRET_ENV_FILE;
  }
  if (body.dotfiles !== undefined && body.dotfiles !== null) {
    const { manifestJson, archives } = body.dotfiles;
    if (typeof manifestJson !== "string" || !Array.isArray(archives)) {
      return message(res, 400, "launch request dotfiles do not match the contract");
    }
    await writePrivate(path.join(DOTFILES_DIR, "manifest.json"), manifestJson, 0o644);
    for (const archive of archives) {
      if (
        typeof archive.name !== "string" ||
        !/^[A-Za-z0-9._-]+$/.test(archive.name) ||
        typeof archive.contentBase64 !== "string"
      ) {
        return message(res, 400, "launch request dotfiles archive does not match the contract");
      }
      await writePrivate(
        path.join(DOTFILES_DIR, archive.name),
        Buffer.from(archive.contentBase64, "base64"),
        0o644,
      );
    }
    bootEnv.SEALANT_DOTFILES_ARCHIVE_DIR = DOTFILES_DIR;
  } else {
    delete bootEnv.SEALANT_DOTFILES_ARCHIVE_DIR;
  }
  // From here on only the control token authorises anything; the launch secret is spent.
  state.controlToken = body.controlToken;
  state.flushTimeoutMs = body.flushTimeoutMs;
  state.launchSecret = null;
  state.booted = true;
  startDaemon(bootEnv);
  log(`launch: sealantd boot started for run ${state.runId}`);
  return json(res, 200, { outcome: "booting" });
};

const controlSocketReady = () => existsSync(CONTROL_SOCKET);

const handleHealth = (req, res) => {
  if (!bearerMatches(req.headers.authorization, state.controlToken)) {
    return message(res, 401, "control token does not match");
  }
  const body = {
    booted: state.booted,
    controlSocket: controlSocketReady(),
    ...(state.daemonExit === null
      ? {}
      : { daemonExit: { code: state.daemonExit.code, signal: state.daemonExit.signal } }),
  };
  const healthy = state.booted && body.controlSocket && state.daemonExit === null;
  return json(res, healthy ? 200 : 503, body);
};

// --------------------------------------------------------------------------------------------
// WebSocket ↔ control socket relay (RFC 6455 server side, binary frames only)
// --------------------------------------------------------------------------------------------

const encodeFrame = (opcode, payload) => {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
};

/** Parse as many complete client frames as `buffer` holds; returns them and the remainder. */
const parseFrames = (buffer) => {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      const big = buffer.readBigUInt64BE(cursor);
      if (big > BigInt(MAX_BODY_BYTES)) {
        throw new Error("websocket frame too large");
      }
      length = Number(big);
      cursor += 8;
    }
    let mask = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask !== null) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4];
      }
    }
    frames.push({ opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
};

const handleControlUpgrade = (req, socket, head) => {
  const refuse = (status, text) => {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
    );
    socket.destroy();
  };
  if (!bearerMatches(req.headers.authorization, state.controlToken)) {
    return refuse(401, "control token does not match");
  }
  if (!state.booted || !controlSocketReady()) {
    return refuse(503, "sealantd control socket is not ready");
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
    return refuse(400, "not a websocket upgrade");
  }
  const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  // Echo the first offered subprotocol (if the proxy forwards any) so strict clients accept.
  const offered = req.headers["sec-websocket-protocol"];
  const protocol = typeof offered === "string" ? offered.split(",")[0]?.trim() : undefined;

  const daemon = net.connect(CONTROL_SOCKET);
  daemon.once("error", (error) => {
    if (!socket.destroyed && socket.writable && !upgraded) {
      refuse(502, `control socket: ${error.message}`);
    } else {
      socket.destroy();
    }
  });
  let upgraded = false;
  daemon.once("connect", () => {
    upgraded = true;
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "upgrade: websocket",
        "connection: Upgrade",
        `sec-websocket-accept: ${accept}`,
        ...(protocol === undefined || protocol === ""
          ? []
          : [`sec-websocket-protocol: ${protocol}`]),
        "",
        "",
      ].join("\r\n"),
    );
    let pending = Buffer.alloc(0);
    const onClientData = (chunk) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let parsed;
      try {
        parsed = parseFrames(pending);
      } catch (error) {
        log(`control: ${error.message}`);
        socket.destroy();
        daemon.destroy();
        return;
      }
      pending = parsed.rest;
      for (const frame of parsed.frames) {
        switch (frame.opcode) {
          case 0x0: // continuation: the relay is a byte stream, fragments forward in order
          case 0x1:
          case 0x2:
            if (!daemon.write(frame.payload)) {
              socket.pause();
              daemon.once("drain", () => socket.resume());
            }
            break;
          case 0x8:
            socket.end(encodeFrame(0x8, frame.payload.subarray(0, 2)));
            daemon.end();
            break;
          case 0x9:
            socket.write(encodeFrame(0xa, frame.payload));
            break;
          default:
            break;
        }
      }
    };
    if (head.length > 0) {
      onClientData(head);
    }
    socket.on("data", onClientData);
    daemon.on("data", (chunk) => {
      if (!socket.write(encodeFrame(0x2, chunk))) {
        daemon.pause();
        socket.once("drain", () => daemon.resume());
      }
    });
    daemon.on("end", () => socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xe8]))));
    daemon.on("close", () => socket.destroy());
    socket.on("close", () => daemon.destroy());
    socket.on("error", () => daemon.destroy());
  });
};

// --------------------------------------------------------------------------------------------
// Server
// --------------------------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const respond = async () => {
    if (req.method === "POST" && url.startsWith(`${HOOK_PREFIX}/`)) {
      return handleHook(url.slice(HOOK_PREFIX.length + 1), req, res);
    }
    if (req.method === "POST" && url === LAUNCH_ROUTE) {
      return handleLaunch(req, res);
    }
    if (req.method === "GET" && url === HEALTH_ROUTE) {
      return handleHealth(req, res);
    }
    if (url === CONTROL_ROUTE) {
      return message(res, 426, "the control route only speaks WebSocket");
    }
    return message(res, 404, "unknown route");
  };
  respond().catch((error) => {
    log(`${req.method} ${url}: ${error.message}`);
    if (!res.headersSent) {
      message(res, 500, error.message);
    } else {
      res.end();
    }
  });
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== CONTROL_ROUTE) {
    socket.write("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  handleControlUpgrade(req, socket, head);
});

const shutdown = (signal) => {
  log(`${signal}: stopping`);
  state.daemon?.kill("SIGTERM");
  server.close();
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : PORT;
  log(`listening on :${port}`);
});
