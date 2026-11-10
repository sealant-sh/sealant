#!/usr/bin/env node
// The Sealant MicroVM agent: PID 1 of every workspace image the MicroVM image builder makes
// (`src/images/microvm/`), which copies this file in on top of the blueprint's own recipe.
//
// It mirrors the typed contract in `src/runtime/microvm/agent-contract.ts` by hand (this file
// runs inside an AWS Lambda MicroVM with nothing but Node's standard library) and exists for
// three reasons the platform imposes:
//
//   1. Lifecycle hooks. Lambda POSTs `/aws/lambda-microvms/runtime/v1/<hook>` to the image's
//      hook port: `ready`/`validate` at image build, `run` when a VM starts (with the RunMicrovm
//      payload), `resume`, and `suspend`/`terminate` before the VM is checkpointed or ends. The
//      last two run `sealantctl capture flush` — on terminate a FINAL flush (`--final`) whenever
//      the daemon's sealantctl offers it, answered 200 only when the daemon reports it
//      `complete`. What bounds that flush is sealantd, not this agent: the daemon bounds every
//      `capture.flush` on its own and returns whatever the queue holds. The flush timeout the
//      launch delivers (`flushTimeoutMs`, 50 s by default) is only this agent's kill switch for
//      a sealantctl that hangs; it does NOT buy the flush more time. So the hook cannot promise
//      an empty queue — the control plane drains BEFORE it terminates a VM, and this hook is the
//      last net. (The platform's own hook timeout is at most 60 s; what it does when a hook
//      overruns or answers 500 is undocumented.)
//   2. Launch material. RunMicrovm takes no environment and no secrets, so the control plane
//      pushes boot env, the secret env file and dotfiles to `POST /sealant/launch` over the VM's
//      authenticated endpoint, and only then does `sealantd boot` start. The push is authorised
//      by the one-launch secret from the run-hook payload.
//   3. Control reach. sealantd's own WebSocket frontend is mutual-TLS only and the endpoint
//      proxy terminates TLS, so `GET /sealant/control` relays a plaintext WebSocket to the
//      daemon's Unix control socket. Authorised by the deployment's control token, which
//      arrived inside the launch push.
//   4. Recovery. A capture VM whose sealantd exited (75: its final flush did not complete) while
//      the VM runs on still holds its staging on the VM's disk, until the platform's cap ends
//      the VM. `POST /sealant/recover` (control token) stops the guest Docker service and kills
//      every process on the VM this agent did not start itself (sealantd is not PID 1 here: its
//      writers outlive it; what the agent started is recorded by pid and start time, never
//      recognised by name), then starts `sealantd boot --recovery` on that disk (resume its own staging, no restore, no dotfiles, no lifecycle
//      step, no harness, nothing admitted), with the first boot's environment and its secret env
//      file holding the capture token, so the control plane can drain it before the cap.
//      On Boat an agent restarted on the same boot adopts the launch (`adoptBootLaunch`): the
//      daemon runs on in a systemd scope of its own, and park and recover reach it through
//      systemd, proving it gone before anything is certified or started.
//
// One listener serves all three; the image registers the same port for hooks and the endpoint
// targets it by default.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import {
  createDockerService,
  stopGuestProcessGroup as stopProcessGroup,
  sweepDockerCgroups,
} from "./docker-service.mjs";

const CONTRACT_VERSION = 1;
const DOCKER_CONTRACT_VERSION = 2;
const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1";
const LAUNCH_ROUTE = "/sealant/launch";
const HEALTH_ROUTE = "/sealant/health";
const CONTROL_ROUTE = "/sealant/control";
/** Boat: the resource tunnel's WebSocket carrier (one WireGuard datagram per binary frame). */
const TUNNEL_ROUTE = "/sealant/tunnel";
/** A carrier that cannot take more is dropping datagrams, as UDP would: never buffering them. */
const TUNNEL_BACKLOG_BYTES = 1024 * 1024;
/** The largest datagram the carrier relays (`boat-host.mjs` drops anything larger). */
const MAX_TUNNEL_DATAGRAM_BYTES = 65_535;
const RECOVER_ROUTE = "/sealant/recover";
const RECOVER_CONTRACT_VERSION = 1;
// Boat host mode only (`src/runtime/boat/agent-contract.ts`).
const PARK_ROUTE = "/sealant/park";
/** What an unexpected failure of a Boat route answers (500): a reason Core can classify. */
const BOAT_ROUTE_FAILURES = new Map([
  ["/sealant/launch", "launch-failed"],
  ["/sealant/recover", "recover-failed"],
  ["/sealant/park", "park-failed"],
  ["/sealant/network", "network-setup-failed"],
]);
const NETWORK_ROUTE = "/sealant/network";

/**
 * The host this agent runs on: `lambda` (the AWS Lambda MicroVM runtime: lifecycle hooks, the
 * run payload's launch secret, sealantd beside the agent) or `boat` (the VM is the workspace:
 * no hooks, a bind exchange leaves the bearer on tmpfs, sealantd is PID 1 of its own PID
 * namespace, launch and park are durable records). Everything Boat-only lives in
 * `boat-host.mjs`; this file asks it at a few seams.
 */
const HOST = process.env.SEALANT_AGENT_HOST === "boat" ? "boat" : "lambda";
const BOAT = HOST === "boat";

const PORT = Number(process.env.SEALANT_MICROVM_AGENT_PORT ?? 8080);
const CONTROL_SOCKET = process.env.SEALANT_CONTROL_SOCKET ?? "/run/sealant/control.sock";
// Where launch material is written; overridable so the agent can be tested outside a VM.
const STATE_DIR = process.env.SEALANT_MICROVM_AGENT_STATE_DIR ?? "/run/sealant";
const SECRET_ENV_FILE = path.join(STATE_DIR, "secrets", "env.json");
// The processes this agent started that sealantd's final sweep must spare (`SEALANT_SWEEP_EXEMPT_FILE`
// in sealantd's environment). sealantd is not PID 1 on a MicroVM, so it sweeps the whole VM for
// writers and spares only what is listed here — each by pid AND start time, never by name.
const SWEEP_EXEMPT_FILE = path.join(STATE_DIR, "sweep-exempt.json");
const SWEEP_EXEMPT_VERSION = 1;
// How long a recovery waits for the processes the dead daemon left to be gone after SIGKILL.
const LEFTOVER_KILL_TIMEOUT_MS = 5_000;
// sealantd's recovery boot exits 76 (EXIT_NOTHING_TO_SAVE) when the executor never materialized a
// capture: nothing ran on it, so there is nothing to save. The recovery route waits this long for
// the boot to settle (its control socket, or that exit) so it can say which.
const EXIT_NOTHING_TO_SAVE = 76;
const RECOVERY_SETTLE_MS = Number(process.env.SEALANT_MICROVM_RECOVERY_SETTLE_MS ?? 15_000);
const DOTFILES_DIR = path.join(STATE_DIR, "dotfiles");
const SEALANTD = process.env.SEALANT_MICROVM_SEALANTD ?? "/usr/local/bin/sealantd";
const SEALANTCTL = process.env.SEALANT_MICROVM_SEALANTCTL ?? "sealantctl";
const DOCKER_CAPABLE = process.env.SEALANT_MICROVM_DOCKER_CAPABLE === "1";
// sealantd's `capture.flush {kind: final}` (`sealantctl capture flush --final`): quiesce every
// writer, snapshot both classes, ship, and report `complete`. The terminate hook asks for it
// whenever the daemon's sealantctl offers it (a capability probe: `capture flush --help` lists
// `--final`), so no image has to opt in. `SEALANT_MICROVM_FINAL_FLUSH=1` forces it on, `0` off;
// unset probes. A terminate that cannot run a final flush answers 500: nothing confirms saved.
const FINAL_FLUSH_MODE =
  process.env.SEALANT_MICROVM_FINAL_FLUSH === "1"
    ? "on"
    : process.env.SEALANT_MICROVM_FINAL_FLUSH === "0"
      ? "off"
      : "probe";
