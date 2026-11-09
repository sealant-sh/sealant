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
 * SEALANT_BOAT_HARNESS_PORT). Cached images (label value `cache`) are kept.
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

const processes: number[] = [];
for (const entry of await readdir("/proc")) {
  if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
  const environ = await readFile(`/proc/${entry}/environ`, "utf8").catch(() => "");
  if (environ.split("\0").some((line) => line.startsWith("SEALANT_BOAT_HARNESS_PORT=")))
    processes.push(Number(entry));
}
say(`harness processes: ${processes.join(", ") || "none"}`);
if (remove) for (const pid of processes) process.kill(pid, "SIGKILL");

for (const run of new Set(runs)) {
  const created = Date.parse(
    (await dockerOk(["network", "inspect", "-f", "{{.Created}}", `boat-harness-${run}`])).trim(),
  );
  const core = [];
  for (const object of await listCoreObjects()) {
    const at = Date.parse(
      (
        await dockerOk([
          object.kind,
          "inspect",
          "-f",
          object.kind === "volume" ? "{{.CreatedAt}}" : "{{.Created}}",
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
if (!remove) say("listed only; pass --remove to remove");
