import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  chmodSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
  const dockerdArgs = [
    "--host",
    dockerHost,
    "--data-root",
    dataRoot,
    "--exec-root",
    execRoot,
    "--pidfile",
    pidFile,
  ];
  const probeArgs = ["--host", dockerHost, "info"];
  const runtimeDirectories = [path.dirname(socketPath), dataRoot, execRoot, path.dirname(pidFile)];
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
      for (const directory of new Set(runtimeDirectories)) ensurePrivateDirectory(directory);
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

  const stop = () => {
    if (stopPromise !== null) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      clearProbeTimer();
      stopProbes();
      stopGuestProcessGroup(dockerd, "SIGTERM");
      if (await waitForDockerdClose(shutdownTimeoutMs)) {
        return { ok: true, forced: false };
      }
      stopGuestProcessGroup(dockerd, "SIGKILL");
      const killed = await waitForDockerdClose(shutdownTimeoutMs);
      return {
        ok: false,
        forced: true,
        reason: "shutdown-timeout",
        code: dockerd?.exitCode ?? null,
        signal: dockerd?.signalCode ?? null,
        killed,
      };
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
