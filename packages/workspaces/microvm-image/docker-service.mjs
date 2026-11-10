import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chownSync,
  closeSync,
  existsSync,
  chmodSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const DOCKER_SOCKET = "/run/docker/docker.sock";
/** The Docker client endpoint passed explicitly to every readiness probe. */
export const DOCKER_HOST = `unix://${DOCKER_SOCKET}`;

const DOCKER_DATA_ROOT = "/var/lib/sealant/docker";
const DOCKER_EXEC_ROOT = "/run/sealant/docker-exec";
const DOCKER_PID_FILE = "/run/sealant/docker.pid";
const RUNTIME_PROBE_FAILURE_LIMIT = 3;
const SAFE_SPAWN_ERROR_CODES = new Set([
  "EACCES",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOEXEC",
  "ENOMEM",
  "ETXTBSY",
]);
const DOCKER_ENV_KEYS = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_CERTDIR",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
];

/**
 * Whether a cgroup can be proved empty. A cgroup that cannot be read, including one that is not
 * where it was resolved to be, is never taken for empty: what cannot be seen is not proved gone.
 */
export const provedEmpty = (cgroup) => {
  try {
    return /^populated 0$/m.test(readFileSync(path.join(cgroup, "cgroup.events"), "utf8"));
  } catch {
    return false;
  }
};

/**
 * Where systemd put a unit's cgroup, under the cgroup filesystem's mount point: asked of systemd
 * (`systemctl show --property ControlGroup --value`), never assumed, since a slice nests by name
 * (`sealant-docker.slice` is `/sealant.slice/sealant-docker.slice`). Throws when systemd does not
 * name one (a unit that is not loaded, or no systemd to ask).
 */
