/**
 * `harness.run()` / `harness.start()` — the one-shot execution paths, THIN HTTP CLIENTS.
 *
 * The SDK no longer execs the harness or writes telemetry itself (that moved server-side into the
 * worker). Both paths register a run via the control plane WITH the harness command (so the control
 * plane executes it). `run()` then polls until the run reaches a terminal status and reads the
 * captured changes; `start()` returns the live handle immediately (stream via `run.record.stream()`,
 * settle via `run.wait()`). No Postgres pool, no docker-exec, no telemetry sink: this is what makes
 * @sealant/sdk a plain client that runs anywhere.
 */
import { Effect } from "effect";

import { SealantError } from "../errors.js";
import type { SdkContext } from "../facade/context.js";
import { makeRun, toRunChangesData } from "../facade/run.js";
import type { RunHarnessFn, WorkspaceInit } from "../facade/workspace.js";
import type { Run } from "../types.js";
import { createRunOp, getRunChangesOp, getRunOp, getWorkspaceOp } from "./operations.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const POLL_INTERVAL = "500 millis";
const RUN_TIMEOUT_MS = 30 * 60 * 1_000;

/**
 * Registers the run — the control plane executes it server-side (the worker docker-execs it and
 * ingests telemetry). With a client harness value (the creating handle), the client-built command
 * rides along — the escape hatch that keeps `customHarness()` working. WITHOUT one (a handle from
 * `workspaces.get(id)`), the harness id is read from the workspace's own spec and NO command is
 * sent: the control plane constructs the invocation server-side, so re-fetched handles are fully
 * capable.
 */
const createHarnessRunEffect = (
  ctx: SdkContext,
  init: WorkspaceInit,
  prompt: string,
  options?: import("../types.js").RunOptions,
) =>
  Effect.gen(function* () {
    const metadata = options?.metadata === undefined ? {} : { metadata: { ...options.metadata } };
    const harness = init.harness;
    if (harness !== undefined) {
      const command = harness.buildRunCommand(prompt);
      return yield* createRunOp({
        workspaceId: init.id,
        ownerUserId: ctx.config.hostLocal.ownerUserId,
        harnessId: harness.id,
        mode: "one-shot",
        prompt,
        command: { executable: command.executable, args: [...command.args] },
        ...metadata,
      });
    }

    const details = yield* getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId);
    const spec = details.spec as { harness?: { id?: string } } | undefined;
    const harnessId = spec?.harness?.id;
    if (harnessId === undefined) {
      return yield* Effect.fail(
        new SealantError(
          `Workspace ${init.id} has no harness in its spec; pass a harness at workspaces.create() or use workspace.exec().`,
          { code: "harness_required" },
        ),
      );
    }
    return yield* createRunOp({
      workspaceId: init.id,
      ownerUserId: ctx.config.hostLocal.ownerUserId,
      harnessId,
      mode: "one-shot",
      prompt,
      ...metadata,
    });
  });

const runHarnessEffect = (
  ctx: SdkContext,
  init: WorkspaceInit,
  prompt: string,
  options?: import("../types.js").RunOptions,
) =>
  Effect.gen(function* () {
    const created = yield* createHarnessRunEffect(ctx, init, prompt, options);
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
      wire = yield* getRunOp(runId, ctx.config.hostLocal.ownerUserId);
    }

    // Read the changes the run produced (captured server-side).
    const changes = toRunChangesData(
      yield* getRunChangesOp(runId, ctx.config.hostLocal.ownerUserId),
    );
    return makeRun(ctx, { wire, changes });
  });

/** The BLOCKING `harness.run()` implementation, registered into the Workspace facade by the client. */
export const runHarness: RunHarnessFn = (ctx, init, prompt, options): Promise<Run> =>
  ctx.runtime.run(runHarnessEffect(ctx, init, prompt, options));

/**
 * The NON-BLOCKING `harness.start()` implementation: register the run and return the live handle
 * immediately. Callers stream progress via `run.record.stream()` and settle via `run.wait()` (which
 * fetches the captured changes once terminal).
 */
export const startHarness: RunHarnessFn = (ctx, init, prompt, options): Promise<Run> =>
  ctx.runtime.run(
    Effect.map(createHarnessRunEffect(ctx, init, prompt, options), (created) =>
      makeRun(ctx, { wire: created }),
    ),
  );
