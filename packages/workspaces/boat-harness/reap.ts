/**
 * The host lock and the removal of a run's leftovers. Shared by the stack (lock), `reaper.ts`
 * (automatic, when the test process dies) and `cleanup.ts` (by hand).
 *
 * Ownership is never inferred: a run owns exactly the Docker objects labelled
 * `sh.sealant.boat-harness=<run>`. Core's own objects get that label from `bin/docker`.
 */
import { readdir, readFile, stat } from "node:fs/promises";

import {
  HARNESS_LABEL,
  docker,
  listLabelled,
  removeLabelled,
  type DockerRunner,
  type LabelledObjects,
} from "./docker.js";

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

/** The heartbeat's lifetime: a lock not renewed for this long ends itself. */
export const LOCK_TTL_SECONDS = 120;
/** How often a run's test process and its reaper renew the lock. */
export const LOCK_RENEW_MS = 10_000;

/**
 * The lock container's own program. It stops `LOCK_TTL_SECONDS` after the last renewal, so a
 * running lock proves its holder renewed it recently. Docker is the one thing every harness run on
 * a host shares; process ids are not (another sandbox may have its own PID namespace).
 */
const LOCK_PROGRAM =
  "date +%s > /tmp/beat && " +
  `while [ $(( $(date +%s) - $(cat /tmp/beat) )) -lt ${LOCK_TTL_SECONDS} ]; do sleep 2; done`;

export interface LockState {
  readonly holder: string;
  /** The lock container's id: removals name it, never the shared name a new holder may reuse. */
  readonly id: string;
  /** The heartbeat is running: the holder, or its reaper, renewed it within the TTL. */
  readonly alive: boolean;
}

/** Who holds the host lock, and whether its heartbeat still runs. `undefined` when it is free. */
export const lockState = async (deps: HostDeps = realHost): Promise<LockState | undefined> => {
  const held = await deps.docker([
    "container",
    "inspect",
    "-f",
    `{{.Id}} {{.State.Running}} {{index .Config.Labels "${LOCK_LABEL}"}}`,
    LOCK,
  ]);
  if (held.code !== 0) return undefined;
  const [id = "", running = "", holder = ""] = held.stdout.trim().split(" ");
  return { holder, id, alive: running === "true" };
};

/** Renews the heartbeat of the lock `id`. False when that lock is no longer running. */
export const renewLock = async (id: string, deps: HostDeps = realHost): Promise<boolean> => {
  const renewed = await deps.docker(
    ["exec", id, "sh", "-c", "date +%s > /tmp/beat.next && mv /tmp/beat.next /tmp/beat"],
    { timeoutMs: 20_000 },
  );
  return renewed.code === 0;
};

/** Renews the lock every `LOCK_RENEW_MS` until the returned function is called. */
export const keepLock = (
  id: string,
  onLost: () => void,
  deps: HostDeps = realHost,
): (() => void) => {
  let lost = false;
  const renew = async () => {
    if (!(await renewLock(id, deps)) && !lost) {
      lost = true;
      onLost();
    }
  };
  const timer = setInterval(() => void renew(), LOCK_RENEW_MS);
  timer.unref();
  return () => clearInterval(timer);
};

const countObjects = (objects: LabelledObjects) =>
  objects.containers.length +
  objects.networks.length +
  objects.volumes.length +
  objects.images.length;

/**
 * One harness run per Docker host: Core's worker reconciles resource networks and gateways
 * host-wide, so two stacks on one host disturb each other. The lock is a named container running
 * a heartbeat; creating it is atomic. Its holder renews it (`keepLock`), and so does the holder's
 * reaper until the run is reaped. A lock is taken over only when its heartbeat has stopped and no
 * object labelled with its run exists; a dead run that left objects stops this run with the
 * cleanup command instead, since nothing proves those objects unused. Waits up to two hours for a
 * live holder. Returns the lock's container id.
 */
export const acquireHostLock = async (
  runId: string,
  log: (line: string) => void,
  deps: HostDeps = realHost,
): Promise<string> => {
  const deadline = deps.now() + 2 * 60 * 60_000;
  let reported = "";
  for (;;) {
    const created = await deps.docker([
      "run",
      "-d",
      "--name",
      LOCK,
      "--label",
      `${LOCK_LABEL}=${runId}`,
      "--entrypoint",
      "sh",
      "postgres:17-alpine",
      "-c",
      LOCK_PROGRAM,
    ]);
    if (created.code === 0) return created.stdout.trim();
    const state = await lockState(deps);
    if (state === undefined) {
      // Freed between the two calls, or the create failed for another reason.
      if (!/Conflict|already in use/i.test(created.stderr))
        throw new Error(`could not create the host lock: ${created.stderr.slice(-1000)}`);
      continue;
    }
    if (!state.alive) {
      const left = await listLabelled(`${HARNESS_LABEL}=${state.holder}`, deps.docker);
      if (countObjects(left) > 0)
        throw new Error(
          `harness run ${state.holder} ended without finishing its teardown and left ${countObjects(left)} ` +
            `labelled objects (${[...left.containers, ...left.networks, ...left.volumes, ...left.images].slice(0, 5).join(", ")}). ` +
            "Its lock is not taken over while they exist. List and remove them with " +
            "`pnpm --filter @sealant/workspaces exec tsx boat-harness/cleanup.ts [--remove]`.",
        );
      log(
        `taking over the lock of harness run ${state.holder}: its heartbeat stopped and it left nothing`,
      );
      await deps.docker(["rm", "-f", state.id]);
      continue;
    }
    if (deps.now() > deadline)
      throw new Error(`harness run ${state.holder} still holds the host lock`);
    if (reported !== state.holder)
      log(`another harness run (${state.holder}) is using this Docker host; waiting`);
    reported = state.holder;
    await deps.sleep(15_000);
  }
};

/** Releases the host lock if `runId` holds it. */
export const releaseLock = async (runId: string, deps: HostDeps = realHost): Promise<void> => {
  const state = await lockState(deps);
  if (state?.holder === runId) await deps.docker(["rm", "-f", state.id]);
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
  return { processes, labelled: countObjects(removed) };
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

/** What `cleanup.ts` may remove. A run is live while it holds the lock and its heartbeat runs. */
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
