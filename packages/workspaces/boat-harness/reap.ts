/**
 * The host lock and the removal of a run's leftovers. Shared by the stack (lock), `reaper.ts`
 * (automatic, when the test process dies) and `cleanup.ts` (by hand).
 *
 * Ownership is never inferred: a run owns exactly the Docker objects labelled
 * `sh.sealant.boat-harness=<run>`. Core's own objects get that label from `bin/docker`.
 */
import { readdir, readFile, stat } from "node:fs/promises";

import { HARNESS_LABEL, docker, removeLabelled, type DockerRunner } from "./docker.js";

export const LOCK = "sealant-boat-harness-lock";
export const LOCK_LABEL = `${HARNESS_LABEL}.lock`;
/** Every process a run starts carries this, so a reaper can find them after their parent died. */
export const RUN_ENV = "SEALANT_BOAT_HARNESS_RUN";

export interface HostDeps {
  readonly docker: DockerRunner;
  readonly processAlive: (pid: number) => Promise<boolean>;
  /** Processes whose environment carries `RUN_ENV=<run>`. */
  readonly runProcesses: (runId: string) => Promise<number[]>;
  readonly kill: (pid: number) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export const realHost: HostDeps = {
  docker,
  processAlive: (pid) =>
    stat(`/proc/${pid}`).then(
      () => true,
      () => false,
    ),
  runProcesses: async (runId) => {
    const found: number[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      const environ = await readFile(`/proc/${entry}/environ`, "utf8").catch(() => "");
      if (environ.split("\0").includes(`${RUN_ENV}=${runId}`)) found.push(Number(entry));
    }
    return found;
  },
  kill: (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  },
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
};

export interface LockState {
  readonly holder: string;
  readonly pid: number | undefined;
  /** The holder's process or its run network still exists: the run is live, or tearing down. */
  readonly alive: boolean;
}

/** Who holds the host lock, and whether that run is still alive. `undefined` when it is free. */
export const lockState = async (deps: HostDeps = realHost): Promise<LockState | undefined> => {
  const held = await deps.docker([
    "container",
    "inspect",
    "-f",
    `{{index .Config.Labels "${LOCK_LABEL}"}} {{index .Config.Labels "${LOCK_LABEL}.pid"}}`,
    LOCK,
  ]);
  if (held.code !== 0) return undefined;
  const [holder = "", pidText = ""] = held.stdout.trim().split(" ");
  const pid = /^\d+$/.test(pidText) ? Number(pidText) : undefined;
  const processAlive = pid !== undefined && (await deps.processAlive(pid));
  const networkAlive =
    (await deps.docker(["network", "inspect", `boat-harness-${holder}`])).code === 0;
  return { holder, pid, alive: processAlive || networkAlive };
};

/**
 * One harness run per Docker host: Core's worker reconciles resource networks and gateways
 * host-wide, so two stacks on one host disturb each other. The lock is a named container that is
 * never started; creating it is atomic. It is taken over only when its holder's process and run
 * network are both gone. Waits up to two hours.
 */
export const acquireHostLock = async (
  runId: string,
  pid: number,
  log: (line: string) => void,
  deps: HostDeps = realHost,
): Promise<void> => {
  const deadline = deps.now() + 2 * 60 * 60_000;
  let reported = "";
  for (;;) {
    const created = await deps.docker([
      "create",
      "--name",
      LOCK,
      "--label",
      `${LOCK_LABEL}=${runId}`,
      "--label",
      `${LOCK_LABEL}.pid=${pid}`,
      "postgres:17-alpine",
      "true",
    ]);
    if (created.code === 0) return;
    const state = await lockState(deps);
    if (state !== undefined && !state.alive) {
      log(`taking over the lock of harness run ${state.holder}, which is gone`);
      await deps.docker(["rm", LOCK]);
      continue;
    }
    if (deps.now() > deadline)
      throw new Error(`harness run ${state?.holder ?? "?"} still holds the host lock`);
    if (state !== undefined && reported !== state.holder)
      log(`another harness run (${state.holder}) is using this Docker host; waiting`);
    reported = state?.holder ?? "";
    await deps.sleep(15_000);
  }
};

/** Releases the host lock if `runId` holds it. */
export const releaseLock = async (runId: string, deps: HostDeps = realHost): Promise<void> => {
  if ((await lockState(deps))?.holder === runId) await deps.docker(["rm", LOCK]);
};

/** Runs with any labelled object on this Docker host (a run that died early may have no network). */
export const listRuns = async (deps: HostDeps = realHost): Promise<string[]> => {
  const runs = new Set<string>();
  for (const args of [
    ["ps", "-a", "--filter", `label=${HARNESS_LABEL}`, "--format", `{{.Label "${HARNESS_LABEL}"}}`],
    [
      "network",
      "ls",
      "--filter",
      `label=${HARNESS_LABEL}`,
      "--format",
      `{{.Label "${HARNESS_LABEL}"}}`,
    ],
    [
      "image",
      "ls",
      "--filter",
      `label=${HARNESS_LABEL}`,
      "--format",
      `{{.Label "${HARNESS_LABEL}"}}`,
    ],
  ]) {
    const listed = await deps.docker(args);
    for (const run of listed.stdout.split("\n")) if (/^[a-f0-9]{8}$/.test(run)) runs.add(run);
  }
  return [...runs];
};

export interface Reaped {
  readonly processes: readonly number[];
  readonly labelled: number;
}

/** Stops the run's processes, removes its labelled objects and releases the lock if it held it. */
export const reapRun = async (runId: string, deps: HostDeps = realHost): Promise<Reaped> => {
  const processes = await deps.runProcesses(runId);
  for (const pid of processes) deps.kill(pid);
  const removed = await removeLabelled(`${HARNESS_LABEL}=${runId}`, { images: true }, deps.docker);
  await releaseLock(runId, deps);
  return {
    processes,
    labelled:
      removed.containers.length +
      removed.networks.length +
      removed.volumes.length +
      removed.images.length,
  };
};

/**
 * The reaper's job: wait for the run's test process to die, then reap the run. A normal teardown
 * stops the reaper before it ends, so a reaper that outlives its parent means the teardown did not
 * finish, however early the run died (before its network, during an image build).
 */
export const watchAndReap = async (
  runId: string,
  parent: number,
  deps: HostDeps = realHost,
): Promise<Reaped> => {
  while (await deps.processAlive(parent)) await deps.sleep(2000);
  return reapRun(runId, deps);
};

export interface CleanupPlan {
  /** Runs whose leftovers may be removed: not live. */
  readonly reap: readonly string[];
  /** A live run, never touched. */
  readonly live: string | undefined;
  /** The lock's holder is gone: the lock may be removed. */
  readonly staleLock: string | undefined;
}

/** What `cleanup.ts` may remove. A run is live while its lock holder's process or network exists. */
export const cleanupPlan = async (deps: HostDeps = realHost): Promise<CleanupPlan> => {
  const runs = await listRuns(deps);
  const lock = await lockState(deps);
  const live = lock?.alive === true ? lock.holder : undefined;
  return {
    reap: runs.filter((run) => run !== live),
    live,
    staleLock: lock !== undefined && !lock.alive ? lock.holder : undefined,
  };
};
