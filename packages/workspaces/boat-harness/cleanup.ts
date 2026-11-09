/**
 * Cleans up after a harness run that could not tear itself down. Each run's reaper normally does
 * this on its own (`reaper.ts`); this is the manual fallback.
 *
 *   pnpm --filter @sealant/workspaces exec tsx boat-harness/cleanup.ts            # list only
 *   pnpm --filter @sealant/workspaces exec tsx boat-harness/cleanup.ts --remove   # remove
 *
 * For every run with a network on this host, except the one holding the host lock (it is live),
 * it lists and then removes the run's processes, its labelled objects and the Core-labelled objects
 * created after its network. Cached images are kept. A lock left by a finished run is removed.
 */
import { docker } from "./docker.js";
import { LOCK, listRuns, lockHolder, reapRun, runCoreObjects, runProcesses } from "./reap.js";

const remove = process.argv.includes("--remove");
const say = (line: string) => process.stdout.write(`${line}\n`);

const runs = await listRuns();
const holder = await lockHolder();
for (const run of runs) {
  if (run === holder) {
    say(`run ${run}: live (holds the host lock); skipped`);
    continue;
  }
  if (remove) {
    const reaped = await reapRun(run);
    say(
      `run ${run}: stopped ${reaped.processes.length} processes, removed ${reaped.core.length} Core objects and ${reaped.labelled} labelled objects`,
    );
  } else {
    const core = await runCoreObjects(run);
    say(
      `run ${run}: processes ${(await runProcesses(run)).join(", ") || "none"}; Core objects ${core.map((object) => `${object.kind}:${object.name}`).join(", ") || "none"}`,
    );
  }
}
if (holder !== undefined && !runs.includes(holder)) {
  say(`host lock held by finished run ${holder}`);
  if (remove) await docker(["rm", LOCK]);
}
if (!remove) say("listed only; pass --remove to remove");