const FINAL_FLUSH_PROBE_TIMEOUT_MS = 5_000;
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
// Optional dockerd networking and socket sharing (`--bip`, `--default-address-pool` for each
// `base=…,size=…` entry separated by `;`, `--group`); unset, dockerd gets exactly today's args.
const DOCKER_BIP = process.env.SEALANT_MICROVM_DOCKER_BIP;
const DOCKER_ADDRESS_POOLS = (process.env.SEALANT_MICROVM_DOCKER_ADDRESS_POOLS ?? "")
  .split(";")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");
const DOCKER_GROUP = process.env.SEALANT_MICROVM_DOCKER_GROUP;
// Boat proves Docker stopped before a park or recovery certifies anything, so its defaults turn
// that on: every container gets a 10 s stop grace, then the containers' cgroup
// (`--cgroup-parent`, under systemd's driver) and the engine's own cgroup (dockerd, containerd
// and the shims, which run in process groups of their own) are killed and must be empty. Only
// where the cgroup filesystem is mounted can change (tests). Lambda keeps dockerd as it was.
const CGROUP_ROOT = process.env.SEALANT_MICROVM_CGROUP_ROOT ?? "/sys/fs/cgroup";
const DOCKER_CGROUP_PARENT =
  process.env.SEALANT_MICROVM_DOCKER_CGROUP_PARENT ?? (BOAT ? "sealant-docker.slice" : undefined);
const DOCKER_ENGINE_CGROUP =
  process.env.SEALANT_MICROVM_DOCKER_ENGINE_CGROUP ??
  (BOAT ? path.join(CGROUP_ROOT, "sealant-docker-engine") : undefined);
const DOCKER_CONTAINER_STOP_SECONDS =
  process.env.SEALANT_MICROVM_DOCKER_CONTAINER_STOP_SECONDS ?? (BOAT ? "10" : undefined);
const DOCKER_SERVICE_OPTIONS = {
  bridgeIp: DOCKER_BIP,
  addressPools: DOCKER_ADDRESS_POOLS,
  group: DOCKER_GROUP,
  cgroupParent: DOCKER_CGROUP_PARENT,
  cgroupRoot: CGROUP_ROOT,
  systemctlPath: process.env.SEALANT_AGENT_SYSTEMCTL,
  containerStopSeconds: DOCKER_CONTAINER_STOP_SECONDS,
  engineCgroupPath: DOCKER_ENGINE_CGROUP,
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
  // Boat: the bundle's own containerd, never a base image's (whose PATH would find this bundle's
  // newer shim), and readiness runs a real container. Lambda's image has no other containerd.
  ...(BOAT
    ? {
        containerdPath: process.env.SEALANT_MICROVM_CONTAINERD ?? "/usr/local/bin/containerd",
        shimPath:
          process.env.SEALANT_MICROVM_CONTAINERD_SHIM ?? "/usr/local/bin/containerd-shim-runc-v2",
        containerProbeInitPath:
          process.env.SEALANT_MICROVM_DOCKER_INIT ?? "/usr/local/bin/docker-init",
      }
    : {}),
};
const MAX_BODY_BYTES = 64 * 1024 * 1024;
// The tail of sealantd's own output that health reports once the daemon has exited, so a failed
// boot says why without the VM console. Each stream is kept apart: stdout and stderr are two
// pipes, and the order the agent reads them in is not the order they were written. The kept window
// is in bytes and the report in UTF-16 characters, and one character can take three bytes, so four
// bytes are kept per reported character: whatever the text, the window's first 1365 characters or
// more are never reported, and a secret cut at its edge is not reported in part.
const DAEMON_OUTPUT_TAIL_CHARS = 4096;
const DAEMON_OUTPUT_KEEP_BYTES = 4 * DAEMON_OUTPUT_TAIL_CHARS;
// The daemon's last lines can still be in its pipes when it exits. Wait this long for them, and
// no longer: a child that inherited the pipes can hold them open after sealantd is gone.
const DAEMON_OUTPUT_DRAIN_MS = 500;
// Secret values shorter than this are not redacted: replacing every "1" or "on" in the output
// would destroy it, and a value that short is not a credential.
const MIN_REDACTED_LENGTH = 8;
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
  /** The boot env the launch started sealantd with; a recovery boot starts from it. */
  bootEnv: null,
  /**
   * Boat: this process adopted a launch an earlier agent process accepted on this boot. It holds
   * no daemon child then: the daemon lives in its scope (`sealant-workspace-*.scope`), outside the
   * agent's cgroup, and is observed through systemd until a recovery starts one here.
   */
  adopted: false,
  /** sealantd was started again in recovery mode (no harness, so no guest service is needed). */
  recovery: false,
  recoveryInProgress: false,
  flushTimeoutMs: 50_000,
  /** The launch boots a capture source (`SEALANT_WORKSPACE_SOURCE=capture`): hooks flush it. */
  captureSourced: false,
  booted: false,
  daemon: null,
  /**
   * Set the moment sealantd exits. `daemonExit` (what health reports) follows once its output
   * has drained, but nothing may count the daemon as up in between.
   */
  daemonExited: false,
  daemonExit: null,
  /** The last DAEMON_OUTPUT_KEEP_BYTES of each of sealantd's stdout and stderr. */
  daemonOutput: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
  /** Launch values that never leave the VM in reported output: the control token, secret env. */
  redactions: [],
  dockerService: null,
  hookChildren: new Set(),
  /**
   * Every process this agent started and that still runs: pid → role (`sealantctl`, `dockerd`,
   * `docker-probe`, `sealantd`) and its start time (`/proc/<pid>/stat` field 22, clock ticks
   * since boot). Ownership is this record — a pid the agent spawned, still carrying the start
   * time it had then — and nothing else: a process named `docker` that the agent never started
   * is a user process like any other.
   */
  helpers: new Map(),
};

const log = (line) => {
  console.log(`${new Date().toISOString()} agent: ${line}`);
};

