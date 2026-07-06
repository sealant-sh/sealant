/**
 * `workspace.exec()` — deterministic execution, THIN HTTP CLIENT like `harness.run()`.
 *
 * Registers a single-command check run via `POST /v1/workspaces/:id/exec` (the worker docker-execs
 * it and records it into the run record like any other process), polls to terminal, then assembles
 * the result from the record: the exit code from the run resource, stdout/stderr byte-exact from the
 * scrollback endpoint keyed by the command's `processId` (found via its `processStarted` timeline
 * entry).
 *
 * Semantics: a NONZERO exit RESOLVES — for a causal proof (`base fails · head passes · revert
 * fails`) the exit code is the datum being collected. `exec()` rejects only when the run did not
 * complete, i.e. the execution machinery broke and the exit code cannot be trusted.
 */
import type { TimelineEntry as WireTimelineEntry } from "@sealant/api-contracts";
import { Effect } from "effect";

import { SealantError } from "../errors.js";
import type { SdkContext } from "../facade/context.js";
import { makeRun, toRunChangesData } from "../facade/run.js";
import type { WorkspaceInit } from "../facade/workspace.js";
import type { WorkspaceExecOptions, WorkspaceExecResult } from "../types.js";
import {
  execWorkspaceOp,
  getRunChangesOp,
  getRunOp,
  getRunScrollbackOp,
  getRunTimelineOp,
} from "./operations.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const POLL_INTERVAL = "500 millis";
const EXEC_TIMEOUT_MS = 30 * 60 * 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The exec'd command's process: the `processStarted` entry whose recorded executable matches, or the
 * first one when attribution is imprecise (the record contains only processes this run exec'd).
 */
const findCommandProcessId = (
  entries: readonly WireTimelineEntry[],
  executable: string,
): string | undefined => {
  const match = entries.find(
    (entry) => isRecord(entry.ref) && entry.ref["executable"] === executable,
  );
  return (match ?? entries[0])?.processId;
};

const readScrollback = (runId: string, processId: string, stream: "stdout" | "stderr") =>
  Effect.map(getRunScrollbackOp(runId, { processId, stream }), (response) =>
    Buffer.from(response.contentBase64, "base64").toString("utf8"),
  );

const execWorkspaceEffect = (
  ctx: SdkContext,
  init: WorkspaceInit,
  argv: readonly string[],
  options?: WorkspaceExecOptions,
) =>
  Effect.gen(function* () {
    const [executable, ...args] = argv;
    if (executable === undefined || executable.length === 0) {
      return yield* Effect.fail(
        new SealantError("exec requires argv with at least the executable.", {
          code: "invalid_argv",
        }),
      );
    }

    const created = yield* execWorkspaceOp(init.id, {
      ownerUserId: ctx.config.hostLocal.ownerUserId,
      commands: [{ executable, args, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) }],
    });
    const runId = created.runId;

    // Block until the check run is terminal, polling the control plane (same shape as harness.run()).
    const deadline = Date.now() + EXEC_TIMEOUT_MS;
    let wire = created;
    while (!TERMINAL_STATUSES.has(wire.status)) {
      if (Date.now() > deadline) {
        return yield* Effect.fail(
          new SealantError(`Timed out waiting for exec run ${runId} to complete.`, {
            code: "exec_timeout",
          }),
        );
      }
      yield* Effect.sleep(POLL_INTERVAL);
      wire = yield* getRunOp(runId);
    }

    // Exec framing: "completed" means every command executed and was recorded — anything else means
    // the machinery broke and the exit code cannot be trusted, which IS the error case.
    if (wire.status !== "completed") {
      return yield* Effect.fail(
        new SealantError(
          `Workspace exec did not complete: ${wire.errorMessage ?? `run ${runId} is ${wire.status}`}`,
          { code: "exec_failed" },
        ),
      );
    }

    const started = yield* getRunTimelineOp(runId, { kinds: "processStarted" });
    const processId = findCommandProcessId(started, executable);
    const stdout = processId === undefined ? "" : yield* readScrollback(runId, processId, "stdout");
    const stderr = processId === undefined ? "" : yield* readScrollback(runId, processId, "stderr");

    const changes = toRunChangesData(yield* getRunChangesOp(runId));
    return {
      exitCode: wire.exitCode ?? -1,
      stdout,
      stderr,
      run: makeRun(ctx, { wire, changes }),
    } satisfies WorkspaceExecResult;
  });

/** The `workspace.exec()` implementation (Promise boundary over the Effect above). */
export const execWorkspace = (
  ctx: SdkContext,
  init: WorkspaceInit,
  argv: readonly string[],
  options?: WorkspaceExecOptions,
): Promise<WorkspaceExecResult> => ctx.runtime.run(execWorkspaceEffect(ctx, init, argv, options));
