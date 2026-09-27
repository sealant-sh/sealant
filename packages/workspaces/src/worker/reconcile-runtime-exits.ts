/**
 * Runtime exit reconciler: the control plane's answer to a container or Pod that died without
 * being asked to. A `ready` runtime instance stays `ready` until something writes otherwise, and
 * until this module nothing did — a `docker kill` left the workspace reported reachable for as long
 * as it took a client to notice on its own.
 *
 * Two feeds converge on the same write:
 *
 *  - **watch** — adapters that can push exits (`RuntimeAdapter.watchExits`; Docker's `docker
 *    events`, a Kubernetes Pod watch) report each one as the runtime announces it, and the
 *    reconciler checks that one resource after a short grace.
 *  - **poll** — every `WORKSPACE_RUNTIME_EXIT_POLL_INTERVAL_MS` the reconciler asks each adapter
 *    (`RuntimeAdapter.inspect`) about every `ready` instance it owns. This is the convergence net
 *    behind every stream (an exit announced while a stream was down is never replayed) and the
 *    only feed for runtimes that can only be polled.
 *
 * An exited or missing runtime is recorded the way the launch path records a container that died
 * during boot: the instance goes `failed` with `errorCode` `runtime-exited` and a message carrying
 * the exit code and the runtime's post-mortem — the terminal state `resolveWorkspaceStatus` reports
 * as `failed`. The write is fenced (`markExited`: `ready` on the observed resource only), so a stop
 * that already settled the row, or a relaunch that replaced the resource, is never overwritten;
 * the runtime's remains are then removed through the adapter's idempotent stop, and the worker's
 * staged launch material for the run is dropped, exactly as a stop would.
 *
 * The workspace row's stored status is left alone, as the launch failure path leaves it: it is
 * the API's intent anchor (`stopped`, `queued`), not the reported status.
 *
 * **No loss of work product.** A capture-sourced runtime (sealantd ADR-0015) holds captures
 * nowhere else until its queue is empty. With `captureDrain`, before an exit is recorded the
 * reconciler asks the daemon one `capture.status`: a daemon that does not answer is the crash the
 * runtime reported, and the exit is recorded as before; a daemon that answers means the runtime is
 * not dead, so it is drained first (`capture-drain.ts`) and the exit recorded and the remains
 * removed only once the queue is empty. A queue still moving is revisited next sweep; a stalled
 * one is left untouched and logged `not saved · kept`. A runtime reported `running` with a
 * `detail` (a guest service failed, the executor survived) is reported, never removed.
 */
