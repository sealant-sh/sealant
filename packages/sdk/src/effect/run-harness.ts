/**
 * `harness.run()` — the one-shot execution path, now a THIN HTTP CLIENT.
 *
 * The SDK no longer execs the harness or writes telemetry itself (that moved server-side into the
 * worker). It simply: registers a run via the control plane WITH the harness command (so the control
 * plane executes it), polls until the run reaches a terminal status, then reads the captured changes —
 * all over HTTP. No Postgres pool, no docker-exec, no telemetry sink: this is what makes @sealant/sdk
 * a plain client that runs anywhere.
 */
import { Effect } from "effect";

import { SealantError } from "../errors.js";
import type { SdkContext } from "../facade/context.js";
import { makeRun, type RunChangesData } from "../facade/run.js";
import type { RunHarnessFn, SandboxInit } from "../facade/sandbox.js";
import type { Run } from "../types.js";
import { createRunOp, getRunChangesOp, getRunOp } from "./operations.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const POLL_INTERVAL = "500 millis";
const RUN_TIMEOUT_MS = 30 * 60 * 1_000;

const runHarnessEffect = (ctx: SdkContext, init: SandboxInit, prompt: string) =>
  Effect.gen(function* () {
    const harness = init.harness;
    if (harness === undefined) {
      return yield* Effect.fail(
        new SealantError(
          "This sandbox handle has no harness; use the handle returned by sandboxes.create().",
          { code: "harness_required" },
        ),
      );
    }

    // Register the run WITH the harness command — the control plane executes it server-side (the worker
    // docker-execs it and ingests telemetry). The cwd is the sandbox repo, which the worker defaults to.
    const command = harness.buildRunCommand(prompt);
    const created = yield* createRunOp({
      sandboxId: init.id,
      ownerUserId: ctx.config.hostLocal.ownerUserId,
      harnessId: harness.id,
      mode: "one-shot",
      prompt,
      command: { executable: command.executable, args: [...command.args] },
    });
    const runId = created.runId;

    // Block until the run is terminal, polling the control plane.
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    let wire = created;
    while (!TERMINAL_STATUSES.has(wire.status)) {
      if (Date.now() > deadline) {
        return yield* Effect.fail(
          new SealantError(`Timed out waiting for run ${runId} to complete.`, {
            code: "run_timeout",
          }),
        );
      }
      yield* Effect.sleep(POLL_INTERVAL);
      wire = yield* getRunOp(runId);
    }

    // Read the changes the run produced (captured server-side).
    const changesWire = yield* getRunChangesOp(runId);
    const changes: RunChangesData = {
      files: changesWire.files.map((file) => ({
        path: file.path,
        change: file.change,
        ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      })),
      diff: changesWire.diff,
    };

    return makeRun(ctx, { wire, changes });
  });

/** The host-local `harness.run()` implementation, registered into the Sandbox facade by the client. */
export const runHarness: RunHarnessFn = (ctx, init, prompt): Promise<Run> =>
  ctx.runtime.run(runHarnessEffect(ctx, init, prompt));
