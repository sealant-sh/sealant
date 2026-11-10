/**
 * A clean Stop closes in one pass (sealant#598's live run). Real Boat withdraws a VM from its API
 * (GET answers 404) soon after accepting its DELETE, before the deletion operation completes, and
 * the fake now does the same. A second observer that reads Boat in that window must not make the
 * close's own pass fail and leave the Stop to a later one.
 */
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  awaitOutcome,
  cleanStop,
  guestEvidence,
  launch,
  until,
  type Launch,
  type Project,
} from "./scenario.js";
import type { HarnessStack } from "./stack.js";

/**
 * Stop to a terminal workspace. A clean Stop takes about 12 s on real Boat; one that needed a
 * second pass took 36 s. The bound sits between them.
 */
export const ONE_PASS_BOUND_MS = 25_000;

/** What a close pass that did not finish logs, for the run or naming no run at all. */
const FAILED_PASS = /Boat FINAL close: [a-z-]+|outcome nobody knows/;
const NAMES_A_RUN = /run [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const workerLog = (stack: HarnessStack) => join(stack.scratch, "worker.log");

/** The worker log's entries from byte `offset` on; an entry starts with `[HH:MM:SS.mmm]`. */
const entriesSince = async (stack: HarnessStack, offset: number) => {
  const file = await open(workerLog(stack), "r");
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.max(0, size - offset));
    await file.read(buffer, 0, buffer.length, offset);
    return stripVTControlCharacters(buffer.toString("utf8"))
      .split(/\n(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\])/)
      .filter((entry) => entry.trim() !== "");
  } finally {
    await file.close();
  }
};

/**
 * The owner's Stop of a ready launch, closed in one pass: Mend sees `stopped` within
 * `ONE_PASS_BOUND_MS`, and the worker logged no failed close pass for the run while it closed.
 */
export const stopInOnePass = async (stack: HarnessStack, run: Launch) => {
  const offset = (await stat(workerLog(stack))).size;
  const stoppedAt = Date.now();
  await cleanStop(run);
  await until(
    "Mend to see the Stop's workspace stopped",
    async () => ((await run.workspace.status()) === "stopped" ? true : undefined),
    ONE_PASS_BOUND_MS + 5 * 60_000,
    500,
  );
  const took = Date.now() - stoppedAt;
  const entries = (await entriesSince(stack, offset)).filter(
    (entry) => entry.includes(run.runId) || !NAMES_A_RUN.test(entry),
  );
  const failed = entries.filter((entry) => FAILED_PASS.test(entry));
  const gone = entries.filter((entry) => entry.includes("is gone"));
  const evidence = [...failed, ...gone].map((entry) => entry.slice(0, 600)).join("\n  ");
  if (failed.length > 0 || took > ONE_PASS_BOUND_MS)
    throw new Error(
      `the Stop of run ${run.runId} did not close in one pass: stopped ${(took / 1000).toFixed(1)} s after the Stop (bound ${ONE_PASS_BOUND_MS / 1000} s); ${failed.length} failed close pass(es) in the worker log${evidence === "" ? "" : `:\n  ${evidence}`}`,
    );
  process.stderr.write(
    `[boat-harness] Stop of ${run.runId} in one pass: stopped after ${(took / 1000).toFixed(1)} s${gone.length > 0 ? `; also logged:\n  ${evidence}` : ""}\n`,
  );
  return took;
};

/**
 * Two sessions, each ready and then stopped: each Stop must close in one pass. Both run even if
 * the first fails, so the failure says how often it happened.
 */
export const cleanStopsInOnePass = async (stack: HarnessStack, project: Project) => {
  const failures: string[] = [];
  for (let session = 0; session < 2; session++) {
    const run = await launch(stack, project);
    const outcome = await awaitOutcome(stack, run, 30 * 60_000);
    if (outcome.status !== "ready")
      throw new Error(
        `launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
      );
    await stopInOnePass(stack, run).catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : String(error));
    });
  }
  if (failures.length > 0)
    throw new Error(
      `${failures.length} of 2 clean Stops needed more than one pass:\n${failures.join("\n")}`,
    );
};
