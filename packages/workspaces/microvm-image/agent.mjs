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
import { mkdir, open, rename, unlink } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import {
  createDockerService,
  stopGuestProcessGroup as stopProcessGroup,
} from "./docker-service.mjs";

const CONTRACT_VERSION = 1;
const DOCKER_CONTRACT_VERSION = 2;
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
const DOCKER_CAPABLE = process.env.SEALANT_MICROVM_DOCKER_CAPABLE === "1";
const DOCKERD = process.env.SEALANT_MICROVM_DOCKERD ?? "/usr/local/bin/dockerd";
const DOCKER = process.env.SEALANT_MICROVM_DOCKER ?? "/usr/local/bin/docker";
const DOCKER_SOCKET = process.env.SEALANT_MICROVM_DOCKER_SOCKET ?? "/run/docker/docker.sock";
const DOCKER_DATA_ROOT = process.env.SEALANT_MICROVM_DOCKER_DATA_ROOT ?? "/var/lib/sealant/docker";
const DOCKER_EXEC_ROOT = process.env.SEALANT_MICROVM_DOCKER_EXEC_ROOT ?? "/run/sealant/docker-exec";
const DOCKER_PID_FILE = process.env.SEALANT_MICROVM_DOCKER_PID_FILE ?? "/run/sealant/docker.pid";
const DOCKER_READY_TIMEOUT_MS = process.env.SEALANT_MICROVM_DOCKER_READY_TIMEOUT_MS;
const DOCKER_PROBE_INTERVAL_MS = process.env.SEALANT_MICROVM_DOCKER_PROBE_INTERVAL_MS;
const DOCKER_PROBE_TIMEOUT_MS = process.env.SEALANT_MICROVM_DOCKER_PROBE_TIMEOUT_MS;
const DOCKER_SHUTDOWN_TIMEOUT_MS = process.env.SEALANT_MICROVM_DOCKER_SHUTDOWN_TIMEOUT_MS;
// Root-readable guest diagnostics only. Health and control responses never include this file.
const DOCKER_LOG = process.env.SEALANT_MICROVM_DOCKER_LOG ?? "/run/sealant/dockerd.stderr.log";
const DOCKER_LOG_MAX_BYTES = process.env.SEALANT_MICROVM_DOCKER_LOG_MAX_BYTES;
const DOCKER_SERVICE_OPTIONS = {
  dockerdPath: DOCKERD,
  dockerPath: DOCKER,
  socketPath: DOCKER_SOCKET,
  dataRoot: DOCKER_DATA_ROOT,
  execRoot: DOCKER_EXEC_ROOT,
  pidFile: DOCKER_PID_FILE,
  readinessTimeoutMs: DOCKER_READY_TIMEOUT_MS,
  probeIntervalMs: DOCKER_PROBE_INTERVAL_MS,
  probeTimeoutMs: DOCKER_PROBE_TIMEOUT_MS,
  shutdownTimeoutMs: DOCKER_SHUTDOWN_TIMEOUT_MS,
  logPath: DOCKER_LOG,
  logMaxBytes: DOCKER_LOG_MAX_BYTES,
};
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const imageValidation = {
  phase: "idle",
  dockerService: null,
};

const state = {
  microvmId: null,
  runId: null,
  /** Authorises exactly one launch push; cleared once the launch is accepted. */
  launchSecret: null,
  /** Authorises health and control connections; arrives inside the launch push. */
  controlToken: null,
  contractVersion: null,
  launchInProgress: false,
  launchAccepted: false,
  flushTimeoutMs: 50_000,
  booted: false,
  daemon: null,
  daemonExit: null,
  dockerService: null,
  hookChildren: new Set(),
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

const hasOnlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.has(key));

const isRequiredDockerServices = (services) =>
  typeof services === "object" &&
  services !== null &&
  !Array.isArray(services) &&
  Object.keys(services).length === 1 &&
  services.docker === "required";

const waitForExit = async (child) => {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        stopProcessGroup(child, "SIGKILL");
        resolve();
      }, 2_000);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
};

