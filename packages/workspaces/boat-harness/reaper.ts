/**
 * One per harness run, started detached in its own process group by `stack.ts`:
 *
 *   node --import tsx boat-harness/reaper.ts <runId> <parentPid>
 *
 * Ctrl-C to the test runner and a SIGKILL of the test process both skip the stack's teardown,
 * but neither reaches this process. When the parent is gone it waits a moment for a teardown in
 * progress, then removes whatever the run left (`reapRun`) and releases the host lock. When the
 * teardown already ran, the run's network is gone and it simply exits.
 */
import { docker } from "./docker.js";
import { reapRun } from "./reap.js";

const [runId = "", parent = ""] = process.argv.slice(2);
if (!/^[a-f0-9]{8}$/.test(runId) || !/^\d+$/.test(parent))
  throw new Error("usage: reaper.ts <runId> <parentPid>");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const say = (line: string) => process.stderr.write(`[boat-harness reaper ${runId}] ${line}\n`);

while (alive(Number(parent))) await sleep(2000);
// A normal teardown removes the run's network last but one; give one in flight time to finish.
await sleep(5000);
if ((await docker(["network", "inspect", `boat-harness-${runId}`])).code !== 0) process.exit(0);
say("the test process died before its teardown; removing what the run left");
const reaped = await reapRun(runId);
say(
  `stopped ${reaped.processes.length} processes, removed ${reaped.core.length} Core objects and ${reaped.labelled} labelled objects; lock released`,
);