// Loaded on Boat only: a Lambda image ships agent.mjs and docker-service.mjs, nothing else
// (`MICROVM_AGENT_FILES`), and must start without the Boat module.
const boatHost = BOAT
  ? (await import("./boat-host.mjs")).createBoatHost({ log, dockerCapable: DOCKER_CAPABLE })
  : null;
// Boat: a rebooted or restored VM still has the resolver the last boot's tunnel left; the VM's
// own comes back before anything on it needs DNS. Never fatal: Core configures the network anew.
if (boatHost !== null) {
  try {
    await boatHost.restoreResolvConf();
  } catch (error) {
    log(`network: the VM's own resolver could not be restored: ${error.message}`);
  }
}

/**
 * Boat: arm the agent from the bind the CLI left, if it has no bearer yet. The bearer is both
 * the launch secret and the control token, so every authenticated route calls this first. A
 * no-op on Lambda (the run hook delivers the launch secret, the launch the control token).
 */
const arm = () => {
  boatHost?.arm(state, DOCKER_CAPABLE ? DOCKER_CONTRACT_VERSION : CONTRACT_VERSION);
};

/** A process's start time (`/proc/<pid>/stat` field 22), or `null` when it cannot be read. */
const processStartTime = (pid) => {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    // The command name is in parentheses and may hold spaces: the fields follow the last one.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
};

/**
 * What sealantd's final sweep spares, written for it (`SWEEP_EXEMPT_FILE`, atomically): this
 * agent, and every helper it started that still runs, each by pid and start time. `sealantd`
 * itself is not listed (it spares itself). A dockerd is spared, its descendants are not: they
 * are the workspace's containers, writers like any other when the executor ends.
 */
const writeSweepExemptFile = () => {
  const exempt = [
    {
      pid: process.pid,
      startTime: processStartTime(process.pid),
      role: "agent",
      descendants: false,
    },
    ...[...state.helpers.entries()]
      .filter(([, helper]) => helper.role !== "sealantd" && helper.startTime !== null)
      .map(([pid, helper]) => ({
        pid,
        startTime: helper.startTime,
        role: helper.role,
        descendants: helper.descendants,
      })),
  ];
  try {
    const temp = `${SWEEP_EXEMPT_FILE}.${String(process.pid)}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: SWEEP_EXEMPT_VERSION, exempt })}\n`, {
      mode: 0o600,
    });
    renameSync(temp, SWEEP_EXEMPT_FILE);
  } catch (error) {
    log(`sweep exempt list could not be written: ${error.message}`);
  }
};

/**
 * Record a process this agent started (its pid and start time) until it exits. `descendants`:
 * its children are spared with it (when their ancestry through live processes reaches it). No
 * helper sets it today: whatever runs under a helper — even under the agent's own sealantctl, the
 * control peer — is swept like any other writer (decision 4: no control-peer exemption).
 */
