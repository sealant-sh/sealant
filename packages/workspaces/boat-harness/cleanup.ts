/**
 * Cleans up after an interrupted harness run (a killed test process skips the stack's teardown).
 *
 *   pnpm --filter @sealant/workspaces exec tsx boat-harness/cleanup.ts            # list only
 *   pnpm --filter @sealant/workspaces exec tsx boat-harness/cleanup.ts --remove   # remove
 *
 * It removes:
 * - every object labelled `sh.sealant.boat-harness=<run>` for a run whose network still exists;
 * - Core-labelled objects (resources, gateways) created after that run's network. The harness
 *   refuses to start beside other Sealant objects, so on a host it ran on these are its own.
 *
 * It also stops the worker and API processes the run started (they carry
 * SEALANT_BOAT_HARNESS_PORT), unless a run is live. The run that holds the host lock is live and is
 * never touched. Cached images (label value `cache`) are kept.
 */
import { readdir, readFile } from "node:fs/promises";

import {
  HARNESS_LABEL,
  dockerOk,
  listCoreObjects,
  removeLabelled,
  removeObjects,
} from "./docker.js";

const remove = process.argv.includes("--remove");
const say = (line: string) => process.stdout.write(`${line}\n`);

const runs = (
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
  .filter((run) => run !== "" && run !== "cache");

// The run holding the host lock is live: leave it, and its processes, alone.
const lockHolder = (
  await dockerOk([
    "ps",
    "-a",
    "--filter",
    "name=^sealant-boat-harness-lock$",
    "--format",
    `{{.Label "${HARNESS_LABEL}.lock"}}`,
  ])
).trim();
const holder = lockHolder === "" ? undefined : lockHolder;
if (holder !== undefined && runs.includes(holder))
  say(`run ${holder} is live (holds the host lock); skipped`);

const processes: number[] = [];
for (const entry of await readdir("/proc")) {
  if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
  const environ = await readFile(`/proc/${entry}/environ`, "utf8").catch(() => "");
  if (environ.split("\0").some((line) => line.startsWith("SEALANT_BOAT_HARNESS_PORT=")))
    processes.push(Number(entry));
}
say(`harness processes: ${processes.join(", ") || "none"}`);
if (holder !== undefined && runs.includes(holder)) say("a run is live, so no process is stopped");
else if (remove) for (const pid of processes) process.kill(pid, "SIGKILL");

for (const run of new Set(runs)) {
  if (run === holder) continue;
  const created = Date.parse(
    (
      await dockerOk([
        "network",
        "inspect",
        "-f",
        '{{.Created.Format "2006-01-02T15:04:05.000Z07:00"}}',
        `boat-harness-${run}`,
      ])
    ).trim(),
  );
  const core = [];
  for (const object of await listCoreObjects()) {
    const at = Date.parse(
      (
        await dockerOk([
          object.kind,
          "inspect",
          "-f",
          object.kind === "volume"
            ? "{{.CreatedAt}}"
            : object.kind === "network"
              ? '{{.Created.Format "2006-01-02T15:04:05.000Z07:00"}}'
              : "{{.Created}}",
          object.id,
        ])
      ).trim(),
    );
    if (at >= created) core.push(object);
  }
  say(
    `run ${run}: Core objects ${core.map((object) => `${object.kind}:${object.name}`).join(", ") || "none"}`,
  );
  if (remove) {
    await removeObjects(core);
    const removed = await removeLabelled(`${HARNESS_LABEL}=${run}`, { images: true });
    say(
      `run ${run}: removed ${removed.containers.length} containers, ${removed.networks.length} networks, ${removed.volumes.length} volumes, ${removed.images.length} images`,
    );
  }
}
// The host lock (stack.ts) of a run that is gone.
if (holder !== undefined && !runs.includes(holder)) {
  say(`host lock held by finished run ${holder}`);
  if (remove) await dockerOk(["rm", "sealant-boat-harness-lock"]);
}
if (!remove) say("listed only; pass --remove to remove");
