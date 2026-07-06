/**
 * The `Run` facade — one harness execution as the SDK exposes it. Built from a `runs.get` lookup
 * (read a past run, record outlives the workspace), from `harness.run()` (which also captures the file
 * changes inline), or from `harness.start()` (a live handle; `wait()` settles it). `result` is
 * derived from the wire status; `changes` is captured inline by `run()` and fetched by `wait()` once
 * the run is terminal (the event-sourced fileChange projection that backs reads arrives in Phase 1);
 * `artifacts` is empty until the artifact store is exposed; `record` reads via the run/record
 * endpoints.
 */
import type { Run as WireRun, RunChangesResponse } from "@sealant/api-contracts";

import { getRunChangesOp, getRunOp } from "../effect/operations.js";
import { SealantError, SealantNotImplementedError } from "../errors.js";
import type { Run, RunArtifacts, RunChanges, RunFileChange, RunResult } from "../types.js";
import type { SdkContext } from "./context.js";
import { makeRunRecord } from "./record.js";

export interface RunChangesData {
  readonly files: readonly RunFileChange[];
  readonly diff: string;
}

export interface RunInit {
  readonly wire: WireRun;
  readonly changes?: RunChangesData;
}

/** Maps the wire changes shape to the facade data (shared with the run-harness execution path). */
export const toRunChangesData = (wire: RunChangesResponse): RunChangesData => ({
  files: wire.files.map((file) => ({
    path: file.path,
    change: file.change,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
  })),
  diff: wire.diff,
});

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const WAIT_POLL_INTERVAL_MS = 500;
const WAIT_TIMEOUT_MS = 30 * 60 * 1_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const toResult = (wire: WireRun): RunResult => ({
  status: wire.status,
  outcome: wire.status === "completed" ? "completed" : "failed",
  exitCode: wire.exitCode ?? -1,
});

const emptyArtifacts: RunArtifacts = {
  list: () => Promise.resolve([]),
  get: () =>
    Promise.reject(
      new SealantNotImplementedError("artifacts.get (artifact store wiring arrives in Phase 1)"),
    ),
};

export const makeRun = (ctx: SdkContext, init: RunInit): Run => {
  const runId = init.wire.runId;
  const changesData = init.changes;

  const changes: RunChanges = {
    files: changesData?.files ?? [],
    diff: () => Promise.resolve(changesData?.diff ?? ""),
  };

  return {
    id: runId,
    result: toResult(init.wire),
    changes,
    artifacts: emptyArtifacts,
    record: makeRunRecord(ctx, runId),

    wait: async () => {
      let current = init.wire;
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (!TERMINAL_STATUSES.has(current.status)) {
        if (Date.now() > deadline) {
          throw new SealantError(`Timed out waiting for run ${runId} to reach a terminal status.`, {
            code: "run_wait_timeout",
          });
        }
        await delay(WAIT_POLL_INTERVAL_MS);
        current = await ctx.runtime.run(getRunOp(runId));
      }
      // Settle the changes: a handle from `harness.start()` or `runs.get()` has none captured yet,
      // so read the server-side capture now that the run is terminal.
      const settledChanges =
        changesData ?? toRunChangesData(await ctx.runtime.run(getRunChangesOp(runId)));
      return makeRun(ctx, { wire: current, changes: settledChanges });
    },
  };
};