const trackHelper = (child, role, { descendants = false } = {}) => {
  const pid = child.pid;
  if (pid === undefined) return;
  state.helpers.set(pid, { role, startTime: processStartTime(pid), descendants });
  child.once("exit", () => {
    if (state.helpers.get(pid)?.role === role) state.helpers.delete(pid);
    writeSweepExemptFile();
  });
  writeSweepExemptFile();
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
    onSpawn: (child, role) => trackHelper(child, role),
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

/**
 * Whether the daemon's sealantctl offers `capture flush --final` (its help lists the flag). Asked
 * once per agent and remembered; a probe that fails, or whose output does not list it, is `false`.
 */
let finalFlushProbe;
const finalFlushSupported = () => {
  if (FINAL_FLUSH_MODE === "on") return Promise.resolve(true);
  if (FINAL_FLUSH_MODE === "off") return Promise.resolve(false);
  finalFlushProbe ??= (async () => {
    try {
      const help = await new Promise((resolve, reject) => {
        const child = spawn(SEALANTCTL, ["capture", "flush", "--help"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        trackHelper(child, "sealantctl");
        let output = "";
        const collect = (chunk) => {
          output = (output + chunk.toString("utf8")).slice(-16384);
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        // A probe that hangs is killed; its close then answers with whatever it printed.
        const timer = setTimeout(() => child.kill("SIGKILL"), FINAL_FLUSH_PROBE_TIMEOUT_MS);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", () => {
          clearTimeout(timer);
          resolve(output);
        });
      });
      return /(^|\s|\[)--final\b/m.test(help);
    } catch {
      return false;
    }
  })();
  return finalFlushProbe;
};

/**
 * `sealantctl capture flush`, bounded; never throws — the hook reports what happened. sealantd
 * returns within its shutdown grace (10 s) on its own; `state.flushTimeoutMs` only kills a
 * sealantctl that hangs. `kind` is the hook's intent: `final` (terminate) adds `--final` when the
 * daemon offers it (`finalFlushSupported`); without it a terminate flush cannot be confirmed and
 * is reported failed.
 */
const flushCaptures = async (kind) => {
  const startedAt = Date.now();
  const final = kind === "final" && (await finalFlushSupported());
  const args = ["--socket", CONTROL_SOCKET, "capture", "flush", ...(final ? ["--final"] : [])];
  const child = spawn(SEALANTCTL, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackHelper(child, "sealantctl");
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
    // What the daemon said about completeness, when its report carries it (the agreed FINAL
    // semantics: `complete` is true only after quiescing, snapshotting both classes and
    // registering everything). Absent from every released sealantd: `null`, unknown.
    const reported = /"complete"\s*:\s*(true|false)/.exec(output);
    const complete = reported === null ? null : reported[1] === "true";
    return {
      // A terminate flush is ok only when it ran as a final flush and the daemon confirmed it
      // complete (a daemon without `--final` cannot confirm anything); any flush is failed when
      // it exited non-zero, timed out, or the daemon reported it incomplete.
      ok:
        code === 0 &&
        !timedOut &&
        complete !== false &&
        (kind !== "final" || (final && complete === true)),
      ...(kind === "final" ? { final: final ? "requested" : "unsupported" } : {}),
      exitCode: code,
      signal,
      timedOut,
      complete,
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
      const ready = dockerReady && state.booted && !state.daemonExited && controlSocketReady();
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
      if (!state.captureSourced) {
        // Nothing on this VM is captured: there is nothing for a flush to save.
        return json(res, 200, { status: "ok", hook, flush: "not-capture" });
      }
      const flush = await flushCaptures(hook === "terminate" ? "final" : "suspend");
      log(`${hook}: capture flush ${flush.ok ? "ok" : "FAILED"} ${JSON.stringify(flush)}`);
      // A failed flush is never answered 200: the platform (and anyone reading the hook's
      // record) must see that this VM's work was not saved. What the platform does on a non-200
      // suspend/terminate is undocumented — it may end the VM anyway; this hook is the last
      // resort, the control plane drains before the deadline — but the answer is the truth.
      return json(res, flush.ok ? 200 : 500, { status: flush.ok ? "ok" : "failed", hook, flush });
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

/** Secret-looking launch values to redact from reported output, longest first. */
const redactionsFor = (controlToken, secretEnvJson) => {
  const values = [controlToken];
  if (typeof secretEnvJson === "string") {
    try {
      const parsed = JSON.parse(secretEnvJson);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        values.push(...Object.values(parsed).filter((value) => typeof value === "string"));
      }
    } catch {
      // Not an object: there is nothing to name, and the launch itself decides what that means.
    }
  }
  return (
    [...new Set(values)]
      .filter((value) => value.length >= MIN_REDACTED_LENGTH)
      // A fresh array, and the agent runs on the image's own Node, which may predate toSorted.
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort((a, b) => b.length - a.length)
  );
};

const keepDaemonOutput = (stream, chunk) => {
  const joined = Buffer.concat([state.daemonOutput[stream], chunk]);
  state.daemonOutput[stream] =
    joined.length > DAEMON_OUTPUT_KEEP_BYTES
      ? joined.subarray(joined.length - DAEMON_OUTPUT_KEEP_BYTES)
      : joined;
};

/** Newlines and tabs stay; other control characters (colour codes, carriage returns) do not. */
const isReportable = (character) => {
  const code = character.codePointAt(0) ?? 0;
  return code === 9 || code === 10 || (code >= 32 && code !== 127);
};

/** One kept stream as it can be reported: redacted, printable, trimmed. */
const reportableStream = (stream) => {
  let text = state.daemonOutput[stream].toString("utf8");
  for (const secret of state.redactions) {
    text = text.split(secret).join("[redacted]");
  }
  return Array.from(text).filter(isReportable).join("").trim();
};

/**
 * The output health reports, at most DAEMON_OUTPUT_TAIL_CHARS: the end of stdout, then the end
 * of stderr. stderr (where a boot error is written) has first claim on the room; stdout gets the
 * rest.
 */
const reportedDaemonOutput = () => {
  const stderr = reportableStream("stderr").slice(-DAEMON_OUTPUT_TAIL_CHARS);
  const room = DAEMON_OUTPUT_TAIL_CHARS - stderr.length - (stderr === "" ? 0 : 1);
  const stdout = room > 0 ? reportableStream("stdout").slice(-room) : "";
  return [stdout, stderr]
    .filter((part) => part !== "")
    .join("\n")
    .trim();
};

const startDaemon = (bootEnv, args = ["boot"]) => {
  const env = {
    ...process.env,
    ...bootEnv,
    SEALANT_CONTROL_SOCKET: CONTROL_SOCKET,
    // On Lambda sealantd is not PID 1: its final sweep covers the whole VM and spares exactly
    // what this list names (this agent and its own helpers, by pid and start time). On Boat it
    // IS PID 1 of its own PID namespace and sweeps exactly that; a VM-wide sweep would kill
    // systemd and Boat's own services, so no exempt list is named.
    ...(BOAT ? {} : { SEALANT_SWEEP_EXEMPT_FILE: SWEEP_EXEMPT_FILE }),
  };
  if (args.includes("--recovery")) {
    // A recovery boot runs after the guest Docker service was stopped (and, on Boat, proved
    // gone): it has no workspace Docker. Naming the endpoint anyway would make sealantd count the
    // daemon it cannot reach as a writer still there, so its final flush would never complete.
    for (const key of [...Object.keys(dockerEnvironment), "SEALANT_WORKSPACE_DOCKER_HOST"]) {
      delete env[key];
    }
  } else if (state.contractVersion === DOCKER_CONTRACT_VERSION) {
    Object.assign(env, dockerEnvironment);
  }
  writeSweepExemptFile();
  const command = boatHost === null ? [SEALANTD, ...args] : boatHost.daemonCommand(SEALANTD, args);
  const child = spawn(command[0], command.slice(1), {
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackHelper(child, "sealantd");
  state.booted = true;
  state.daemon = child;
  // The console (the VM's log group) still receives every byte; the agent keeps a tail as well.
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    keepDaemonOutput("stdout", chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    keepDaemonOutput("stderr", chunk);
  });
  child.on("exit", (code, signal) => {
    // A recovery starts another daemon: only the current one's exit is reported.
    if (state.daemon !== child) return;
    state.daemonExited = true;
    const settle = () => {
      if (state.daemon !== child || state.daemonExit !== null) return;
      state.daemonExit = { code, signal };
      log(`sealantd boot exited (code ${code}, signal ${signal})`);
    };
    child.once("close", settle);
    // A busy loop can reach this timer before it has read what is already in the pipes; one
    // more turn (setImmediate runs after the poll phase) reads that first.
    setTimeout(() => setImmediate(settle), DAEMON_OUTPUT_DRAIN_MS).unref();
  });
  child.on("error", () => {
    if (state.daemon !== child) return;
    state.daemonExited = true;
    state.daemonExit = { code: null, signal: null };
    log("sealantd boot could not start");
  });
  const recovery = args.includes("--recovery");
  log(
    `${recovery ? "recover" : "launch"}: sealantd boot started for run ${state.runId}${recovery ? " in recovery mode" : ""}`,
  );
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
    body.runId.trim().length === 0 ||
    // Lambda learns the run from the run hook; Boat from the first valid launch body.
    body.runId !== (state.runId ?? body.runId) ||
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
  arm();
  if (boatHost?.isParked() === true) return json(res, 409, { reason: "parked" });
  if (state.launchInProgress || state.launchAccepted) {
    return json(res, 409, { message: "already booted" });
  }
  // Boat: a launch accepted on this boot by an earlier agent process is still the launch (adopt
  // semantics), even though this process holds no daemon.
  if (boatHost?.launchAccepted() === true) {
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
    !launchBodyMatchesContract(body) ||
    // Boat: the bearer is the control token too; the push must name it, not another.
    (BOAT && !bearerMatches(`Bearer ${String(body.controlToken)}`, state.launchSecret))
  ) {
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
  // A park that began while this body was read has closed the boot: nothing may start now.
  if (boatHost?.isParked() === true) return json(res, 409, { reason: "parked" });
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
    // Boat: the run is the first valid launch body's, and the launch is durable BEFORE anything
    // starts: an agent restarted on this boot must know it was accepted, and (from the tmpfs
    // launch environment, written just before) what to recover from. Last of the writes, so a
    // push whose material failed to persist leaves no record and can be retried.
    if (boatHost !== null) {
      state.runId = body.runId;
      await boatHost.recordLaunchEnv({
        runId: body.runId,
        contractVersion: body.version,
        captureSourced: body.bootEnv.SEALANT_WORKSPACE_SOURCE === "capture",
        flushTimeoutMs: body.flushTimeoutMs,
        bootEnv:
          body.version === DOCKER_CONTRACT_VERSION ? { ...bootEnv, ...dockerEnvironment } : bootEnv,
      });
      await boatHost.recordLaunch(body.runId);
    }
  } catch (error) {
    state.launchInProgress = false;
    // Boat: a run adopted by a push that failed to persist is not this VM's run.
    if (boatHost !== null && !boatHost.launchAccepted()) state.runId = null;
    throw error;
  }

  // Material is durable and the launch is now claimed. Retries cannot start a second child.
  state.controlToken = body.controlToken;
  state.redactions = redactionsFor(body.controlToken, secretEnvJson);
  state.flushTimeoutMs = body.flushTimeoutMs;
  state.captureSourced = body.bootEnv.SEALANT_WORKSPACE_SOURCE === "capture";
  state.launchSecret = null;
  state.launchAccepted = true;
  state.launchInProgress = false;

  state.bootEnv = { ...bootEnv };
  if (body.version === DOCKER_CONTRACT_VERSION) {
    const dockerBootEnv = { ...bootEnv, ...dockerEnvironment };
    state.dockerService = createDockerService({
      ...DOCKER_SERVICE_OPTIONS,
      onSpawn: (child, role) => trackHelper(child, role),
      onReady: () => {
        boatHost?.markDockerReady();
        startDaemon(dockerBootEnv);
      },
      onStateChange: (dockerHealth) => {
        if (dockerHealth.status !== "ready") boatHost?.markDockerStopped();
        // The engine it is (which containerd, which socket, which versions) goes in the journal on
        // every start, not only with a failure.
        const engine = state.dockerService?.engine();
        log(
          `docker: ${dockerHealth.status}${dockerHealth.status === "failed" ? ` (${dockerHealth.reason})` : ""}${typeof engine === "string" ? `; ${engine.replaceAll("\n", "; ")}` : ""}`,
        );
      },
    });
    state.dockerService.start();
  } else {
    startDaemon(bootEnv);
  }
  return json(res, 200, { outcome: "booting" });
};

/**
 * Boat: the Docker an earlier agent process started on this boot, which no service here holds:
 * dockerd lives on in the engine's cgroup and its containers in their slice when the agent is
 * restarted. Its Docker image's launch was adopted, so the same cgroups the service would sweep
 * are killed and proved empty. `true` only when they were.
 */
const sweepAdoptedDocker = () =>
  state.adopted && state.contractVersion === DOCKER_CONTRACT_VERSION
    ? sweepDockerCgroups(DOCKER_SERVICE_OPTIONS)
    : Promise.resolve(true);

/**
 * Boat: stop the guest Docker service for a park: `absent` when none was ever started, `stopped`
 * only when the service proved nothing of Docker still runs (containers given their stop grace,
 * then dockerd, then its cgroup and any engine process killed), `unverified` otherwise. After an
 * adopt the service is not held: the Docker cgroups are swept and proved empty by the same rules.
 */
const stopDockerForPark = async () => {
  boatHost?.markDockerStopped();
  if (state.dockerService === null && imageValidation.dockerService === null) {
    if (!state.adopted || state.contractVersion !== DOCKER_CONTRACT_VERSION) return "absent";
    return (await sweepAdoptedDocker()) ? "stopped" : "unverified";
  }
  const stopped = await Promise.all(
    [imageValidation.dockerService, state.dockerService]
      .filter((service) => service !== null)
      .map((service) => service.stop()),
  );
  return stopped.every((result) => result.verified === true) ? "stopped" : "unverified";
};

/** Boat: SIGKILL the daemon's process group (the namespace dies with its init) and wait. */
const killDaemonGroup = async () => {
  const daemon = state.daemon;
  if (daemon === null) return;
  stopProcessGroup(daemon, "SIGKILL");
  await waitForExit(daemon);
};

/**
 * Boat: stop every daemon on this boot for a park or recovery: the child this process holds (if
 * any), then every live `sealant-workspace-*` scope (the daemon an earlier agent process started
 * runs in one, outside this unit's cgroup), each proved gone. `stopped` only when proved; nothing
 * held and no scope live is proved too.
 */
const stopDaemonForClose = async () => {
  await killDaemonGroup();
  return (await boatHost.killDaemonScopes()) ? "stopped" : "unverified";
};

/**
 * Boat, after an adopt: what became of the daemon this process never held, from its scope.
 * `live` while a `sealant-workspace-*` scope is active, `gone` once none is (the daemon exited;
 * its code is unknown here, so health reports `{code: null, signal: null}`), `unknown` when
 * systemd could not say. `held` when this process holds a daemon of its own (a recovery boot) or
 * adopted nothing. `scopes`: a listing made just now, when the caller has one.
 */
const observeAdoptedDaemon = async (scopes) => {
  if (!state.adopted || state.daemon !== null) return "held";
  if (state.daemonExited) return "gone";
  const live = scopes === undefined ? await boatHost.liveDaemonScopes() : scopes;
  if (live === null) return "unknown";
  if (live.length > 0) return "live";
  state.daemonExited = true;
  state.daemonExit = { code: null, signal: null };
  log("the daemon an earlier agent process started has exited: its scope is gone");
  return "gone";
};

/**
 * `POST /sealant/park` (Boat): close the workspace for parking — kill sealantd's namespace, stop
 * Docker, `sync`, write a receipt — once per operation. Afterwards no launch or recovery is
 * accepted on this boot. Authorised by the control token.
 */
const handlePark = async (req, res) => {
  arm();
  if (!bearerMatches(req.headers.authorization, state.controlToken)) {
    return message(res, 401, "control token does not match");
  }
  const body = JSON.parse((await readBody(req)) || "{}");
  // A launch writing its material is not closed by killing a daemon it has not started yet: park
  // refuses (typed, retryable) until the launch has settled, never certifying closure over it.
  if (state.launchInProgress) return json(res, 409, { reason: "launch-in-progress" });
  const result = await boatHost.park(body, {
    runId: state.runId,
    stopDaemon: stopDaemonForClose,
    stopDocker: stopDockerForPark,
  });
  return json(res, result.status, result.body);
};

/** `POST|GET /sealant/network` (Boat): configure the tunnel to the gateway, or measure it. */
const handleNetwork = async (req, res) => {
  arm();
  if (!bearerMatches(req.headers.authorization, state.controlToken)) {
    return message(res, 401, "control token does not match");
  }
  if (req.method === "GET") return json(res, 200, await boatHost.networkStatus());
  const body = JSON.parse((await readBody(req)) || "{}");
  const result = await boatHost.configureNetwork(body);
  return json(res, result.status, result.body);
};

/** The recovery request carries only the capture token for the recovery boot's secret env. */
const recoverySecretEnvIsValid = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      typeof parsed.SEALANT_CAPTURE_TOKEN === "string" &&
      parsed.SEALANT_CAPTURE_TOKEN.length > 0
    );
  } catch {
    return false;
  }
};

/** Every process in the VM: pid → parent, process group, session, state and argv[0]. */
const readProcessTable = async () => {
  const names = await readdir("/proc").catch(() => null);
  if (names === null) return null;
  const table = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await readFile(`/proc/${name}/stat`, "utf8").catch(() => null);
    if (stat === null) continue;
    // The command name is in parentheses and may hold spaces: the fields follow the last one.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cmdline = await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "");
    table.set(Number(name), {
      state: fields[0],
      ppid: Number(fields[1]),
      pgrp: Number(fields[2]),
      sid: Number(fields[3]),
      startTime: fields[19] ?? null,
      argv0: cmdline.split("\0")[0] ?? "",
    });
  }
  return table;
};

/**
 * The processes a recovery spares: this agent, and the helpers it started that still run AS
 * THEY WERE STARTED (the pid carries the start time it had then; a pid the kernel handed to
 * another process since is not the helper), with — for a helper whose children are its own —
 * those children whose every ancestor up to it is alive. `roles` narrows the helpers spared.
 * Never by name: a user process whose argv[0] is `docker` or `sealantctl` is not a helper.
 */
const sparedProcesses = (table, roles) => {
  const spared = new Set([process.pid]);
  const helpers = new Map();
  for (const [pid, helper] of state.helpers) {
    if (!roles.has(helper.role)) continue;
    const entry = table.get(pid);
    if (entry === undefined || helper.startTime === null || entry.startTime !== helper.startTime) {
      continue;
    }
    spared.add(pid);
    if (helper.descendants) helpers.set(pid, entry.startTime);
  }
  if (helpers.size === 0) return spared;
  for (const [pid, entry] of table) {
    let at = entry;
    // Bounded: a table read while processes come and go can hold a cycle.
    for (let hops = 0; at !== undefined && hops <= table.size; hops += 1) {
      const root = helpers.get(at.ppid);
      if (root !== undefined) {
        // A descendant starts after its ancestor; an older process is a reused pid's.
        if (Number(entry.startTime) >= Number(root)) spared.add(pid);
        break;
      }
      at = table.get(at.ppid);
    }
  }
  return spared;
};

/**
 * The processes the dead daemon left: its process group and session (it was started detached),
 * and — the agent being PID 1, every orphan is re-parented to it — every descendant of the agent
 * that this agent did not start itself (`sparedProcesses`). Zombies are not counted: they hold
 * no files and write nothing.
 */
const daemonLeftovers = (table, daemonPid, spared) => {
  const children = new Map();
  for (const [pid, entry] of table) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(pid);
    children.set(entry.ppid, siblings);
  }
  const subtree = (root) => {
    const out = new Set();
    const stack = [root];
    while (stack.length > 0) {
      const pid = stack.pop();
      if (out.has(pid)) continue;
      out.add(pid);
      stack.push(...(children.get(pid) ?? []));
    }
    return out;
  };
  // A live process with the dead daemon's pid means its group and session are gone and the
  // number was reused (the kernel never hands out a pid still in use as a group or session id):
  // nothing matches it then.
  const groupAlive = daemonPid !== undefined && !table.has(daemonPid);
  const leftovers = new Set();
  for (const [pid, entry] of table) {
    if (spared.has(pid) || entry.state === "Z") continue;
    if (groupAlive && (entry.pgrp === daemonPid || entry.sid === daemonPid)) {
      leftovers.add(pid);
    }
  }
  for (const pid of subtree(process.pid)) {
    if (!spared.has(pid) && table.get(pid)?.state !== "Z") leftovers.add(pid);
  }
  return leftovers;
};

/**
 * What a recovery spares: only the agent's own `sealantctl` itself (a terminate or suspend hook's
 * flush may be in flight), never what runs under it. Docker is stopped before a recovery (its containers are the workspace's
 * writers, and a recovery boot runs no user code), so neither dockerd nor its probes are spared.
 */
const RECOVERY_SPARED_ROLES = new Set(["sealantctl"]);

/**
 * Kill every process the dead daemon left, and wait until none remains: on a MicroVM sealantd is
 * not PID 1, so its managed processes (the harness, anything it started) outlive it and would go
 * on writing beside the recovery. `true` once none remains.
 */
const killDaemonLeftovers = async (daemonPid) => {
  const deadline = Date.now() + LEFTOVER_KILL_TIMEOUT_MS;
  for (;;) {
    const table = await readProcessTable();
    if (table === null) {
      // No process table to read: nothing can prove every other process is gone, so nothing
      // is started. The daemon's process group is still killed.
      if (daemonPid !== undefined) {
        try {
          process.kill(-daemonPid, "SIGKILL");
        } catch {
          // Gone already.
        }
      }
      return false;
    } else {
      const leftovers = daemonLeftovers(
        table,
        daemonPid,
        sparedProcesses(table, RECOVERY_SPARED_ROLES),
      );
      if (leftovers.size === 0) return true;
      for (const pid of leftovers) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone already.
        }
      }
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** The first boot's secret env with the capture token the control plane kept for the recovery. */
const recoverySecretEnvJson = async (requestJson) => {
  const kept = await readFile(SECRET_ENV_FILE, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => ({}));
  const base = typeof kept === "object" && kept !== null && !Array.isArray(kept) ? kept : {};
  return JSON.stringify({ ...base, ...JSON.parse(requestJson) });
};

/**
 * Start sealantd again ON THIS VM'S DISK in recovery mode, after it exited (sealantd exits 75
 * when its final flush did not complete, keeping its staging here):
 *
 *  1. the guest Docker service is stopped (its containers are the workspace's writers), then
 *     every other process on the VM is killed except this agent and the `sealantctl` it started
 *     itself (recorded by pid and start time when it spawned them; never recognised by name), and
 *     none may remain (else 503: nothing is started beside a writer; an unreadable process table
 *     proves nothing and is a 503 too);
 *  2. `sealantd boot --recovery` starts with the first boot's environment; its secret env file
 *     stays the first boot's (`SEALANT_SECRET_ENV_FILE`), holding the capture token the control
 *     plane kept for this. It runs no dotfiles, no lifecycle step and no harness, admits nothing,
 *     resumes its own staging without materializing over it, and ships when the control plane
 *     drains it. It exits 0 once its final flush is complete and sealed, and 75 for anything else
 *     (another daemon holds the disk, or the disk is not the head's continuation — a disk an older
 *     daemon materialized is refused, and kept).
 */
const handleRecover = async (req, res) => {
  arm();
  // Boat: the bearer of this VM's earlier boot. Typed, so Core never reads it as nothing-to-save.
  if (
    state.controlToken === null &&
    boatHost?.staleBootBearer(req.headers.authorization) === true
  ) {
    return json(res, 409, { reason: "recover-new-boot" });
  }
  if (!bearerMatches(req.headers.authorization, state.controlToken)) {
    return message(res, 401, "control token does not match");
  }
  if (boatHost?.isParked() === true) return json(res, 409, { reason: "parked" });
  const body = JSON.parse((await readBody(req)) || "{}");
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !hasOnlyKeys(body, new Set(["version", "runId", "secretEnvJson"])) ||
    body.version !== RECOVER_CONTRACT_VERSION ||
    typeof body.runId !== "string" ||
    // Boat decides a run mismatch from the launch record (a typed refusal, below).
    (!BOAT && body.runId !== state.runId) ||
    typeof body.secretEnvJson !== "string" ||
    !recoverySecretEnvIsValid(body.secretEnvJson)
  ) {
    return message(res, 400, "recovery request does not match the sealant agent contract");
  }
  // Boat: the daemon scopes live on this boot, from systemd (`null`: it could not say).
  const scopes = boatHost === null ? [] : await boatHost.liveDaemonScopes();
  if (boatHost !== null) {
    // The records decide what this agent may say. Never `nothing-to-save` when unsure.
    const decision = boatHost.recoverDecision({
      runId: body.runId,
      agentLaunched: state.launchAccepted && state.bootEnv !== null,
      // Whatever this process knows that the records may not say yet (a launch writing its
      // material) or no longer say (a record removed under a running daemon), and whatever
      // systemd shows running on this boot that this process did not start.
      agentActive:
        state.launchInProgress ||
        state.launchAccepted ||
        state.daemon !== null ||
        scopes === null ||
        scopes.length > 0,
    });
    if (decision.kind === "refuse") return json(res, 409, { reason: decision.reason });
    if (decision.kind === "nothing-to-save") {
      return json(res, 200, { outcome: "nothing-to-save", basis: "no-launch" });
    }
  }
  if (!state.launchAccepted || state.bootEnv === null) {
    return message(res, 409, "this VM was never launched");
  }
  if (!state.captureSourced) {
    return message(res, 400, "recovery applies to a capture-sourced workspace only");
  }
  if (state.recoveryInProgress) {
    return message(res, 409, "a recovery is already starting");
  }
  // Boat, after an adopt: the daemon is known through its scope, never guessed.
  if ((await observeAdoptedDaemon(scopes)) === "unknown") {
    return json(res, 409, { reason: "recover-state-unknown" });
  }
  if (!state.daemonExited) {
    return json(res, 200, { outcome: "running" });
  }
  // A park that completed while this body was read closed the boot: never restart under it.
  if (boatHost?.isParked() === true) return json(res, 409, { reason: "parked" });
  state.recoveryInProgress = true;
  try {
    // Docker goes first: its containers are the workspace's writers (a recovery boot runs no
    // user code and needs no guest service), and a dockerd left running would start them again.
    boatHost?.markDockerStopped();
    const docker = await state.dockerService?.stop();
    // Boat proves Docker gone (a forced dockerd stop leaves containerd's shims and containers);
    // after an adopt no service is held, and the Docker cgroups are swept and proved by the same
    // rules.
    if (
      BOAT &&
      ((docker !== undefined && docker.verified !== true) ||
        (docker === undefined && !(await sweepAdoptedDocker())))
    ) {
      log("recover: the guest Docker service could not be proved stopped; nothing started");
      return json(res, 503, { reason: "docker-stop-unverified" });
    }
    if (docker !== undefined && docker.ok === false && docker.killed !== true) {
      log("recover: the guest Docker service did not stop; nothing started");
      return message(res, 503, "the guest Docker service did not stop");
    }
    // On Boat sealantd was PID 1 of its own namespace: killing the wrapper's group ends it all,
    // and every daemon scope on the boot is killed and proved gone before another starts.
    if (BOAT) {
      if ((await stopDaemonForClose()) !== "stopped") {
        log("recover: a daemon scope could not be proved gone; nothing started");
        return json(res, 503, { reason: "daemon-stop-unverified" });
      }
    } else if (!(await killDaemonLeftovers(state.daemon?.pid))) {
      log("recover: processes the ended sealantd left are still running; nothing started");
      return message(res, 503, "processes the ended daemon left are still running");
    }
    const secretEnvJson = await recoverySecretEnvJson(body.secretEnvJson);
    await writePrivate(SECRET_ENV_FILE, secretEnvJson, 0o600);
    // The ended daemon's socket file may still be there; nothing may count it as ready.
    await unlink(CONTROL_SOCKET).catch(() => {});
    const env = { ...state.bootEnv, SEALANT_SECRET_ENV_FILE: SECRET_ENV_FILE };
    delete env.SEALANT_DOTFILES_ARCHIVE_DIR;
    state.redactions = redactionsFor(state.controlToken, secretEnvJson);
    state.recovery = true;
    state.daemonExited = false;
    state.daemonExit = null;
    state.daemonOutput = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    startDaemon(env, ["boot", "--recovery"]);
    // Wait for the boot to settle: it answers on its control socket, or it exits. Exit 76 is the
    // daemon's word that there is nothing to save (it never materialized); it is reported as such
    // and nothing else is. Any other exit, or a boot still starting, answers `restarted` and the
    // control plane reads the daemon's health as before.
    const settleBy = Date.now() + RECOVERY_SETTLE_MS;
    while (Date.now() < settleBy && !controlSocketReady() && state.daemonExit === null) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (state.daemonExit !== null && state.daemonExit.code === EXIT_NOTHING_TO_SAVE) {
      const report = daemonExitReport();
      const line = /sealantd boot: nothing to save[^\n]*/.exec(report.output ?? "")?.[0];
      log(`recover: sealantd found nothing to save (${line ?? "exit 76"})`);
      return json(res, 200, {
        outcome: "nothing-to-save",
        ...(BOAT ? { basis: "daemon" } : {}),
        detail: line ?? "sealantd boot: nothing to save (exit 76)",
      });
    }
    return json(res, 200, { outcome: "restarted" });
  } finally {
    state.recoveryInProgress = false;
  }
};

const controlSocketReady = () => existsSync(CONTROL_SOCKET);

const daemonExitReport = () => {
  const output = reportedDaemonOutput();
  return {
    code: state.daemonExit.code,
    signal: state.daemonExit.signal,
    ...(output === "" ? {} : { output }),
  };
};

const handleHealth = async (req, res) => {
  arm();
  if (!bearerMatches(req.headers.authorization, state.controlToken)) {
    return message(res, 401, "control token does not match");
  }
  // Boat, after an adopt: the daemon is reported from its scope (not exited while one is live;
  // exited, code unknown, once none is), never from a child this process does not hold.
  await observeAdoptedDaemon();
  const common = {
    booted: state.booted,
    controlSocket: controlSocketReady(),
    ...(state.daemonExit === null ? {} : { daemonExit: daemonExitReport() }),
  };
  if (state.contractVersion !== DOCKER_CONTRACT_VERSION) {
    const healthy = state.booted && common.controlSocket && !state.daemonExited;
    return json(res, healthy ? 200 : 503, common);
  }
  const docker = state.dockerService?.health() ?? { status: "starting" };
  const body = { version: DOCKER_CONTRACT_VERSION, ...common, services: { docker } };
  // A recovery boot runs no harness: it needs no guest service to be ready.
  const healthy =
    (docker.status === "ready" || state.recovery) &&
    state.booted &&
    common.controlSocket &&
    !state.daemonExited;
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
    frames.push({ opcode, payload, fin: (first & 0x80) !== 0 });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
};

const handleControlUpgrade = (req, socket, head) => {
  // A refusal is ended, not destroyed, after its write: destroy() would drop a response the
  // kernel has not taken yet, and the client would read a reset instead of the reason.
  const answer = (response) => {
    socket.end(response);
    setTimeout(() => socket.destroy(), 1_000).unref();
  };
  const refuse = (status, text) =>
    answer(
      `HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
    );
  // Control is not reachable yet (no daemon, no socket, Docker not ready, or the socket refused
  // the connection): a 503 whose body names the reason, before any 101 is sent.
  const unavailable = () => {
    const body = JSON.stringify({ error: "control-unavailable" });
    answer(
      `HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  };
  arm();
  if (!bearerMatches(req.headers.authorization, state.controlToken)) {
    return refuse(401, "control token does not match");
  }
  if (
    !state.booted ||
    !controlSocketReady() ||
    (state.contractVersion === DOCKER_CONTRACT_VERSION &&
      !state.recovery &&
      !state.dockerService?.isReady())
  ) {
    return unavailable();
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
    return refuse(400, "not a websocket upgrade");
  }
  const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  // Echo the first offered subprotocol (if the proxy forwards any) so strict clients accept.
  const offered = req.headers["sec-websocket-protocol"];
  const protocol = typeof offered === "string" ? offered.split(",")[0]?.trim() : undefined;

  // The daemon's socket is connected FIRST; only a connection that succeeded is answered 101.
  const daemon = net.connect(CONTROL_SOCKET);
  daemon.once("error", (error) => {
    if (!socket.destroyed && socket.writable && !upgraded) {
      log(`control: socket connect failed: ${error.message}`);
      unavailable();
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

/**
 * Boat: `/sealant/tunnel`, the resource tunnel's carrier. Core opens it through Boat's hosted HTTPS
 * with the control token and relays it to the gateway on its own host, so neither the VM nor the
 * gateway's host takes an inbound connection. Each binary frame is one WireGuard datagram, either
 * way; anything else but ping and close ends it. One carrier at a time: a newer one replaces this.
 */
const handleTunnelUpgrade = (req, socket, head) => {
  const refuse = (status, text) => {
    socket.end(
      `HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
    );
    setTimeout(() => socket.destroy(), 1_000).unref();
  };
  arm();
  if (!bearerMatches(req.headers.authorization, state.controlToken)) {
    return refuse(401, "control token does not match");
  }
  const relay = boatHost.tunnelRelay();
  if (relay === null) return refuse(409, "tunnel-not-carried");
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
    return refuse(400, "not a websocket upgrade");
  }
  const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "upgrade: websocket",
      "connection: Upgrade",
      `sec-websocket-accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.setNoDelay(true);
  const carrier = relay.attach({
    send: (datagram) => {
      if (socket.writableLength > TUNNEL_BACKLOG_BYTES) return;
      socket.write(encodeFrame(0x2, datagram));
    },
    // 1012 (service restart): a newer carrier took over.
    replaced: () => socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xf4]))),
  });
  log("tunnel: carrier attached");
  let pending = Buffer.alloc(0);
  // A proxy may split a message into fragments (a binary frame without FIN, continuations up to
  // the one with it): they are one datagram, put back together. Control frames may come between.
  let fragments = null;
  const close = (code) => socket.end(encodeFrame(0x8, Buffer.from([code >> 8, code & 0xff])));
  const onData = (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let parsed;
    try {
      parsed = parseFrames(pending);
    } catch {
      socket.destroy();
      return;
    }
    pending = parsed.rest;
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x9) {
        socket.write(encodeFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x2 && fragments === null) {
        if (frame.fin) carrier.deliver(frame.payload);
        else fragments = [frame.payload];
        continue;
      }
      if (frame.opcode === 0x0 && fragments !== null) {
        fragments.push(frame.payload);
        const size = fragments.reduce((total, part) => total + part.length, 0);
        // 1009 (message too big): no datagram is this large.
        if (size > MAX_TUNNEL_DATAGRAM_BYTES) return close(1009);
        if (frame.fin) {
          carrier.deliver(Buffer.concat(fragments));
          fragments = null;
        }
        continue;
      }
      // A close, text, or a fragment out of order: not something the carrier speaks.
      return close(1000);
    }
  };
  if (head.length > 0) onData(head);
  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    carrier.detach();
    log("tunnel: carrier detached");
  });
};

