/**
 * Stranded launches: an executor that STARTED while the worker launching it died (or was
 * interrupted) before the launch's terminal write. The launch recorded the executor's identity as
 * soon as it existed (`onStarted`, `pending` with a `resource_id`), under a launch ownership lease
 * the launching worker renews (`workspace_runtime_instances.launch_owner`). Its build job was
 * already `succeeded`, so neither the stale-job reaper nor a redelivery ever looks at it again,
 * and every other sweep keys on `ready` or a retained row. Without this sweep such an executor
 * would sit outside every preservation path until its platform ended it.
 *
 * This sweep finds every `pending` row that names an executor and whose launch ownership lapsed
 * (a row written before ownership existed: one that names no owner and has not moved for a grace
 * period), and adopts it atomically as a RETAINED launch — `failed` with
 * `LAUNCH_RETAINED_ERROR_CODE`, identity kept — exactly the record a launch that failed after its
 * executor started leaves. From there the paths that already exist take it: the retained-launch
 * sweep drains it (FINAL flush) and stops it only once its work is confirmed saved; the deadline
 * sweep drives it before a platform deadline; and an executor that already ENDED is recorded
 * retained here at once (its disk may hold work nothing saved), so recovery restarts it. The
 * attempt is marked failed, as the launching worker's own failure cleanup would have.
 *
 * It runs with the exit reconciler (at worker boot and on every poll), so a worker restart
 * catches up on everything its predecessor left.
 */
import {
  DEFAULT_UNOWNED_LAUNCH_GRACE_MS,
  WorkspaceAttemptRepo,
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Effect } from "effect";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { runIsCaptureSourced, type CaptureDrainLedger } from "./capture-drain.js";

export interface AdoptStrandedLaunchesOptions {
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  /** Only these runtime resources (an exit event names one); absent = every stranded launch. */
  readonly resourceIds?: readonly string[];
  /** Records an adopted executor that already ended as retained, so recovery takes it. */
  readonly ledger?: CaptureDrainLedger;
  /** How long an ownerless `pending` row (written before ownership existed) must stand still. */
  readonly unownedGraceMs?: number;
}

const describe = (instance: WorkspaceRuntimeInstance): string =>
  `${instance.adapter ?? "unknown runtime"} ${instance.resourceId ?? instance.runId}`;

/**
 * Adopt every stranded launch as retained. Returns the run ids adopted. Best-effort per launch:
 * one failure never aborts the sweep.
 */
export const adoptStrandedLaunchesEffect = Effect.fn("adoptStrandedLaunches")(function* (
  options: AdoptStrandedLaunchesOptions,
) {
  const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
  const attempts = yield* WorkspaceAttemptRepo;
  const unownedGraceMs = options.unownedGraceMs ?? DEFAULT_UNOWNED_LAUNCH_GRACE_MS;
  const wanted = options.resourceIds === undefined ? undefined : new Set(options.resourceIds);

  const stranded = (yield* runtimeInstances.listStrandedLaunches({ unownedGraceMs })).filter(
    (instance) =>
      instance.resourceId !== null && (wanted === undefined || wanted.has(instance.resourceId)),
  );

  const adopted: string[] = [];
  for (const instance of stranded) {
    const runId = instance.runId;
    const done = yield* Effect.gen(function* () {
      const row = yield* runtimeInstances.adoptStrandedLaunch({
        runId,
        unownedGraceMs,
        errorMessage: `The executor (${describe(instance)}) started, and the worker launching it was lost before the launch finished. It was kept as a retained launch so no work is lost: it is drained and stopped once its work is confirmed saved.`,
      });
      if (row === undefined) {
        // Its launching worker renewed its ownership, or another sweep adopted it first.
        return false;
      }
      yield* attempts
        .markAttemptFailed({ id: runId })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `Stranded launch: marking run ${runId}'s attempt failed failed.`,
              cause,
            ),
          ),
        );
      yield* Effect.logError(
        `Stranded launch: run ${runId} (${describe(row)}) started and the worker launching it was lost before it was ready; adopted as a retained launch (not saved · retained). It is drained before it is stopped, preserved before its deadline, and recovered if it ended.`,
      );

      // What the runtime says of it now: an executor that already ended keeps its disk, which
      // holds work nothing confirmed saved — retained at once, so recovery reaches it.
      const ledger = options.ledger;
      const adapter = options.runtimeAdapters.find((candidate) => candidate.id === row.adapter);
      const inspect = adapter?.inspect;
      if (ledger === undefined || adapter === undefined || inspect === undefined) {
        return true;
      }
      const captureSourced = yield* runIsCaptureSourced({
        runId,
        sourceKind: row.sourceKind,
        readSnapshotPayload: Effect.suspend(() => attempts.getAttemptSnapshotByRunId(runId)),
      });
      if (!captureSourced) {
        return true;
      }
      const state = yield* Effect.tryPromise(() =>
        inspect.call(adapter, { resourceId: row.resourceId ?? "" }),
      ).pipe(
        Effect.map((result) => result.state),
        Effect.catchCause(() => Effect.succeed("running" as const)),
      );
      if (state === "exited") {
        yield* ledger.markRetained(
          runId,
          "its launch was stranded (the launching worker was lost) and the executor ended",
        );
      }
      return true;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Stranded launch: adopting run ${runId} failed; the next sweep retries.`,
          cause,
        ).pipe(Effect.as(false)),
      ),
    );
    if (done) {
      adopted.push(runId);
    }
  }
  return adopted;
});