import {
  SealantDB,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import {
  hostDirectoryLaunchMaterialStager,
  type LaunchMaterialStager,
} from "../runtime/launch-material.js";
import type {
  RuntimeAdapter,
  RuntimeAdapterExitWatch,
  RuntimeAdapterInspectResult,
} from "../runtime/runtime-adapter.js";
import { SealantRuntimeControlLive } from "../sealantd/runtime.js";
import {
  sealantTargetForRuntimeInstance,
  type SealantTargetDerivationOptions,
} from "../sealantd/target.js";
import {
  captureDaemonAnswers,
  drainCaptureBeforeStop,
  drainPermitsStop,
  isCaptureSourcedBlueprint,
  type CaptureDrainSettings,
  type CaptureDrainTracker,
} from "./capture-drain.js";

export interface ReconcileRuntimeExitsEffectOptions {
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  /** Check only these runtime resources (an exit event names one); absent = every `ready` instance. */
  readonly resourceIds?: readonly string[];
  /** Where this worker staged launch material; defaults to host directories (Docker). */
  readonly launchMaterialStager?: LaunchMaterialStager;
  /** How this worker reaches each runtime family's daemon; needed for the capture drain. */
  readonly targetOptions?: SealantTargetDerivationOptions;
  /**
   * Drain a capture-sourced runtime whose daemon still answers before recording its exit and
   * removing it. Absent = record and remove at once (the pre-drain behaviour).
   */
  readonly captureDrain?: {
    readonly tracker: CaptureDrainTracker;
    readonly settings: CaptureDrainSettings;
    /** How long one sweep may wait on one runtime's queue before moving on. */
    readonly budgetMs?: number;
  };
}

/** One sweep waits at most this long on one runtime's queue; the next sweep continues. */
const DEFAULT_DRAIN_BUDGET_PER_SWEEP_MS = 30_000;
/** The single "is anyone there" probe before an exit is recorded. */
const DAEMON_PROBE_TIMEOUT_MS = 10_000;

/**
 * A lifetime-capped runtime (Lambda MicroVM) that ended at or past its deadline was ended by the
 * platform, whatever state its capture queue was in. Nothing can drain it any more; say so loudly.
 */
const HARD_CAP_SLACK_MS = 60_000;

export interface ReconcileRuntimeExitsOptions extends ReconcileRuntimeExitsEffectOptions {
  readonly db: DB;
}

type RuntimeEnd = Exclude<RuntimeAdapterInspectResult, { readonly state: "running" }>;

const describeExit = (instance: WorkspaceRuntimeInstance, end: RuntimeEnd): string => {
  const name = instance.reference ?? instance.resourceId ?? instance.runId;
  if (end.state === "missing") {
    return `Workspace runtime '${name}' is gone: the runtime no longer knows it, and no stop was requested.`;
  }
  const exitCode = end.exitCode === undefined ? "unknown" : String(end.exitCode);
  const detail = end.detail === undefined ? "" : ` ${end.detail}`;
  return `Workspace runtime '${name}' exited on its own (exitCode: ${exitCode}).${detail}`;
};

/** Concurrent `inspect` calls per adapter in one sweep (Docker spawns a CLI per call). */
const INSPECT_CONCURRENCY = 16;

const swallowingFailure = (operation: string, runId: string) =>
  Effect.catchCause((cause) =>
    Effect.logWarning(`Runtime exit reconciler: ${operation} for run ${runId} failed.`, cause),
  );

/**
 * Sweep the `ready` runtime instances (or the named resources) and record every runtime that
 * exited or vanished. Returns how many instances were recorded. Best-effort per adapter and per
 * instance: one failure never aborts the sweep.
 */
export const reconcileRuntimeExitsEffect = Effect.fn("reconcileRuntimeExits")(function* (
  options: ReconcileRuntimeExitsEffectOptions,
) {
  const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
  const stager = options.launchMaterialStager ?? hostDirectoryLaunchMaterialStager;

  const wanted = options.resourceIds === undefined ? undefined : new Set(options.resourceIds);
  const live = (yield* runtimeInstances.listRunningInstances()).filter(
    (instance) =>
      instance.resourceId !== null &&
      instance.adapter !== null &&
      (wanted === undefined || wanted.has(instance.resourceId)),
  );
  if (live.length === 0) {
    return 0;
  }

  let recorded = 0;
  for (const adapter of options.runtimeAdapters) {
    const inspect = adapter.inspect;
    if (inspect === undefined) {
      continue;
    }
    const owned = live.filter((instance) => instance.adapter === adapter.id);
    if (owned.length === 0) {
      continue;
    }

    // One `inspect` per instance, concurrently: a Kubernetes adapter coalesces the burst into one
    // LIST; a Docker adapter runs one CLI per container. A failed read leaves that instance alone
    // this sweep — never a guess at its state.
    const inspections = yield* Effect.forEach(
      owned,
      (instance) =>
        Effect.tryPromise(() =>
          inspect.call(adapter, { resourceId: instance.resourceId ?? "" }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `Runtime exit reconciler: inspecting ${adapter.id} runtime ${instance.resourceId ?? ""} failed.`,
              cause,
            ).pipe(Effect.as(undefined)),
          ),
        ),
      { concurrency: INSPECT_CONCURRENCY },
    );

    for (const [index, instance] of owned.entries()) {
      const resourceId = instance.resourceId;
      if (resourceId === null) {
        continue;
      }
      const inspection = inspections[index];
      if (inspection === undefined) {
        continue;
      }
      if (inspection.state === "running") {
        if (inspection.detail !== undefined) {
          // A guest service failed but the executor (and its daemon) did not: reported, never
          // removed — the work on it is intact and still reachable.
          yield* Effect.logWarning(
            `Runtime exit reconciler: run ${instance.runId} (${adapter.id} ${resourceId}) is running with a failed guest service; left running. ${inspection.detail}`,
          );
        }
        continue;
      }

      const drained = yield* drainBeforeRecording(options, instance, adapter);
      if (!drained) {
        continue;
      }
      yield* reportHardCap(instance, inspection);

      const exited = yield* runtimeInstances
        .markExited({
          runId: instance.runId,
          resourceId,
          errorMessage: describeExit(instance, inspection),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `Runtime exit reconciler: recording the exit of run ${instance.runId} failed.`,
              cause,
            ).pipe(Effect.as(undefined)),
          ),
        );
      if (exited === undefined) {
        // Fenced out: a stop settled the row first, or a relaunch replaced the resource.
        continue;
      }
      recorded += 1;
      yield* Effect.logInfo(
        `Runtime exit reconciler: run ${instance.runId} (${adapter.id} ${resourceId}) ${
          inspection.state === "missing"
            ? "is gone"
            : `exited with ${inspection.exitCode ?? "an unknown code"}`
        }; recorded failed.`,
      );

      // The remains: an exited container keeps its filesystem and any sidecar; a dead Pod keeps
      // its Service and Secrets. The adapter stop is idempotent (`not-found` = already gone).
      yield* Effect.tryPromise(() =>
        adapter.stop({
          resourceId,
          ...(instance.reference === null ? {} : { reference: instance.reference }),
        }),
      ).pipe(swallowingFailure("removing the exited runtime", instance.runId));
      yield* Effect.tryPromise(() => stager.removeAll(instance.runId)).pipe(
        swallowingFailure("removing staged launch material", instance.runId),
      );
      options.captureDrain?.tracker.forget(instance.runId);
    }
  }

  return recorded;
});