// --------------------------------------------------------------------------------------------
// Server
// --------------------------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const respond = async () => {
    // Lambda's lifecycle hooks: nothing on Boat POSTs them, and nothing may act as if it did.
    if (!BOAT && req.method === "POST" && url.startsWith(`${HOOK_PREFIX}/`)) {
      return handleHook(url.slice(HOOK_PREFIX.length + 1), req, res);
    }
    if (req.method === "POST" && url === LAUNCH_ROUTE) {
      return handleLaunch(req, res);
    }
    if (req.method === "GET" && url === HEALTH_ROUTE) {
      return handleHealth(req, res);
    }
    if (req.method === "POST" && url === RECOVER_ROUTE) {
      return handleRecover(req, res);
    }
    if (BOAT && req.method === "POST" && url === PARK_ROUTE) {
      return handlePark(req, res);
    }
    if (BOAT && (req.method === "POST" || req.method === "GET") && url === NETWORK_ROUTE) {
      return handleNetwork(req, res);
    }
    if (url === CONTROL_ROUTE || (BOAT && url === TUNNEL_ROUTE)) {
      return message(res, 426, "this route only speaks WebSocket");
    }
    return message(res, 404, "unknown route");
  };
  respond().catch((error) => {
    log(`${req.method} ${url}: ${error.message}`);
    if (res.headersSent) {
      res.end();
    } else if (BOAT && BOAT_ROUTE_FAILURES.has(url)) {
      // Boat: a typed reason Core's diagnostic keeps, never the error's text.
      json(res, 500, { reason: BOAT_ROUTE_FAILURES.get(url) });
    } else {
      message(res, 500, "request failed");
    }
  });
});