export const unitControlGroup = (unit, { systemctlPath = "systemctl", cgroupRoot }) => {
  const control = execFileSync(
    systemctlPath,
    ["show", "--property", "ControlGroup", "--value", unit],
    { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (!control.startsWith("/") || control.includes("..")) {
    throw new Error("systemd did not name the unit's cgroup");
  }
  return path.join(cgroupRoot, control);
};

/**
 * Kill what is in each cgroup (`cgroup.kill`) until every one is proved empty, or `timeoutMs`
 * passes: `true` only when all were. Nothing outside them is touched.
 */
export const killCgroupsUntilEmpty = async (cgroups, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const occupied = cgroups.filter((cgroup) => !provedEmpty(cgroup));
    if (occupied.length === 0) return true;
    if (Date.now() >= deadline) return false;
    for (const cgroup of occupied) {
      try {
        writeFileSync(path.join(cgroup, "cgroup.kill"), "1");
      } catch {
        // A kernel without cgroup.kill (before 5.14): the cgroup cannot be emptied, and the
        // deadline answers that it was not.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const nonEmpty = (value) => (typeof value === "string" && value !== "" ? value : null);

/**
 * The cgroups the service's Docker lives in, resolved as the service resolves them at start: the
 * engine's (made if missing, as the service makes it before dockerd joins it) and the containers'
 * slice (started so it exists, then located from systemd). Throws when the slice cannot be
 * located; `null` for a cgroup the options do not name.
 */
const dockerCgroups = (options) => {
  const cgroupParent = nonEmpty(options.cgroupParent);
  const cgroupRoot = nonEmpty(options.cgroupRoot) ?? "/sys/fs/cgroup";
  const systemctlPath = nonEmpty(options.systemctlPath) ?? "systemctl";
  const engineCgroupPath = nonEmpty(options.engineCgroupPath);
  if (engineCgroupPath !== null) mkdirSync(engineCgroupPath, { recursive: true });
  let containerCgroupPath = null;
  if (cgroupParent !== null) {
    if (!cgroupParent.endsWith(".slice")) {
      containerCgroupPath = path.join(cgroupRoot, cgroupParent);
    } else {
      execFileSync(systemctlPath, ["start", cgroupParent], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      containerCgroupPath = unitControlGroup(cgroupParent, { systemctlPath, cgroupRoot });
    }
  }
  return { engineCgroupPath, containerCgroupPath };
};

/**
 * Kill whatever of Docker runs in the cgroups the options name and prove them empty, without a
 * service holding dockerd: what an agent restarted on the same boot owes a park or recovery, since
 * the dockerd an earlier agent process started lives on in the engine's cgroup, and its containers
 * in theirs. `true` only when both were proved empty; a slice that cannot be located proves
 * nothing.
 */
export const sweepDockerCgroups = async (options) => {
  let cgroups;
  try {
    cgroups = dockerCgroups(options);
  } catch {
    return false;
  }
  return killCgroupsUntilEmpty(
    [cgroups.engineCgroupPath, cgroups.containerCgroupPath].filter((cgroup) => cgroup !== null),
  );
};

/** Where a system containerd listens: dockerd adopts it, unless it is told which one to use. */
const SYSTEM_CONTAINERD_SOCKET = "/run/containerd/containerd.sock";
/** The probe image the container check imports: one static file, no registry. */
const PROBE_IMAGE = "sealant-engine-probe:1";
const PROBE_TIMEOUT_MS = 60_000;
const ENGINE_OUTPUT_MAX_CHARS = 2_048;

/** A tar header field: octal digits, NUL-terminated, to its width. */
const octal = (value, length) => `${value.toString(8).padStart(length - 1, "0")}\0`;

/** A POSIX tar holding one regular file, as `docker import` reads it: no tar binary needed. */
export const singleFileTar = (name, content, mode = 0o755) => {
  const header = Buffer.alloc(512, 0);
  const field = (offset, length, value) => header.write(value, offset, length, "ascii");
  field(0, 100, name);
  field(100, 8, octal(mode, 8));
  field(108, 8, octal(0, 8));
  field(116, 8, octal(0, 8));
  field(124, 12, octal(content.length, 12));
  field(136, 12, octal(0, 12));
  field(148, 8, "        ");
  field(156, 1, "0");
  field(257, 6, "ustar\0");
  field(263, 2, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, padding, Buffer.alloc(1024, 0)]);
};

/** Run a program to completion, bounded: its exit code and the end of its output. Never throws. */
const runBounded = async (command, args, { env, input, timeoutMs, onSpawn, role }) => {
  let child;
  try {
    child = spawn(command, args, { detached: true, env, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return { code: null, output: "" };
  }
  onSpawn?.(child, role);
  let output = "";
  const keep = (chunk) => {
    output = (output + chunk.toString("utf8")).slice(-ENGINE_OUTPUT_MAX_CHARS);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const killTimer = setTimeout(() => stopGuestProcessGroup(child, "SIGKILL"), timeoutMs);
  killTimer.unref();
  try {
    const [code] = await once(child, "close");
    return { code, output };
  } catch {
    return { code: null, output };
  } finally {
    clearTimeout(killTimer);
  }
};

/** The first line a binary prints for its version, or why it could not say. */
const versionOf = async (binary, args, env) => {
  const { code, output } = await runBounded(binary, args, { env, timeoutMs: 5_000 });
  const line =
    output
      .split("\n")
      .find((entry) => entry.trim() !== "")
      ?.trim() ?? "";
  return code === 0 && line !== "" ? line.slice(0, 200) : `unknown (exit ${String(code)})`;
};

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const serviceEnvironment = () => {
  const env = { ...process.env };
  for (const key of DOCKER_ENV_KEYS) delete env[key];
  return env;
};

/** Stop a detached guest child and every process that remains in its process group. */
export const stopGuestProcessGroup = (child, signal = "SIGTERM") => {
  if (
    child === null ||
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
};

// Called synchronously from the exit callback. The group id cannot be retained for later use:
// once the group is empty the kernel may reuse its numeric id for an unrelated process.
const killDescendantsAfterLeaderExit = (leaderPid) => {
  if (leaderPid === undefined) return;
  try {
    process.kill(-leaderPid, "SIGKILL");
  } catch {
    // ESRCH means the process group disappeared with its leader.
  }
};

const openBoundedLog = (file, maxBytes) => {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const descriptor = openSync(file, "w", 0o600);
    fchmodSync(descriptor, 0o600);
    let written = 0;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        closeSync(descriptor);
      } catch {
        // Diagnostics must never change service lifecycle behavior.
      }
    };
    return {
      write: (chunk) => {
        if (closed || written >= maxBytes) return;
        const remaining = maxBytes - written;
        const bounded = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        try {
          written += writeSync(descriptor, bounded);
        } catch {
          close();
        }
      },
      close,
    };
  } catch {
    return { write: () => {}, close: () => {} };
  }
};

const safeSpawnErrorCode = (error) =>
  typeof error?.code === "string" && SAFE_SPAWN_ERROR_CODES.has(error.code) ? error.code : null;

const mountReadOnly = (target) => {
  try {
    const mounts = readFileSync("/proc/self/mountinfo", "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" "))
      .filter(
        (fields) =>
          fields.length > 6 &&
          (fields[4] === "/" || target === fields[4] || target.startsWith(`${fields[4]}/`)),
      )
      .toSorted((left, right) => (right[4]?.length ?? 0) - (left[4]?.length ?? 0));
    const fields = mounts[0];
    if (fields === undefined) return null;
    return fields[5]?.split(",").includes("ro") ?? null;
  } catch {
    return null;
  }
};

const capabilitySet = (hex) => {
  const bits = BigInt(`0x${hex}`);
  const has = (capability) => (bits & (1n << BigInt(capability))) !== 0n;
  return {
    sysAdmin: has(21),
    netAdmin: has(12),
    setuid: has(7),
    setgid: has(6),
  };
};

const requiredCapabilityFacts = () => {
  const unavailable = {
    effective: { sysAdmin: null, netAdmin: null, setuid: null, setgid: null },
    available: { sysAdmin: null, netAdmin: null, setuid: null, setgid: null },
  };
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const effective = /^CapEff:\s*([0-9a-f]+)$/im.exec(status)?.[1];
    const available = /^CapBnd:\s*([0-9a-f]+)$/im.exec(status)?.[1];
    if (effective === undefined || available === undefined) return unavailable;
    return { effective: capabilitySet(effective), available: capabilitySet(available) };
  } catch {
    return unavailable;
  }
};

const pathType = (target) => {
  try {
    return lstatSync(target).isDirectory() ? "directory" : "other";
  } catch (error) {
    return error?.code === "ENOENT" ? "missing" : "inaccessible";
  }
};

const ensurePrivateDirectory = (target) => {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (!lstatSync(target).isDirectory()) throw new Error("Docker runtime path is not a directory");
  chmodSync(target, 0o700);
};

/**
 * The socket's directory when dockerd is told a `--group`: root-owned, the group's, 0750, so the
 * group's members reach the socket (dockerd makes the socket itself 0660 root:group).
 */
const ensureGroupDirectory = (target, gid) => {
  mkdirSync(target, { recursive: true, mode: 0o750 });
  if (!lstatSync(target).isDirectory()) throw new Error("Docker runtime path is not a directory");
  chownSync(target, -1, gid);
  chmodSync(target, 0o750);
};

/**
 * The numeric id of a group, from `/etc/group` (then `getent group`, for a group another name
 * service holds); a numeric name is that id. `null` when nothing names it.
 */
const resolveGroupId = (group) => {
  if (/^\d+$/.test(group)) return Number(group);
  const entry = (line) => {
    const fields = line.split(":");
    return fields[0] === group && /^\d+$/.test(fields[2] ?? "") ? Number(fields[2]) : null;
  };
  try {
    for (const line of readFileSync("/etc/group", "utf8").split("\n")) {
      const gid = entry(line);
      if (gid !== null) return gid;
    }
  } catch {
    // No /etc/group to read: getent is the next source.
  }
  try {
    const output = execFileSync("getent", ["group", group], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).toString("utf8");
    for (const line of output.split("\n")) {
      const gid = entry(line);
      if (gid !== null) return gid;
    }
  } catch {
    // Unknown group.
  }
  return null;
};

const createSignatureTracker = (socketPath) => {
  const signatures = {
    cgroupReadonly: false,
    overlayDenied: false,
    graphDriverInit: false,
    bridgeNetworkInit: false,
    iptablesNetworkInit: false,
    missingBinary: false,
    containerdTimeout: false,
    rootPrivilegesRequired: false,
    dockerSocketParentMissing: false,
  };
  let tail = "";
  return {
    observe: (chunk) => {
      tail = `${tail}${chunk.toString("utf8")}`.slice(-16 * 1024);
      signatures.cgroupReadonly ||=
        tail.includes("/sys/fs/cgroup") && tail.includes("read-only file system");
      signatures.overlayDenied ||= tail.includes(
        "failed to mount overlay: operation not permitted",
      );
      signatures.graphDriverInit ||= tail.includes("error initializing graphdriver:");
      signatures.bridgeNetworkInit ||=
        tail.includes("Error initializing network controller:") &&
        tail.includes('failed to register "bridge" driver');
      signatures.iptablesNetworkInit ||=
        tail.includes("failed to create NAT chain DOCKER") && tail.includes("iptables failed");
      signatures.containerdTimeout ||=
        tail.includes("failed to start containerd: timeout waiting for containerd to start") ||
        tail.includes("failed to start containerd: context deadline exceeded");
      signatures.rootPrivilegesRequired ||= tail.includes(
        "needs to be started with root privileges",
      );
      signatures.dockerSocketParentMissing ||=
        tail.includes(socketPath) && tail.includes("no such file or directory");
    },
    markMissingBinary: () => {
      signatures.missingBinary = true;
    },
    snapshot: () => ({ ...signatures }),
  };
};

/**
 * Owns the guest dockerd process, readiness probes, runtime probes, and their shutdown.
 * The service never uses launch-provided environment or a shell.
 */
export const createDockerService = (options) => {
  const dockerdPath = options.dockerdPath;
  const dockerPath = options.dockerPath;
  const socketPath = options.socketPath ?? DOCKER_SOCKET;
  const dockerHost = `unix://${socketPath}`;
  const dataRoot = options.dataRoot ?? DOCKER_DATA_ROOT;
  const execRoot = options.execRoot ?? DOCKER_EXEC_ROOT;
  const pidFile = options.pidFile ?? DOCKER_PID_FILE;
  // Optional networking and socket-sharing arguments; unset, dockerd gets exactly the arguments
  // it always had.
  const bridgeIp =
    typeof options.bridgeIp === "string" && options.bridgeIp !== "" ? options.bridgeIp : null;
  const addressPools = Array.isArray(options.addressPools)
    ? options.addressPools.filter((pool) => typeof pool === "string" && pool !== "")
    : [];
  const group = typeof options.group === "string" && options.group !== "" ? options.group : null;
  // Optional: the cgroup every container is put under, and its path in the cgroup filesystem,
  // so a stop can kill and then prove empty what dockerd's own process group does not hold
  // (containerd's shims run in their own groups). A slice name selects systemd's driver.
  const cgroupParent = nonEmpty(options.cgroupParent);
  // Where the cgroup filesystem is mounted, and how to ask systemd where it put a slice: a slice
  // nests by its name (`sealant-docker.slice` is `/sealant.slice/sealant-docker.slice`), so its
  // path is resolved from systemd at start, never assumed.
  const cgroupRoot = nonEmpty(options.cgroupRoot) ?? "/sys/fs/cgroup";
  const systemctlPath = nonEmpty(options.systemctlPath) ?? "systemctl";
  let cgroupPath = null;
  // Optional: the cgroup dockerd starts in, so containerd and its shims (each in a process group
  // of its own) are in it too and can be killed and proved gone as one, and nothing else is.
  const engineCgroupPath = nonEmpty(options.engineCgroupPath);
  // Optional: stop every container (`docker stop -t N`) before dockerd itself is signalled.
  const containerStopSeconds =
    Number.isInteger(Number(options.containerStopSeconds)) &&
    Number(options.containerStopSeconds) > 0
      ? Number(options.containerStopSeconds)
      : null;
  const verifiesStop = cgroupParent !== null || engineCgroupPath !== null;
  // Optional: the engine's own containerd. Unset, dockerd adopts a containerd already listening on
  // /run/containerd (a base image's own), whose PATH may find this bundle's newer shim first: the
  // two then disagree on the shim's bootstrap (VM 131 run 7, "unsupported protocol: Yunix").
  const containerdPath = nonEmpty(options.containerdPath);
  const shimPath = nonEmpty(options.shimPath);
  const containerdDirectory = path.join(execRoot, "containerd");
  const containerdSocket = path.join(containerdDirectory, "containerd.sock");
  const containerdConfig = path.join(containerdDirectory, "containerd.toml");
  // Optional: readiness runs a container (this static file as its only content) after `docker
  // info`, so an engine that answers but cannot start a container is never reported ready.
  const probeInitPath = nonEmpty(options.containerProbeInitPath);
  const dockerdArgs = [
    ...(containerdPath === null ? [] : ["--containerd", containerdSocket]),
    "--host",
    dockerHost,
    "--data-root",
    dataRoot,
    "--exec-root",
    execRoot,
    "--pidfile",
    pidFile,
    ...(bridgeIp === null ? [] : ["--bip", bridgeIp]),
    ...addressPools.flatMap((pool) => ["--default-address-pool", pool]),
    ...(group === null ? [] : ["--group", group]),
    ...(cgroupParent === null
      ? []
      : [
          "--cgroup-parent",
          cgroupParent,
          ...(cgroupParent.endsWith(".slice") ? ["--exec-opt", "native.cgroupdriver=systemd"] : []),
        ]),
  ];
  const probeArgs = ["--host", dockerHost, "info"];
  const socketDirectory = path.dirname(socketPath);
  const runtimeDirectories = [socketDirectory, dataRoot, execRoot, path.dirname(pidFile)];
  const prepareDirectories = () => {
    const gid = group === null ? null : resolveGroupId(group);
    if (group !== null && gid === null) throw new Error("Docker socket group is unknown");
    for (const directory of new Set(runtimeDirectories)) {
      if (gid !== null && directory === socketDirectory) ensureGroupDirectory(directory, gid);
      else ensurePrivateDirectory(directory);
    }
  };
  const readinessTimeoutMs = positiveInteger(options.readinessTimeoutMs, 30_000);
  const probeIntervalMs = positiveInteger(options.probeIntervalMs, 1_000);
  const probeTimeoutMs = positiveInteger(options.probeTimeoutMs, 5_000);
  const shutdownTimeoutMs = positiveInteger(options.shutdownTimeoutMs, 2_000);
  const logMaxBytes = Math.min(positiveInteger(options.logMaxBytes, 1024 * 1024), 8 * 1024 * 1024);
  const env = serviceEnvironment();
  const signatureTracker = createSignatureTracker(socketPath);
  const diagnosticFacts = () => ({
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    capabilities: requiredCapabilityFacts(),
    dockerdBinaryExists: existsSync(dockerdPath),
    dockerCliExists: existsSync(dockerPath),
    cgroupPathExists: existsSync("/sys/fs/cgroup"),
    overlayModuleExists: existsSync("/sys/module/overlay"),
    dockerSocketParentType: pathType(path.dirname(socketPath)),
    dockerDataRootType: pathType(dataRoot),
    dockerExecRootParentType: pathType(path.dirname(execRoot)),
    cgroupMountReadOnly: mountReadOnly("/sys/fs/cgroup"),
    dockerDataRootMountReadOnly: mountReadOnly(dataRoot),
  });
  const initialFacts = diagnosticFacts();
  if (!initialFacts.dockerdBinaryExists || !initialFacts.dockerCliExists) {
    signatureTracker.markMissingBinary();
  }

  let health = { status: "starting" };
  let containerd = null;
  let containerdClosed = false;
  // What the engine is made of, said with any failure: which containerd dockerd uses (its binary
  // and socket), its version and the shim's, and whether a system containerd was there to adopt.
  let engineSummary = null;
  let dockerd = null;
  let dockerdClosed = false;
  let timer = null;
  let started = false;
  let stopping = false;
  let stopPromise = null;
  let lastProbeFailure = null;
  let consecutiveRuntimeProbeFailures = 0;
  let lastCountedRuntimeProbeFailureAt = 0;
  let runtimeProbe = null;
  const probes = new Set();

  const clearProbeTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const stopProbes = () => {
    for (const probe of probes) stopGuestProcessGroup(probe, "SIGKILL");
    probes.clear();
  };

  const fail = (reason, code = null, signal = null, stopDockerd = false, detail = "") => {
    if (health.status === "failed" || stopping) return;
    const output = [engineSummary, detail.trim()]
      .filter((part) => typeof part === "string" && part !== "")
      .join("\n")
      .slice(-ENGINE_OUTPUT_MAX_CHARS);
    health = {
      status: "failed",
      reason,
      code,
      signal,
      ...(lastProbeFailure === null ? {} : { probe: lastProbeFailure }),
      ...(output === "" ? {} : { output }),
    };
    clearProbeTimer();
    stopProbes();
    if (stopDockerd) {
      stopGuestProcessGroup(dockerd, "SIGTERM");
      stopGuestProcessGroup(containerd, "SIGTERM");
    }
    options.onStateChange?.(health);
  };

  const probe = async () => {
    if (stopping || health.status === "failed") return false;
    const child = spawn(dockerPath, probeArgs, {
      detached: true,
      env,
      stdio: "ignore",
    });
    options.onSpawn?.(child, "docker-probe");
    probes.add(child);
    let timeout;
    const outcome = await Promise.race([
      new Promise((resolve) =>
        child.once("exit", (code, signal) =>
          resolve(
            code === 0 && signal === null
              ? { ready: true, failure: null }
              : { ready: false, failure: { reason: "exited", code, signal } },
          ),
        ),
      ),
      new Promise((resolve) =>
        child.once("error", (error) => {
          const code = safeSpawnErrorCode(error);
          if (code === "ENOENT") signatureTracker.markMissingBinary();
          resolve({
            ready: false,
            failure: { reason: "spawn-failed", code, signal: null },
          });
        }),
      ),
      new Promise((resolve) => {
        timeout = setTimeout(
          () =>
            resolve({
              ready: false,
              failure: { reason: "timeout", code: null, signal: null },
            }),
          probeTimeoutMs,
        );
        timeout.unref();
      }),
    ]);
    clearTimeout(timeout);
    if (outcome.failure?.reason === "timeout") stopGuestProcessGroup(child, "SIGKILL");
    killDescendantsAfterLeaderExit(child.pid);
    probes.delete(child);
    if (outcome.failure !== null) lastProbeFailure = outcome.failure;
    return outcome.ready;
  };

  const schedule = (fn) => {
    clearProbeTimer();
    timer = setTimeout(() => {
      timer = null;
      void fn();
    }, probeIntervalMs);
    timer.unref();
  };

  const checkRuntime = async () => {
    if (stopping || health.status !== "ready") {
      return { probeSucceeded: false, serviceReady: false };
    }
    if (runtimeProbe !== null) return runtimeProbe;

    const current = (async () => {
      const probeSucceeded = await probe();
      if (stopping || health.status !== "ready") {
        return { probeSucceeded: false, serviceReady: false };
      }
      if (probeSucceeded) {
        consecutiveRuntimeProbeFailures = 0;
        lastCountedRuntimeProbeFailureAt = 0;
        return { probeSucceeded: true, serviceReady: true };
      }
      const now = Date.now();
      if (
        lastCountedRuntimeProbeFailureAt === 0 ||
        now - lastCountedRuntimeProbeFailureAt >= probeIntervalMs
      ) {
        consecutiveRuntimeProbeFailures += 1;
        lastCountedRuntimeProbeFailureAt = now;
      }
      if (consecutiveRuntimeProbeFailures >= RUNTIME_PROBE_FAILURE_LIMIT) {
        fail("probe-failed");
      }
      return { probeSucceeded: false, serviceReady: health.status === "ready" };
    })();
    runtimeProbe = current;
    try {
      return await current;
    } finally {
      if (runtimeProbe === current) runtimeProbe = null;
    }
  };

  const monitor = async () => {
    const result = await checkRuntime();
    if (!result.serviceReady || stopping || health.status !== "ready") return;
    schedule(monitor);
  };

  /** What the engine is made of, as one line per part, for a failure to carry. */
  const describeEngine = async () => {
    const systemSocket = existsSync(SYSTEM_CONTAINERD_SOCKET);
    const lines = [
      containerdPath === null
        ? `containerd: dockerd's choice (${systemSocket ? `adopts the system one at ${SYSTEM_CONTAINERD_SOCKET}` : "its own, started by dockerd"})`
        : `containerd: ${containerdPath} ${await versionOf(containerdPath, ["--version"], env)} on ${containerdSocket}`,
      ...(shimPath === null ? [] : [`shim: ${shimPath} ${await versionOf(shimPath, ["-v"], env)}`]),
      `system containerd socket: ${systemSocket ? "present" : "absent"}`,
    ];
    return lines.join("\n");
  };

  /**
   * Readiness's real container: import an image of one static file (no registry, no network) and
   * run it with no network. It is what `docker run` does end to end: containerd, the shim, runc.
   */
  const probeContainer = async () => {
    let content;
    try {
      content = readFileSync(probeInitPath);
    } catch {
      return { ok: false, detail: `container probe: ${probeInitPath} is not readable` };
    }
    const spawnOptions = {
      env,
      timeoutMs: PROBE_TIMEOUT_MS,
      onSpawn: options.onSpawn,
      role: "docker-probe",
    };
    const imported = await runBounded(
      dockerPath,
      ["--host", dockerHost, "import", "--change", 'ENTRYPOINT ["/probe"]', "-", PROBE_IMAGE],
      { ...spawnOptions, input: singleFileTar("probe", content) },
    );
    if (imported.code !== 0)
      return { ok: false, detail: `container probe: docker import failed:\n${imported.output}` };
    const ran = await runBounded(
      dockerPath,
      [
        "--host",
        dockerHost,
        "run",
        "--rm",
        "--network",
        "none",
        "--pull",
        "never",
        "--log-driver",
        "none",
        PROBE_IMAGE,
        "--version",
      ],
      spawnOptions,
    );
    if (ran.code !== 0)
      return { ok: false, detail: `container probe: docker run failed:\n${ran.output}` };
    return { ok: true, detail: "" };
  };

  /** Start the engine's own containerd, and resolve once its socket is there (or it failed). */
  const startContainerd = async (deadline, stderrLog) => {
    try {
      mkdirSync(containerdDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(
        containerdConfig,
        [
          "version = 2",
          `root = ${JSON.stringify(path.join(dataRoot, "containerd", "daemon"))}`,
          `state = ${JSON.stringify(path.join(containerdDirectory, "daemon"))}`,
          // The engine needs no Kubernetes CRI, as dockerd's own containerd runs without it.
          'disabled_plugins = ["io.containerd.grpc.v1.cri", "io.containerd.cri.v1.runtime", "io.containerd.cri.v1.images"]',
          "[grpc]",
          `  address = ${JSON.stringify(containerdSocket)}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
    } catch {
      return "directory-preparation-failed";
    }
    const containerdArgs = ["--config", containerdConfig];
    const [command, args] =
      engineCgroupPath === null
        ? [containerdPath, containerdArgs]
        : [
            "/bin/sh",
            [
              "-c",
              'echo $$ > "$0/cgroup.procs" && exec "$@"',
              engineCgroupPath,
              containerdPath,
              ...containerdArgs,
            ],
          ];
    containerd = spawn(command, args, { detached: true, env, stdio: ["ignore", "ignore", "pipe"] });
    options.onSpawn?.(containerd, "containerd");
    containerd.stderr?.on("data", (chunk) => stderrLog.write(chunk));
    let exited = null;
    containerd.once("error", () => {
      exited ??= { code: null, signal: null };
    });
    containerd.once("exit", (code, signal) => {
      exited ??= { code, signal };
      if (!stopping && health.status !== "failed")
        fail("containerd-failed", code, signal, true, "containerd exited");
    });
    containerd.once("close", () => {
      containerdClosed = true;
    });
    while (!existsSync(containerdSocket)) {
      if (exited !== null) return "containerd-failed";
      if (stopping) return "stopping";
      if (Date.now() >= deadline) return "readiness-timeout";
      await new Promise((resolve) => setTimeout(resolve, 50).unref());
    }
    return "ready";
  };

  const start = () => {
    if (started) return;
    started = true;
    try {
      prepareDirectories();
    } catch {
      fail("directory-preparation-failed");
      return;
    }
    const deadline = Date.now() + readinessTimeoutMs;
    const stderrLog = openBoundedLog(options.logPath, logMaxBytes);
    if (engineCgroupPath !== null || cgroupParent !== null) {
      try {
        // The engine's cgroup is made before dockerd joins it; the containers' slice is started
        // (so it exists before any container) and located from systemd.
        cgroupPath = dockerCgroups({
          engineCgroupPath,
          cgroupParent,
          cgroupRoot,
          systemctlPath,
        }).containerCgroupPath;
      } catch {
        fail("directory-preparation-failed");
        return;
      }
    }
    const launchDockerd = () => {
      // With an engine cgroup, a shell joins it and then execs dockerd under the same pid, so dockerd
      // is in it before it can start anything: no child escapes the cgroup by racing the move.
      const [command, args] =
        engineCgroupPath === null
          ? [dockerdPath, dockerdArgs]
          : [
              "/bin/sh",
              [
                "-c",
                'echo $$ > "$0/cgroup.procs" && exec "$@"',
                engineCgroupPath,
                dockerdPath,
                ...dockerdArgs,
              ],
            ];
      dockerd = spawn(command, args, {
        detached: true,
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      // The agent records every process it starts (pid and start time): the processes the final
      // sweep and a recovery may spare are exactly those, never ones that merely share a name.
      options.onSpawn?.(dockerd, "dockerd");
      dockerd.stderr?.on("data", (chunk) => {
        stderrLog.write(chunk);
        signatureTracker.observe(chunk);
      });
      dockerd.once("error", (error) => {
        if (safeSpawnErrorCode(error) === "ENOENT") signatureTracker.markMissingBinary();
        fail("spawn-failed");
      });
      dockerd.once("exit", (code, signal) => {
        killDescendantsAfterLeaderExit(dockerd?.pid);
        if (!stopping) fail("exited", code, signal);
      });
      dockerd.once("close", () => {
        dockerdClosed = true;
        stderrLog.close();
      });

      const awaitReady = async () => {
        if (stopping || health.status === "failed") return;
        if (await probe()) {
          if (stopping || health.status === "failed") return;
          if (probeInitPath !== null) {
            const container = await probeContainer();
            if (stopping || health.status === "failed") return;
            if (!container.ok) {
              fail("container-probe-failed", null, null, true, container.detail);
              return;
            }
          }
          health = { status: "ready", socket: socketPath };
          consecutiveRuntimeProbeFailures = 0;
          lastCountedRuntimeProbeFailureAt = 0;
          options.onStateChange?.(health);
          options.onReady();
          if (!stopping) schedule(monitor);
          return;
        }
        if (Date.now() >= deadline) {
          fail("readiness-timeout", null, null, true);
          return;
        }
        schedule(awaitReady);
      };
      void awaitReady();
    };
    void (async () => {
      engineSummary = await describeEngine();
      if (stopping || health.status === "failed") return;
      if (containerdPath !== null) {
        const outcome = await startContainerd(deadline, stderrLog);
        if (outcome === "stopping" || health.status === "failed") return;
        if (outcome !== "ready") {
          fail(outcome, containerd?.exitCode ?? null, containerd?.signalCode ?? null, true);
          return;
        }
      }
      launchDockerd();
    })();
  };

  const verify = async () => {
    const result = await checkRuntime();
    return result.probeSucceeded && result.serviceReady;
  };

  const waitForDockerdClose = async (timeoutMs) => {
    if (dockerd === null || dockerdClosed) return true;
    const controller = new AbortController();
    let closeTimer;
    const close = once(dockerd, "close", { signal: controller.signal }).then(
      () => true,
      (error) => error?.name !== "AbortError",
    );
    const timeout = new Promise((resolve) => {
      closeTimer = setTimeout(() => resolve(false), timeoutMs);
      closeTimer.unref();
    });
    try {
      return await Promise.race([close, timeout]);
    } finally {
      clearTimeout(closeTimer);
      controller.abort();
    }
  };

  /** A Docker CLI call against this daemon, bounded; never throws. */
  const dockerCommand = async (args, timeoutMs) => {
    let child;
    try {
      child = spawn(dockerPath, ["--host", dockerHost, ...args], {
        detached: true,
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return { code: null, stdout: "" };
    }
    options.onSpawn?.(child, "docker-probe");
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1024 * 1024) stdout += chunk.toString("utf8");
    });
    const killTimer = setTimeout(() => stopGuestProcessGroup(child, "SIGKILL"), timeoutMs);
    killTimer.unref();
    try {
      // `once` rejects on the child's `error`: a CLI that could not start answers no code.
      const [code] = await once(child, "close");
      return { code, stdout };
    } catch {
      return { code: null, stdout: "" };
    } finally {
      clearTimeout(killTimer);
    }
  };

  /** Give every container its stop grace (`docker stop -t N`) while dockerd still runs. */
  const stopContainers = async () => {
    if (containerStopSeconds === null || dockerd === null || dockerdClosed) return;
    const listed = await dockerCommand(["ps", "--quiet", "--no-trunc"], 10_000);
    const ids = listed.stdout.split("\n").filter((id) => /^[a-f0-9]{12,64}$/.test(id));
    if (listed.code !== 0 || ids.length === 0) return;
    await dockerCommand(
      ["stop", "--time", String(containerStopSeconds), ...ids],
      (containerStopSeconds + 15) * 1000,
    );
  };

  /**
   * After dockerd is gone: kill what is left in Docker's own cgroups (the engine's: containerd
   * and its shims; the containers') and prove them empty. Nothing outside them is touched, not
   * even a process running the same engine binary. `false` when it cannot be proved.
   */
  const sweepLeftovers = async () => {
    // Nothing was ever started: there is nothing of Docker to prove gone.
    if (dockerd === null && containerd === null) return true;
    // A containers' slice that was never resolved cannot be proved empty.
    if (cgroupParent !== null && cgroupPath === null) return false;
    return killCgroupsUntilEmpty(
      [engineCgroupPath, cgroupPath].filter((cgroup) => cgroup !== null),
    );
  };

  const stop = () => {
    // A stop already made is not repeated, but one that could not prove Docker gone is checked
    // (and swept) again: a park or recovery that was refused for it can be retried.
    if (stopPromise !== null) {
      return stopPromise.then(async (result) =>
        verifiesStop && result.verified !== true
          ? { ...result, verified: await sweepLeftovers() }
          : result,
      );
    }
    stopPromise = (async () => {
      stopping = true;
      clearProbeTimer();
      stopProbes();
      await stopContainers();
      stopGuestProcessGroup(dockerd, "SIGTERM");
      let result;
      if (await waitForDockerdClose(shutdownTimeoutMs)) {
        result = { ok: true, forced: false };
      } else {
        stopGuestProcessGroup(dockerd, "SIGKILL");
        const killed = await waitForDockerdClose(shutdownTimeoutMs);
        result = {
          ok: false,
          forced: true,
          reason: "shutdown-timeout",
          code: dockerd?.exitCode ?? null,
          signal: dockerd?.signalCode ?? null,
          killed,
        };
      }
      // The engine's own containerd goes after dockerd, as dockerd stops its own.
      if (containerd !== null && !containerdClosed) {
        stopGuestProcessGroup(containerd, "SIGTERM");
        const closed = await Promise.race([
          once(containerd, "close").then(
            () => true,
            () => true,
          ),
          new Promise((resolve) => setTimeout(() => resolve(false), shutdownTimeoutMs).unref()),
        ]);
        if (!closed) stopGuestProcessGroup(containerd, "SIGKILL");
      }
      // `verified`: nothing of Docker runs any more (only when the service can tell).
      return verifiesStop ? { ...result, verified: await sweepLeftovers() } : result;
    })();
    return stopPromise;
  };

  const diagnostics = () => {
    const signatures = signatureTracker.snapshot();
    return {
      health,
      probe: lastProbeFailure,
      signatures,
      identifiedSignature: Object.values(signatures).some(Boolean),
      facts: diagnosticFacts(),
      engine: engineSummary,
    };
  };

  return {
    start,
    health: () => health,
    /** Which containerd dockerd uses (binary, socket), its version and the shim's; null until known. */
    engine: () => engineSummary,
    isReady: () => health.status === "ready",
    verify,
    stop,
    diagnostics,
  };
};
