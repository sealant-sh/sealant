/**
 * Removes one harness run's leftovers: what a run's own teardown would have removed had it run.
 * Shared by `cleanup.ts` (by hand) and `reaper.ts` (automatically, when the test process dies).
 */
import { readdir, readFile } from "node:fs/promises";

import {
  HARNESS_LABEL,
  docker,
  dockerOk,
  listCoreObjects,
  removeLabelled,
  removeObjects,
  type CoreObject,
} from "./docker.js";

export const LOCK = "sealant-boat-harness-lock";
export const LOCK_LABEL = `${HARNESS_LABEL}.lock`;
/** Every process a run starts carries this, so a reaper can find them after their parent died. */
export const RUN_ENV = "SEALANT_BOAT_HARNESS_RUN";

/** Runs with a live network on this Docker host. */
export const listRuns = async (): Promise<string[]> => [
  ...new Set(
    (
      await dockerOk([
        "network",
        "ls",
        "--filter",
        `label=${HARNESS_LABEL}`,
        "--format",
        `{{.Label "${HARNESS_LABEL}"}}`,
      ])
    )
      .split("\n")
      .filter((run) => /^[a-f0-9]{8}$/.test(run)),
  ),
];

/** The run that holds the host lock, if any. */
export const lockHolder = async (): Promise<string | undefined> => {
  const held = await docker([
    "container",
    "inspect",
    "-f",
    `{{index .Config.Labels "${LOCK_LABEL}"}}`,
    LOCK,
  ]);
  const holder = held.stdout.trim();
  return held.code === 0 && holder !== "" ? holder : undefined;
};

/** Releases the host lock if `runId` holds it. */
export const releaseLock = async (runId: string): Promise<void> => {
  if ((await lockHolder()) === runId) await docker(["rm", LOCK]);
};

/** Processes a run started (its worker and API), found by their environment. */
export const runProcesses = async (runId: string): Promise<number[]> => {
  const found: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const environ = await readFile(`/proc/${entry}/environ`, "utf8").catch(() => "");
    if (environ.split("\0").includes(`${RUN_ENV}=${runId}`)) found.push(Number(entry));
  }
  return found;
};

const created = async (kind: CoreObject["kind"], id: string) =>
  Date.parse(
    (
      await dockerOk([
        kind,
        "inspect",
        "-f",
        kind === "volume"
          ? "{{.CreatedAt}}"
          : kind === "network"
            ? '{{.Created.Format "2006-01-02T15:04:05.000Z07:00"}}'
            : "{{.Created}}",
        id,
      ])
    ).trim(),
  );

/**
 * Core-labelled objects created after the run's network. The harness refuses to start beside other
 * Sealant objects and holds the host lock while it runs, so on this host these are the run's.
 */
export const runCoreObjects = async (runId: string): Promise<CoreObject[]> => {
  const network = await docker(["network", "inspect", `boat-harness-${runId}`]);
  if (network.code !== 0) return [];
  const since = await created("network", `boat-harness-${runId}`);
  const objects: CoreObject[] = [];
  for (const object of await listCoreObjects())
    if ((await created(object.kind, object.id)) >= since) objects.push(object);
  return objects;
};

export interface Reaped {
  readonly processes: readonly number[];
  readonly core: readonly CoreObject[];
  readonly labelled: number;
}

/** Stops the run's processes, removes its objects and releases the lock if it held it. */
export const reapRun = async (runId: string): Promise<Reaped> => {
  const processes = await runProcesses(runId);
  for (const pid of processes) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  const core = await runCoreObjects(runId);
  await removeObjects(core);
  const removed = await removeLabelled(`${HARNESS_LABEL}=${runId}`, { images: true });
  await releaseLock(runId);
  return {
    processes,
    core,
    labelled:
      removed.containers.length +
      removed.networks.length +
      removed.volumes.length +
      removed.images.length,
  };
};