server.on("upgrade", (req, socket, head) => {
  if (BOAT && req.url === TUNNEL_ROUTE) {
    handleTunnelUpgrade(req, socket, head);
    return;
  }
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

/**
 * Boat: adopt the launch an earlier agent process accepted on this boot, from the durable launch
 * record and the tmpfs launch environment (`boat-host.mjs`). This process then knows the run, the
 * contract, and the boot env a recovery starts from, and reports the daemon from its scope; it
 * holds no child. A launch record without the environment (or another boot's) adopts nothing:
 * the launch stays accepted (`409 already booted`), and a recovery is `recover-state-unknown`.
 */
const adoptBootLaunch = () => {
  if (boatHost === null) return;
  const adopted = boatHost.adoptLaunch();
  if (adopted === null) return;
  state.adopted = true;
  state.runId = adopted.runId;
  state.contractVersion = adopted.contractVersion;
  state.bootEnv = adopted.bootEnv;
  state.captureSourced = adopted.captureSourced;
  state.flushTimeoutMs = adopted.flushTimeoutMs;
  state.launchAccepted = true;
  state.booted = true;
  arm();
  let secretEnvJson;
  try {
    secretEnvJson = readFileSync(SECRET_ENV_FILE, "utf8");
  } catch {
    // No secret env on tmpfs: nothing of it to redact.
  }
  state.redactions = redactionsFor(state.controlToken ?? "", secretEnvJson);
  log(`adopted the launch of run ${state.runId} (contract ${String(state.contractVersion)})`);
};
adoptBootLaunch();

server.listen(PORT, "0.0.0.0", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : PORT;
  log(`listening on :${port}`);
});