const VALIDATION_HEALTH_REASONS = new Set([
  "spawn-failed",
  "directory-preparation-failed",
  "readiness-timeout",
  "exited",
  "probe-failed",
  "shutdown-timeout",
  "cleanup-failed",
]);
const VALIDATION_PROBE_REASONS = new Set(["spawn-failed", "timeout", "exited"]);
const VALIDATION_PROBE_ERROR_CODES = new Set([
  "EACCES",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOEXEC",
  "ENOMEM",
  "ETXTBSY",
]);
const VALIDATION_PATH_TYPES = new Set(["missing", "directory", "other", "inaccessible"]);

const validationFailureHealth = (health) => ({
  status: "failed",
  reason: VALIDATION_HEALTH_REASONS.has(health.reason) ? health.reason : "unknown",
  code: Number.isInteger(health.code) ? health.code : null,
  signal:
    typeof health.signal === "string" && /^[A-Z0-9]{1,16}$/.test(health.signal)
      ? health.signal
      : null,
});

const validationProbe = (probe) => {
  if (probe === null) return null;
  return {
    reason: VALIDATION_PROBE_REASONS.has(probe.reason) ? probe.reason : "unknown",
    code:
      Number.isInteger(probe.code) || VALIDATION_PROBE_ERROR_CODES.has(probe.code)
        ? probe.code
        : null,
    signal:
      typeof probe.signal === "string" && /^[A-Z0-9]{1,16}$/.test(probe.signal)
        ? probe.signal
        : null,
  };
};

const validationCapabilitySet = (capabilities) => ({
  sysAdmin: typeof capabilities?.sysAdmin === "boolean" ? capabilities.sysAdmin : null,
  netAdmin: typeof capabilities?.netAdmin === "boolean" ? capabilities.netAdmin : null,
  setuid: typeof capabilities?.setuid === "boolean" ? capabilities.setuid : null,
  setgid: typeof capabilities?.setgid === "boolean" ? capabilities.setgid : null,
});

const validationPathType = (value) => (VALIDATION_PATH_TYPES.has(value) ? value : "inaccessible");

const logValidationFailure = (health, cleanup) => {
  const diagnostics = imageValidation.dockerService?.diagnostics();
  if (diagnostics === undefined) return;
  const signatures = {
    cgroupReadonly: diagnostics.signatures.cgroupReadonly === true,
    overlayDenied: diagnostics.signatures.overlayDenied === true,
    graphDriverInit: diagnostics.signatures.graphDriverInit === true,
    bridgeNetworkInit: diagnostics.signatures.bridgeNetworkInit === true,
    iptablesNetworkInit: diagnostics.signatures.iptablesNetworkInit === true,
    missingBinary: diagnostics.signatures.missingBinary === true,
    containerdTimeout: diagnostics.signatures.containerdTimeout === true,
    rootPrivilegesRequired: diagnostics.signatures.rootPrivilegesRequired === true,
    dockerSocketParentMissing: diagnostics.signatures.dockerSocketParentMissing === true,
  };
  const facts = {
    uid: Number.isInteger(diagnostics.facts.uid) ? diagnostics.facts.uid : null,
    gid: Number.isInteger(diagnostics.facts.gid) ? diagnostics.facts.gid : null,
    capabilities: {
      effective: validationCapabilitySet(diagnostics.facts.capabilities?.effective),
      available: validationCapabilitySet(diagnostics.facts.capabilities?.available),
    },
    dockerdBinaryExists: diagnostics.facts.dockerdBinaryExists === true,
    dockerCliExists: diagnostics.facts.dockerCliExists === true,
    cgroupPathExists: diagnostics.facts.cgroupPathExists === true,
    overlayModuleExists: diagnostics.facts.overlayModuleExists === true,
    dockerSocketParentType: validationPathType(diagnostics.facts.dockerSocketParentType),
    dockerDataRootType: validationPathType(diagnostics.facts.dockerDataRootType),
    dockerExecRootParentType: validationPathType(diagnostics.facts.dockerExecRootParentType),
    cgroupMountReadOnly:
      typeof diagnostics.facts.cgroupMountReadOnly === "boolean"
        ? diagnostics.facts.cgroupMountReadOnly
        : null,
    dockerDataRootMountReadOnly:
      typeof diagnostics.facts.dockerDataRootMountReadOnly === "boolean"
        ? diagnostics.facts.dockerDataRootMountReadOnly
        : null,
  };
  log(
    JSON.stringify({
      event: "docker-image-validation-failed",
      health: validationFailureHealth(health),
      probe: validationProbe(diagnostics.probe),
      signatures,
      identifiedSignature: Object.values(signatures).some(Boolean),
      facts,
      cleanup: {
        ok: cleanup.ok === true,
        forced: cleanup.forced === true,
        killed: cleanup.killed === true,
      },
    }),
  );
};

