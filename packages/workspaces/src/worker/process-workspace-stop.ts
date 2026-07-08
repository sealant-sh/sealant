import {
  SealantDB,
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
  type WorkspaceRuntimeInstanceStopReason,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { swallowingFailure as sharedSwallowingFailure } from "./errors.js";

export interface ProcessWorkspaceStopEffectOptions {
  /**
   * The workspace whose stored status should settle to "stopped" once the runtime is gone.
   * Absent for ORPHANED instances (workspace row already deleted) — the reaper still tears the
   * container down, there is just no row left to settle.
   */
  readonly workspaceId?: string;
  /** The attempt whose runtime instance is being stopped. */
  readonly runId: string;
  readonly stopReason: WorkspaceRuntimeInstanceStopReason;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
}

export interface ProcessWorkspaceStopOptions extends ProcessWorkspaceStopEffectOptions {
  readonly db: DB;
}

export class WorkspaceStopProcessingError extends Error {
  public override readonly name = "WorkspaceStopProcessingError";

  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}

const toWorkspaceStopProcessingError = (cause: unknown): WorkspaceStopProcessingError => {
  if (cause instanceof WorkspaceStopProcessingError) {
    return cause;
  }
  return new WorkspaceStopProcessingError(
    cause instanceof Error ? cause.message : "Workspace stop failed.",
    { cause },
  );
};

const swallowingFailure = (operation: string) =>
  sharedSwallowingFailure("Workspace stop", operation);

/**
 * Stop one workspace runtime: remove the container via the runtime adapter, then record the
 * terminal state (`markStopped` on the instance + workspace stored status "stopped").
 *
 * Ordering is deliberate: the adapter stop comes FIRST, and its failure aborts the status writes —
 * recording "stopped" while the container still runs would leak it forever. The reverse gap
 * (container removed, then the process dies before the writes) self-heals: the message is
 * redelivered or the reaper re-drives it, and the adapter stop is idempotent (`not-found` =
 * success).
 *
 * The workspace row settles to "stopped" ONLY while this run is still the workspace's
 * `latestRunId`. A restart supersedes the old runtime with a new attempt — its stop half must
 * not stamp "stopped" onto a workspace that is already relaunching (the reaper treats a live
 * container on a stored-"stopped" workspace as stranded and would kill the fresh runtime).
 */
export const processWorkspaceStopEffect = Effect.fn("processWorkspaceStop")(function* (
  options: ProcessWorkspaceStopEffectOptions,
) {
  const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
  const workspaces = yield* WorkspaceRepo;

  const settleWorkspaceRow = Effect.gen(function* () {
    if (options.workspaceId === undefined) {
      return;
    }
    const workspace = yield* workspaces.getWorkspaceById(options.workspaceId);
    if (workspace === undefined || workspace.latestRunId !== options.runId) {
      return;
    }
    yield* workspaces.setWorkspaceStatus({ id: options.workspaceId, status: "stopped" });
  }).pipe(swallowingFailure("workspace-status update"));

  const instance = yield* runtimeInstances
    .getRuntimeInstanceByRunId(options.runId)
    .pipe(Effect.mapError(toWorkspaceStopProcessingError));

  if (instance === undefined) {
    // Nothing was ever launched for this run; still settle the workspace row (guarded above) so a
    // stop requested against a stranded workspace converges instead of looping through the DLQ.
    yield* settleWorkspaceRow;
    return;
  }

  const { adapter: adapterId, resourceId, reference } = instance;
  if (instance.status !== "stopped" && adapterId !== null && resourceId !== null) {
    const adapter = options.runtimeAdapters.find((candidate) => candidate.id === adapterId);
    if (adapter === undefined) {
      return yield* Effect.fail(
        new WorkspaceStopProcessingError(
          `No runtime adapter is registered for '${adapterId}' (run ${options.runId}).`,
        ),
      );
    }

    yield* Effect.tryPromise({
      try: () =>
        adapter.stop({
          resourceId,
          ...(reference === null ? {} : { reference }),
        }),
      catch: toWorkspaceStopProcessingError,
    });
  }

  yield* runtimeInstances
    .markStopped({ runId: options.runId, stopReason: options.stopReason })
    .pipe(Effect.mapError(toWorkspaceStopProcessingError));

  yield* settleWorkspaceRow;
});

export const processWorkspaceStop = async (options: ProcessWorkspaceStopOptions): Promise<void> => {
  const { db, ...effectOptions } = options;

  const dataAccessLayer = Layer.mergeAll(WorkspaceRepoLive, WorkspaceRuntimeInstanceRepoLive).pipe(
    Layer.provide(Layer.succeed(SealantDB, db)),
  );

  await Effect.runPromise(
    processWorkspaceStopEffect(effectOptions).pipe(Effect.provide(dataAccessLayer)),
  );
};
