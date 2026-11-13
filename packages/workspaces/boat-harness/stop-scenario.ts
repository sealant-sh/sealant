/**
 * A clean Stop closes in one pass (sealant#598's live runs). Real Boat withdraws a VM from its API
 * (GET answers 404) soon after accepting its DELETE, before the deletion operation completes, and
 * the fake does the same. Another closer of the same run (the 30 s lifecycle sweep, or an observer
 * that commits the 404 as absence) must not make the Stop's own pass fail and leave the close to a
 * later one. The meeting needs the sweep's tick inside the close, so the Stops here are spread
 * across the sweep's period. What a pass that did not finish logs is `isUnfinishedPass`
 * (worker-log.ts); since #600 a clean Stop logs only its `Capture drain (lifecycle stop)` line.
 */
import {
  awaitOutcome,
  cleanStop,
  guestEvidence,
  launch,
  runtimeView,
  until,
  type Launch,
  type LaunchOptions,
  type Project,
} from "./scenario.js";
import type { HarnessStack } from "./stack.js";
import {
  entriesOf,
  excerpt,
  isUnfinishedPass,
  workerLogOffset,
  workerLogSince,
} from "./worker-log.js";

/**
 * Stop to sealant's discharge (Boat's absence committed, the tunnel slot and publication pin
 * released, the workspace `stopped`). On real Boat a
 * clean Stop takes 7 to 17 s end to end; one that needed a second pass took 36 s.
 */
export const ONE_PASS_BOUND_MS = 25_000;

/**
 * How long after the discharge the log is still read: a closer that met another one can fail its
 * pass after the workspace already reads `stopped` (3 s later, on a live no-resources Stop).
 */
const LATE_PASS_MS = 10_000;

/** Boat's lifecycle sweep runs every 30 s (`apps/worker/src/workers/workspaces.ts`). */
const SWEEP_PERIOD_MS = 30_000;

/** How long a Stop took: to Mend's `stopped`, and to sealant's discharge of the run. */
export interface StopTimes {
  readonly stopped: number;
  readonly discharged: number;
}

/**
 * The owner's Stop of a ready launch, closed in one pass: sealant discharges it (allocation
 * `deleted`, workspace `stopped`) within `ONE_PASS_BOUND_MS`, and the worker logged no failed
 * close pass for the run while it closed or in the `LATE_PASS_MS` after.
 */
export const stopInOnePass = async (stack: HarnessStack, run: Launch): Promise<StopTimes> => {
  const offset = await workerLogOffset(stack);
  const stoppedAt = Date.now();
  await cleanStop(run);
  let stopped: number | undefined;
  await until(
    "sealant to discharge the Stop's run",
    async () => {
      if (stopped === undefined && (await run.workspace.status()) === "stopped")
        stopped = Date.now() - stoppedAt;
      const view = await runtimeView(stack, run.runId);
      return stopped !== undefined &&
        view.allocation === "deleted" &&
        (view.has_tunnel !== true || view.tunnel_released === true) &&
        view.pin === "released" &&
        view.status === "stopped"
        ? true
        : undefined;
    },
    ONE_PASS_BOUND_MS + 5 * 60_000,
    250,
  );
  const times = { stopped: stopped ?? 0, discharged: Date.now() - stoppedAt };
  await new Promise((done) => setTimeout(done, LATE_PASS_MS));
  const entries = entriesOf(await workerLogSince(stack, offset), run.runId);
  const failed = entries.filter(isUnfinishedPass);
  const gone = entries.filter((entry) => entry.includes("is gone"));
  const evidence = [...failed, ...gone].map(excerpt).join("\n  ");
  const took = `stopped for Mend ${(times.stopped / 1000).toFixed(1)} s and discharged ${(times.discharged / 1000).toFixed(1)} s after the Stop`;
  if (failed.length > 0 || times.discharged > ONE_PASS_BOUND_MS)
    throw new Error(
      `the Stop of run ${run.runId} did not close in one pass: ${took} (bound ${ONE_PASS_BOUND_MS / 1000} s); ${failed.length} failed close pass(es) in the worker log${evidence === "" ? "" : `:\n  ${evidence}`}`,
    );
  process.stderr.write(
    `[boat-harness] Stop of ${run.runId} in one pass: ${took}${gone.length > 0 ? `; also logged:\n  ${evidence}` : ""}\n`,
  );
  return times;
};

/**
 * Six sessions, each stopped at a different phase of the sweep's 30 s period (5 s apart, from one
 * reference, so whatever the worker's own phase some Stop has the tick land inside its close).
 * Each must close in one pass; all six run, so a failure says how many did not.
 */
const stopsAcrossTheSweep = async (
  stack: HarnessStack,
  project: Project,
  what: string,
  options: LaunchOptions,
) => {
  const sessions = 6;
  const reference = Date.now();
  const failures: string[] = [];
  const times: string[] = [];
  for (let session = 0; session < sessions; session++) {
    const run = await launch(stack, project, options);
    const outcome = await awaitOutcome(stack, run, 30 * 60_000);
    if (outcome.status !== "ready")
      throw new Error(
        `launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
      );
    const phase = (session * SWEEP_PERIOD_MS) / sessions;
    const wait =
      (phase - ((Date.now() - reference) % SWEEP_PERIOD_MS) + SWEEP_PERIOD_MS) % SWEEP_PERIOD_MS;
    await new Promise((done) => setTimeout(done, wait));
    try {
      const took = await stopInOnePass(stack, run);
      times.push(`phase ${phase / 1000} s: ${(took.discharged / 1000).toFixed(1)} s`);
    } catch (error) {
      times.push(`phase ${phase / 1000} s: failed`);
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  process.stderr.write(`[boat-harness] ${what} Stops to discharge: ${times.join("; ")}\n`);
  if (failures.length > 0)
    throw new Error(
      `${failures.length} of ${sessions} ${what} Stops needed more than one pass (${times.join("; ")}):\n${failures.join("\n")}`,
    );
};

/** Sessions with a tunnel: their closers also meet the gateway host lock and the tunnel freeze. */
export const cleanStopsInOnePass = (stack: HarnessStack, project: Project) =>
  stopsAcrossTheSweep(stack, project, "tunnel", {});

/**
 * Sessions without resources: no gateway host lock or tunnel freeze serializes their closers, so
 * the Stop's close and the sweep's close of the same run can meet at the authorization (a live
 * Stop on main failed its pass with `Boat FINAL close: held` after the sweep finished the
 * deletion).
 */
export const noResourcesStopsInOnePass = (stack: HarnessStack, project: Project) =>
  stopsAcrossTheSweep(stack, project, "no-resources", { resources: "none" });
