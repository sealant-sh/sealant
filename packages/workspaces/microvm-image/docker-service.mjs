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
  readdirSync,
  readlinkSync,
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

const nonEmpty = (value) => (typeof value === "string" && value !== "" ? value : null);

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
  const cgroupPath = nonEmpty(options.cgroupPath);
  const shimPath = nonEmpty(options.shimPath);
  // Optional: stop every container (`docker stop -t N`) before dockerd itself is signalled.
  const containerStopSeconds =
    Number.isInteger(Number(options.containerStopSeconds)) &&
    Number(options.containerStopSeconds) > 0
      ? Number(options.containerStopSeconds)
      : null;
  const verifiesStop = cgroupPath !== null || shimPath !== null;
  const dockerdArgs = [
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

  const fail = (reason, code = null, signal = null, stopDockerd = false) => {
    if (health.status === "failed" || stopping) return;
    health = {
      status: "failed",
      reason,
      code,
      signal,
      ...(lastProbeFailure === null ? {} : { probe: lastProbeFailure }),
    };
    clearProbeTimer();
    stopProbes();
    if (stopDockerd) stopGuestProcessGroup(dockerd, "SIGTERM");
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
    dockerd = spawn(dockerdPath, dockerdArgs, {
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

  // The engine's binaries: a process running one of them after a stop is Docker still running.
  const dockerBinaries = new Set(
    [dockerdPath, path.join(path.dirname(dockerdPath), "containerd"), shimPath].filter(
      (binary) => typeof binary === "string" && binary !== "",
    ),
  );
  const dockerProcesses = () => {
    let names;
    try {
      names = readdirSync("/proc");
    } catch {
      return [];
    }
    const found = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const executable = readlinkSync(`/proc/${name}/exe`).replace(/ \(deleted\)$/, "");
        if (dockerBinaries.has(executable)) found.push(Number(name));
      } catch {
        // Gone, or another user's process: not ours to judge.
      }
    }
    return found;
  };
  const cgroupPopulated = () => {
    if (cgroupPath === null) return false;
    try {
      return /^populated 1$/m.test(readFileSync(path.join(cgroupPath, "cgroup.events"), "utf8"));
    } catch (error) {
      // No such cgroup: nothing was ever put in it, or it is gone with its last process.
      return error?.code !== "ENOENT";
    }
  };
  /**
   * After dockerd is gone: kill what it left (the containers' cgroup, then any process still
   * running an engine binary) and prove that nothing of Docker runs. `false` when it cannot.
   */
  const sweepLeftovers = async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const leftovers = dockerProcesses();
      const populated = cgroupPopulated();
      if (leftovers.length === 0 && !populated) return true;
      if (Date.now() >= deadline) return false;
      if (populated) {
        try {
          writeFileSync(path.join(cgroupPath, "cgroup.kill"), "1");
        } catch {
          // A kernel without cgroup.kill (before 5.14): the process sweep below still runs.
        }
      }
      for (const pid of leftovers) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
    };
  };

  return {
    start,
    health: () => health,
    isReady: () => health.status === "ready",
    verify,
    stop,
    diagnostics,
  };
};