/**
 * Before an exit is recorded: whether the reconciler may go ahead. True for everything that is not
 * a capture-sourced runtime whose daemon still answers; for one that does, true only once its
 * capture queue drained. Never fails — a failed read of the blueprint leaves the instance alone
 * this sweep.
 */
const drainBeforeRecording = (
  options: ReconcileRuntimeExitsEffectOptions,
  instance: WorkspaceRuntimeInstance,
  adapter: RuntimeAdapter,
) =>
  Effect.gen(function* () {
    const drain = options.captureDrain;
    if (drain === undefined) {
      return true;
    }
    const target = sealantTargetForRuntimeInstance(instance, options.targetOptions ?? {});
    if (target === undefined) {
      return true;
    }
    const attempts = yield* WorkspaceAttemptRepo;
    const snapshot = yield* attempts.getAttemptSnapshotByRunId(instance.runId);
    if (snapshot === undefined || !isCaptureSourcedBlueprint(snapshot.blueprintPayload)) {
      return true;
    }
    if (!(yield* captureDaemonAnswers(target, DAEMON_PROBE_TIMEOUT_MS))) {
      return true;
    }
    yield* Effect.logWarning(
      `Runtime exit reconciler: ${adapter.id} reports run ${instance.runId} ended, but its sealantd still answers; draining its captures before anything is recorded or removed.`,
    );
    const outcome = yield* drainCaptureBeforeStop({
      runId: instance.runId,
      target,
      tracker: drain.tracker,
      settings: drain.settings,
      budgetMs: drain.budgetMs ?? DEFAULT_DRAIN_BUDGET_PER_SWEEP_MS,
      label: "exit reconciler",
      runtimeEnded: runtimeReportsEnded(adapter, instance.resourceId ?? ""),
    });
    return drainPermitsStop(outcome);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Runtime exit reconciler: checking the capture queue of run ${instance.runId} failed; leaving it for the next sweep.`,
        cause,
      ).pipe(Effect.as(false)),
    ),
  );

/** A fresh `inspect`: true only on a positive exited/missing answer; unknown is false. */
const runtimeReportsEnded = (
  adapter: RuntimeAdapter,
  resourceId: string,
): Effect.Effect<boolean> => {
  const inspect = adapter.inspect;
  if (inspect === undefined) {
    return Effect.succeed(false);
  }
  return Effect.tryPromise(() => inspect.call(adapter, { resourceId })).pipe(
    Effect.map((result) => result.state !== "running"),
    Effect.catchCause(() => Effect.succeed(false)),
  );
};

/** Log, loudly, a capped runtime the platform ended at its deadline. */
const reportHardCap = (instance: WorkspaceRuntimeInstance, end: RuntimeEnd) => {
  const deadline = instance.runtimeDeadlineAt;
  if (deadline === null || Date.now() < deadline.getTime() - HARD_CAP_SLACK_MS) {
    return Effect.void;
  }
  return Effect.logError(
    `Runtime exit reconciler: run ${instance.runId} reached its platform lifetime cap (deadline ${deadline.toISOString()}) and the platform ended it (${end.state === "exited" ? (end.detail ?? "no reason given") : "gone"}). Any capture still queued on it when the cap hit is lost; the drain must be planned before the deadline.`,
  );
};

export const reconcileRuntimeExits = async (
  options: ReconcileRuntimeExitsOptions,
): Promise<number> => {
  const { db, ...effectOptions } = options;
  const dataAccessLayer = Layer.mergeAll(
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceAttemptRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));
  return Effect.runPromise(
    reconcileRuntimeExitsEffect(effectOptions).pipe(
      Effect.provide(Layer.mergeAll(dataAccessLayer, SealantRuntimeControlLive)),
    ),
  );
};

export interface WatchRuntimeExitsOptions extends ReconcileRuntimeExitsOptions {
  /**
   * How long after an exit event the resource is checked. A stop the control plane requested
   * announces the same `die` — the stop path's own `markStopped` lands within this window, so the
   * instance settles `stopped` (its true outcome) rather than flashing `failed` first. Default 2 s.
   */
  readonly exitGraceMs?: number;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_EXIT_GRACE_MS = 2_000;

/**
 * Subscribe to every adapter that can push exits and reconcile the named resource after each one.
 * Returns a handle that closes every subscription; pending checks still complete.
 */
export const watchRuntimeExits = (options: WatchRuntimeExitsOptions): RuntimeAdapterExitWatch => {
  const { exitGraceMs, onError, ...reconcileOptions } = options;
  const grace = exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
  const timers = new Set<NodeJS.Timeout>();
  const watches: RuntimeAdapterExitWatch[] = [];

  for (const adapter of options.runtimeAdapters) {
    if (adapter.watchExits === undefined) {
      continue;
    }
    watches.push(
      // No `resourceIds`: the watch outlives every instance launched during the process, so it
      // covers everything the adapter manages and the sweep filters to rows this worker owns.
      adapter.watchExits({
        onExit: (event) => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            reconcileRuntimeExits({ ...reconcileOptions, resourceIds: [event.resourceId] }).catch(
              (error: unknown) => onError?.(error),
            );
          }, grace);
          timer.unref();
          timers.add(timer);
        },
        ...(onError === undefined ? {} : { onError: (error: unknown) => onError(error) }),
      }),
    );
  }

  return {
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const watch of watches) watch.close();
    },
  };
};
