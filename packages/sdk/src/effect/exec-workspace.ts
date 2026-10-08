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
import { Duration, Effect } from "effect";

import { SealantError } from "../errors.js";
import type { SdkContext } from "../facade/context.js";
import { makeRun, toRunChangesData } from "../facade/run.js";
import type { WorkspaceInit } from "../facade/workspace.js";
import type { WorkspaceExecOptions, WorkspaceExecResult } from "../types.js";
import {
  execWorkspaceAsUserOp,
  execWorkspaceOp,
  getRunChangesOp,
  getRunOp,
  getRunScrollbackOp,
  getRunTimelineOp,
} from "./operations.js";
import { retryRead } from "./read-retry.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
/**
 * When the run is read next. A small exec ends 70-110 ms after it is registered, and a launch runs a
 * dozen or more of them in a row, so for its first half second the run is read every 25 ms: a result
 * is seen within about 25 ms of the run ending. Doubling from 25 ms read it at 25, 75, 175 and
 * 375 ms, so an exec that ended at 80 ms was seen at 175 ms, and 20 ms more on every exec cost
 * 100 ms each. Until 2 s the waits then double from 50 ms up to 250 ms, and after that up to 500 ms:
 * an exec that runs for seconds is read about twice a second.
 */
const POLL_MS = 25;
const POLL_STEADY_FOR_MS = 500;
const POLL_SOON_FOR_MS = 2_000;
const MAX_SOON_POLL_MS = 250;
const MAX_POLL_MS = 500;
const EXEC_TIMEOUT_MS = 30 * 60 * 1_000;

/** The wait before the next read, given the last wait and the time since the run was registered. */
export const nextExecPollMs = (lastWaitMs: number | undefined, elapsedMs: number): number => {
  if (elapsedMs < POLL_STEADY_FOR_MS) return POLL_MS;
  const doubled = lastWaitMs === undefined || lastWaitMs <= POLL_MS ? POLL_MS * 2 : lastWaitMs * 2;
  return Math.min(doubled, elapsedMs < POLL_SOON_FOR_MS ? MAX_SOON_POLL_MS : MAX_POLL_MS);
};

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

const readScrollback = (
  runId: string,
  ownerUserId: string,
  processId: string,
  stream: "stdout" | "stderr",
  deadline: number,
) =>
  Effect.map(
    retryRead(getRunScrollbackOp(runId, { ownerUserId, processId, stream }), {
      runId,
      what: stream,
      deadline,
    }),
    (response) => Buffer.from(response.contentBase64, "base64").toString("utf8"),
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

    const request = {
      ownerUserId: ctx.config.hostLocal.ownerUserId,
      commands: [{ executable, args, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) }],
    };
    // As a user: its own route, so a control plane that cannot run one answers 404, never runs it
    // as the workspace's own user.
    const created = yield* options?.user === undefined
      ? execWorkspaceOp(init.id, request)
      : execWorkspaceAsUserOp(init.id, { ...request, user: options.user });
    const runId = created.runId;

    // Block until the check run is terminal, polling the control plane (same shape as harness.run()).
    const registeredAt = Date.now();
    const deadline = registeredAt + EXEC_TIMEOUT_MS;
    let wire = created;
    let wait: number | undefined;
    while (!TERMINAL_STATUSES.has(wire.status)) {
      if (Date.now() > deadline) {
        return yield* Effect.fail(
          new SealantError(`Timed out waiting for exec run ${runId} to complete.`, {
            code: "exec_timeout",
          }),
        );
      }
      wait = nextExecPollMs(wait, Date.now() - registeredAt);
      yield* Effect.sleep(Duration.millis(wait));
      // One refused or lost read is read again; the run goes on either way.
      wire = yield* retryRead(getRunOp(runId, ctx.config.hostLocal.ownerUserId), {
        runId,
        what: "the state",
        deadline,
      });
    }

    // Exec framing: "completed" means every command executed and was recorded — anything else means
    // the machinery broke and the exit code cannot be trusted, which IS the error case.
    if (wire.status !== "completed") {
      return yield* Effect.fail(
        new SealantError(
          `Workspace exec run ${runId} did not complete: ${wire.errorMessage ?? `it is ${wire.status}`}`,
          { code: "exec_failed" },
        ),
      );
    }

    // Every record read names the owner: the control plane finds nothing for a read that does not.
    const ownerUserId = ctx.config.hostLocal.ownerUserId;
    const started = yield* retryRead(
      getRunTimelineOp(runId, { ownerUserId, kinds: "processStarted" }),
      { runId, what: "the timeline", deadline },
    );
    const processId = findCommandProcessId(started, executable);
    // The three reads are independent: one round trip of waiting, not three.
    const [stdout, stderr, wireChanges] = yield* Effect.all(
      [
        processId === undefined
          ? Effect.succeed("")
          : readScrollback(runId, ownerUserId, processId, "stdout", deadline),
        processId === undefined
          ? Effect.succeed("")
          : readScrollback(runId, ownerUserId, processId, "stderr", deadline),
        retryRead(getRunChangesOp(runId, ownerUserId), { runId, what: "the changes", deadline }),
      ],
      { concurrency: "unbounded" },
    );
    const changes = toRunChangesData(wireChanges);
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