const completeDockerImageValidation = async (health) => {
  if (imageValidation.phase !== "pending" || imageValidation.dockerService === null) return;
  imageValidation.phase = "cleaning";
  let cleanup;
  try {
    cleanup = await imageValidation.dockerService.stop();
  } catch {
    cleanup = { ok: false, forced: false, killed: false };
  }
  if (health.status === "ready" && cleanup.ok === true) {
    imageValidation.phase = "passed";
    return;
  }
  const failure =
    health.status === "failed"
      ? health
      : {
          status: "failed",
          reason: cleanup.reason === "shutdown-timeout" ? "shutdown-timeout" : "cleanup-failed",
          code: cleanup.code ?? null,
          signal: cleanup.signal ?? null,
        };
  imageValidation.phase = "failed";
  logValidationFailure(failure, cleanup);
};

const startDockerImageValidation = () => {
  imageValidation.phase = "pending";
  imageValidation.dockerService = createDockerService({
    ...DOCKER_SERVICE_OPTIONS,
    onReady: () => {},
    onStateChange: (health) => {
      if (health.status === "ready" || health.status === "failed") {
        void completeDockerImageValidation(health);
      }
    },
  });
  imageValidation.dockerService.start();
};

const handleImageValidation = (res) => {
  if (!DOCKER_CAPABLE) return json(res, 200, { status: "ok", hook: "validate" });
  if (
    state.contractVersion !== null ||
    state.launchInProgress ||
    state.launchAccepted ||
    state.dockerService !== null
  ) {
    return json(res, 503, { status: "unavailable", hook: "validate" });
  }
  if (imageValidation.phase === "idle") startDockerImageValidation();
  const passed = imageValidation.phase === "passed";
  const failed = imageValidation.phase === "failed";
  return json(res, passed ? 200 : failed ? 500 : 503, {
    status: passed ? "ok" : failed ? "failed" : "pending",
    hook: "validate",
  });
};

// --------------------------------------------------------------------------------------------
// Lifecycle hooks
// --------------------------------------------------------------------------------------------

