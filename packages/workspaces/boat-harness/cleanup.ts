/**
 * Cleans up after harness runs that could not tear themselves down. Each run's reaper normally does
 * this on its own (`reaper.ts`); this is the manual fallback.
 *
 *   pnpm --filter @sealant/workspaces exec tsx boat-harness/cleanup.ts            # list only
 *   pnpm --filter @sealant/workspaces exec tsx boat-harness/cleanup.ts --remove   # remove
 *
 * It removes only objects labelled `sh.sealant.boat-harness=<run>` and the processes started for
 * that run. A live run (it holds the host lock and the lock's heartbeat runs, renewed by its test
 * process and its reaper, e.g. while it builds images) is never touched, nor is its lock. Cached
 * images are kept.
 */
import { HARNESS_LABEL, listLabelled } from "./docker.js";
import { cleanupPlan, realHost, reapRun, releaseLock } from "./reap.js";

const remove = process.argv.includes("--remove");
const say = (line: string) => process.stdout.write(`${line}\n`);

const plan = await cleanupPlan();
if (plan.live !== undefined) say(`run ${plan.live}: live (holds the host lock); skipped`);
for (const run of plan.reap) {
  if (remove) {
    const reaped = await reapRun(run);
    say(
      `run ${run}: stopped ${reaped.processes.length} processes, removed ${reaped.labelled} objects`,
    );
  } else {
    const objects = await listLabelled(`${HARNESS_LABEL}=${run}`);
    const processes = await realHost.runProcesses(run);
    say(
      `run ${run}: ${objects.containers.length} containers, ${objects.networks.length} networks, ${objects.volumes.length} volumes, ${objects.images.length} images, processes ${processes.join(", ") || "none"}`,
    );
  }
}
if (plan.staleLock !== undefined) {
  say(`host lock held by finished run ${plan.staleLock}`);
  if (remove) await releaseLock(plan.staleLock);
}
if (!remove) say("listed only; pass --remove to remove");
