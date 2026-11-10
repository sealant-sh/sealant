/**
 * One per harness run, started detached in its own process group by `stack.ts`:
 *
 *   node --import tsx boat-harness/reaper.ts <runId> <parentPid> <lockId>
 *
 * Ctrl-C to the test runner and a SIGKILL of the test process both skip the stack's teardown,
 * but neither reaches this process. The stack stops it at the end of a normal teardown. If the
 * parent dies first, it removes everything labelled with the run (processes, containers,
 * networks, volumes, images) and releases the host lock, whenever the run died. It renews the
 * lock's heartbeat for as long as it lives, so the lock stays held while it reaps.
 */
import { keepLock, watchAndReap } from "./reap.js";

const [runId = "", parent = "", lockId = ""] = process.argv.slice(2);
if (!/^[a-f0-9]{8}$/.test(runId) || !/^\d+$/.test(parent) || !/^[a-f0-9]{64}$/.test(lockId))
  throw new Error("usage: reaper.ts <runId> <parentPid> <lockId>");
keepLock(lockId, () => {});

const reaped = await watchAndReap(runId, Number(parent));
process.stderr.write(
  `[boat-harness reaper ${runId}] the test process died before its teardown finished; stopped ${reaped.processes.length} processes, removed ${reaped.labelled} labelled objects, released the lock\n`,
);