/** `sealantctl capture flush`, bounded; never throws — the hook reports what happened. */
const flushCaptures = async () => {
  const startedAt = Date.now();
  const child = spawn(SEALANTCTL, ["--socket", CONTROL_SOCKET, "capture", "flush"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.hookChildren.add(child);
  let output = "";
  const collect = (chunk) => {
    output = (output + chunk.toString("utf8")).slice(-4096);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopProcessGroup(child, "SIGKILL");
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
    state.hookChildren.delete(child);
  }
};

const handleHook = async (hook, req, res) => {
  switch (hook) {
    case "ready":
      // Nothing starts before this response. The snapshot contains no Docker process or data.
      return json(res, 200, { status: "ok", hook });
    case "validate":
      return handleImageValidation(res);
    case "run": {
      if (imageValidation.phase !== "idle") {
        throw new Error("run hook cannot enter an image-validation VM");
      }
      const raw = await readBody(req);
      const envelope = raw === "" ? {} : JSON.parse(raw);
      const payload =
        typeof envelope.runHookPayload === "string" ? JSON.parse(envelope.runHookPayload) : null;
      const commonValid =
        payload !== null &&
        typeof payload.runId === "string" &&
        payload.runId.length > 0 &&
        /^[0-9a-f]{64}$/.test(String(payload.launchSecret));
      const v1 =
        commonValid && payload.version === CONTRACT_VERSION && payload.services === undefined;
      const v2 =
        commonValid &&
        payload.version === DOCKER_CONTRACT_VERSION &&
        hasOnlyKeys(payload, new Set(["version", "runId", "launchSecret", "services"])) &&
        isRequiredDockerServices(payload.services);
      if (!v1 && !v2) {
        // A 500 here fails the VM start. A malformed control-plane payload cannot become a launch.
        throw new Error("run hook payload does not match a supported sealant agent contract");
      }
      if (v2 && !DOCKER_CAPABLE) {
        throw new Error("run hook requires a Docker-capable sealant agent image");
      }
      state.microvmId = typeof envelope.microvmId === "string" ? envelope.microvmId : null;
      state.runId = payload.runId;
      state.launchSecret = payload.launchSecret;
      state.contractVersion = payload.version;
      log(`run: microvm ${state.microvmId} run ${state.runId}`);
      return json(res, 200, { status: "ok", hook });
    }
    case "resume": {
      if (state.contractVersion !== DOCKER_CONTRACT_VERSION) {
        return json(res, 200, { status: "ok", hook, booted: state.booted });
      }
      const dockerReady = (await state.dockerService?.verify()) === true;
      const ready =
        dockerReady && state.booted && state.daemonExit === null && controlSocketReady();
      return json(res, ready ? 200 : 503, {
        status: ready ? "ok" : "unavailable",
        hook,
        booted: state.booted,
      });
    }
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

/**
 * Write launch material so no reader can ever see it half-written.
 *
 * `sealantd boot` (and anything else in the VM) opens these paths as soon as they exist, and a
 * plain write is visible to a concurrent reader a page at a time: the reader gets a prefix, not
 * the file. So write a temp file in the same directory, give it its final mode before it holds
 * any bytes, fsync it, and `rename` it over the target — rename is atomic within a filesystem,
 * so a reader sees either no file or the whole file. Creating the temp with the mode (rather than
 * chmod-ing the target afterwards) also means the secret bytes are never briefly world-readable,
 * which truncating an existing file would allow: `O_CREAT` mode does not apply to a file that is
 * already there.
 */
const writePrivate = async (file, content, mode) => {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  // "wx" is O_CREAT|O_EXCL: never adopt a leftover temp, and never inherit its mode.
  const handle = await open(temp, "wx", mode);
  try {
    await handle.writeFile(content);
    // The open mode is masked by umask; fchmod is not, so the final mode is exactly `mode`.
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  // Durability of the rename itself: best effort, since not every filesystem allows a directory
  // fsync. Atomicity does not depend on this.
  const dirHandle = await open(dir, "r").catch(() => null);
  if (dirHandle !== null) {
    await dirHandle.sync().catch(() => {});
    await dirHandle.close();
  }
};

const dockerEnvironment = {
  DOCKER_HOST: `unix://${DOCKER_SOCKET}`,
  DOCKER_CONTEXT: "",
  DOCKER_TLS_CERTDIR: "",
  DOCKER_TLS_VERIFY: "",
  DOCKER_CERT_PATH: "",
};

const startDaemon = (bootEnv) => {
  const env = { ...process.env, ...bootEnv, SEALANT_CONTROL_SOCKET: CONTROL_SOCKET };
  if (state.contractVersion === DOCKER_CONTRACT_VERSION) Object.assign(env, dockerEnvironment);
  const child = spawn(SEALANTD, ["boot"], {
    detached: true,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  state.booted = true;
  state.daemon = child;
  child.on("exit", (code, signal) => {
    state.daemonExit = { code, signal };
    log(`sealantd boot exited (code ${code}, signal ${signal})`);
  });
  child.on("error", () => {
    state.daemonExit = { code: null, signal: null };
    log("sealantd boot could not start");
  });
  log(`launch: sealantd boot started for run ${state.runId}`);
};

const V2_LAUNCH_KEYS = new Set([
  "version",
  "runId",
  "controlToken",
  "flushTimeoutMs",
  "bootEnv",
  "secretEnvJson",
  "dotfiles",
  "services",
]);
const DOTFILES_KEYS = new Set(["manifestJson", "archives"]);
const ARCHIVE_KEYS = new Set(["name", "contentBase64"]);

const launchBodyMatchesContract = (body) => {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    body.version !== state.contractVersion ||
    typeof body.runId !== "string" ||
    body.runId !== state.runId ||
    typeof body.controlToken !== "string" ||
    body.controlToken.length === 0 ||
    !Number.isInteger(body.flushTimeoutMs) ||
    body.flushTimeoutMs <= 0 ||
    typeof body.bootEnv !== "object" ||
    body.bootEnv === null ||
    Array.isArray(body.bootEnv) ||
    !Object.entries(body.bootEnv).every(
      ([key, value]) => isEnvName(key) && typeof value === "string",
    ) ||
    (body.secretEnvJson !== undefined &&
      (typeof body.secretEnvJson !== "string" || body.secretEnvJson.length === 0))
  ) {
    return false;
  }
  const servicesMatch =
    body.version === CONTRACT_VERSION
      ? body.services === undefined
      : body.version === DOCKER_CONTRACT_VERSION &&
        hasOnlyKeys(body, V2_LAUNCH_KEYS) &&
        isRequiredDockerServices(body.services);
  if (!servicesMatch) return false;
  if (body.dotfiles === undefined) return true;
  if (
    typeof body.dotfiles !== "object" ||
    body.dotfiles === null ||
    Array.isArray(body.dotfiles) ||
    typeof body.dotfiles.manifestJson !== "string" ||
    body.dotfiles.manifestJson.length === 0 ||
    !Array.isArray(body.dotfiles.archives) ||
    (body.version === DOCKER_CONTRACT_VERSION && !hasOnlyKeys(body.dotfiles, DOTFILES_KEYS))
  ) {
    return false;
  }
  return body.dotfiles.archives.every(
    (archive) =>
      typeof archive === "object" &&
      archive !== null &&
      !Array.isArray(archive) &&
      typeof archive.name === "string" &&
      /^[A-Za-z0-9._-]+$/.test(archive.name) &&
      typeof archive.contentBase64 === "string" &&
      archive.contentBase64.length > 0 &&
      (body.version !== DOCKER_CONTRACT_VERSION || hasOnlyKeys(archive, ARCHIVE_KEYS)),
  );
};

const DOCKER_SERVICE_ENV = new Set([
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_CERTDIR",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
]);

const v2SecretEnvIsSafe = (raw) => {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  return !Object.keys(parsed).some((key) => DOCKER_SERVICE_ENV.has(key));
};

const handleLaunch = async (req, res) => {
  if (state.launchInProgress || state.launchAccepted) {
    return json(res, 409, { message: "already booted" });
  }
  if (state.launchSecret === null) {
    return message(res, 503, "the run hook has not delivered a launch secret yet");
  }
  if (!bearerMatches(req.headers.authorization, state.launchSecret)) {
    return message(res, 401, "launch secret does not match this VM's run");
  }
  const body = JSON.parse((await readBody(req)) || "{}");
  if (!launchBodyMatchesContract(body)) {
    return message(res, 400, "launch request does not match the sealant agent contract");
  }

  const secretEnvJson = body.secretEnvJson;
  if (body.version === DOCKER_CONTRACT_VERSION && typeof secretEnvJson === "string") {
    let safe = false;
    try {
      safe = v2SecretEnvIsSafe(secretEnvJson);
    } catch {
      // The response deliberately does not include JSON parser output or launch material.
    }
    if (!safe) {
      return message(
        res,
        400,
        "launch request secret environment contains a Docker service-owned key",
      );
    }
  }

  // Reading and validating the body yields to concurrent requests. Claim the launch only after
  // that work, then re-check atomically before the first filesystem write.
  if (state.launchInProgress || state.launchAccepted) {
    return json(res, 409, { message: "already booted" });
  }
  if (!bearerMatches(req.headers.authorization, state.launchSecret)) {
    return message(res, 401, "launch secret does not match this VM's run");
  }
  state.launchInProgress = true;
  const bootEnv = { ...body.bootEnv };
  try {
    if (typeof secretEnvJson === "string") {
      await writePrivate(SECRET_ENV_FILE, secretEnvJson, 0o600);
      bootEnv.SEALANT_SECRET_ENV_FILE = SECRET_ENV_FILE;
    } else {
      delete bootEnv.SEALANT_SECRET_ENV_FILE;
    }
    if (body.dotfiles === undefined) {
      delete bootEnv.SEALANT_DOTFILES_ARCHIVE_DIR;
    } else {
      await writePrivate(
        path.join(DOTFILES_DIR, "manifest.json"),
        body.dotfiles.manifestJson,
        0o644,
      );
      for (const archive of body.dotfiles.archives) {
        await writePrivate(
          path.join(DOTFILES_DIR, archive.name),
          Buffer.from(archive.contentBase64, "base64"),
          0o644,
        );
      }
      bootEnv.SEALANT_DOTFILES_ARCHIVE_DIR = DOTFILES_DIR;
    }
  } catch (error) {
    state.launchInProgress = false;
    throw error;
  }

  // Material is durable and the launch is now claimed. Retries cannot start a second child.
  state.controlToken = body.controlToken;
  state.flushTimeoutMs = body.flushTimeoutMs;
  state.launchSecret = null;
  state.launchAccepted = true;
  state.launchInProgress = false;

  if (body.version === DOCKER_CONTRACT_VERSION) {
    const dockerBootEnv = { ...bootEnv, ...dockerEnvironment };
    state.dockerService = createDockerService({
      ...DOCKER_SERVICE_OPTIONS,
      onReady: () => startDaemon(dockerBootEnv),
      onStateChange: (dockerHealth) => log(`docker: ${dockerHealth.status}`),
    });
    state.dockerService.start();
  } else {
    startDaemon(bootEnv);
  }
  return json(res, 200, { outcome: "booting" });
};

const controlSocketReady = () => existsSync(CONTROL_SOCKET);

const handleHealth = (req, res) => {
  if (!bearerMatches(req.headers.authorization, state.controlToken)) {
    return message(res, 401, "control token does not match");
  }
  const common = {
    booted: state.booted,
    controlSocket: controlSocketReady(),
    ...(state.daemonExit === null
      ? {}
      : { daemonExit: { code: state.daemonExit.code, signal: state.daemonExit.signal } }),
  };
  if (state.contractVersion !== DOCKER_CONTRACT_VERSION) {
    const healthy = state.booted && common.controlSocket && state.daemonExit === null;
    return json(res, healthy ? 200 : 503, common);
  }
  const docker = state.dockerService?.health() ?? { status: "starting" };
  const body = { version: DOCKER_CONTRACT_VERSION, ...common, services: { docker } };
  const healthy =
    docker.status === "ready" && state.booted && common.controlSocket && state.daemonExit === null;
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
  if (
    !state.booted ||
    !controlSocketReady() ||
    (state.contractVersion === DOCKER_CONTRACT_VERSION && !state.dockerService?.isReady())
  ) {
    return refuse(503, "workspace control is not ready");
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
    if (res.headersSent) {
      res.end();
    } else {
      message(res, 500, "request failed");
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

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: stopping`);
  server.close();
  server.closeAllConnections?.();
  for (const child of state.hookChildren) stopProcessGroup(child);
  stopProcessGroup(state.daemon);
  await Promise.all([
    imageValidation.dockerService?.stop(),
    state.dockerService?.stop(),
    waitForExit(state.daemon),
    ...[...state.hookChildren].map(waitForExit),
  ]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : PORT;
  log(`listening on :${port}`);
});
