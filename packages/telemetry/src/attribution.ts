/**
 * Per-event run attribution — the seam that lets ONE daemon telemetry stream feed MANY runs.
 *
 * Clients that start work in a workspace (the run-exec worker for harness runs, the SSH gateway for
 * interactive sessions) thread their run id through the daemon as the `execution_id`, and the
 * daemon stamps it on every descendant event. At ingest, an event whose `executionId` names a run
 * in the SAME workspace as the connection's default run is attributed to that run; everything else
 * (daemon boot, heartbeats, untagged executions) falls back to the default run — exactly the
 * pre-attribution behavior.
 *
 * The workspace check is the authorization boundary: execution ids are client-supplied inside the
 * workspace, so without it a process could label its events into another workspace's run.
 */
import { runs, SealantDB, type TSealantDB } from "@sealant/db";
import { eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import type { NormalizedEvent } from "./types.js";

/** Pure: stamp `attributedRunId` onto each event its resolution map covers. */
export const attributeBatch = (
  batch: readonly NormalizedEvent[],
  resolutions: ReadonlyMap<string, string>,
): NormalizedEvent[] =>
  batch.map((event) => {
    const runId = event.executionId === undefined ? undefined : resolutions.get(event.executionId);
    return runId === undefined ? event : { ...event, attributedRunId: runId };
  });

/** Pure: the distinct execution ids in a batch (the resolver's query set). */
export const collectExecutionIds = (batch: readonly NormalizedEvent[]): Set<string> => {
  const ids = new Set<string>();
  for (const event of batch) {
    if (event.executionId !== undefined && event.executionId.length > 0) {
      ids.add(event.executionId);
    }
  }
  return ids;
};

export interface ExecutionRunResolverService {
  /**
   * Map execution ids to run ids valid for attribution alongside `defaultRunId` (same workspace).
   * Unknown / foreign-workspace ids are simply absent from the result. Never fails: a lookup error
   * degrades to "no attributions" (events fall back to the default run) so ingest keeps flowing.
   */
  readonly resolve: (input: {
    readonly defaultRunId: string;
    readonly executionIds: ReadonlySet<string>;
  }) => Effect.Effect<ReadonlyMap<string, string>>;
}

export class ExecutionRunResolver extends Context.Service<
  ExecutionRunResolver,
  ExecutionRunResolverService
>()("@sealant/telemetry/ExecutionRunResolver") {}

export const makeExecutionRunResolver = (db: TSealantDB): ExecutionRunResolverService => ({
  resolve: (input) =>
    Effect.gen(function* () {
      const ids = [...input.executionIds];
      if (ids.length === 0) {
        return new Map<string, string>();
      }
      const [defaultRun] = yield* db
        .select({ workspaceId: runs.workspaceId })
        .from(runs)
        .where(eq(runs.id, input.defaultRunId))
        .limit(1);
      if (defaultRun === undefined) {
        return new Map<string, string>();
      }
      const candidates = yield* db
        .select({ id: runs.id, workspaceId: runs.workspaceId })
        .from(runs)
        .where(inArray(runs.id, ids));
      return new Map(
        candidates
          .filter((candidate) => candidate.workspaceId === defaultRun.workspaceId)
          .map((candidate) => [candidate.id, candidate.id]),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Execution-run attribution lookup failed; falling back.", cause).pipe(
          Effect.as(new Map<string, string>()),
        ),
      ),
    ),
});

export const ExecutionRunResolverLive = Layer.effect(
  ExecutionRunResolver,
  Effect.gen(function* () {
    const db = yield* SealantDB;
    return makeExecutionRunResolver(db);
  }),
);
