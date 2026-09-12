/**
 * Runtime exit reconciler: the control plane's answer to a container or Pod that died without
 * being asked to. A `ready` runtime instance stays `ready` until something writes otherwise, and
 * until this module nothing did — a `docker kill` left the workspace reported reachable for as long
 * as it took a client to notice on its own.
 *
 * Two feeds converge on the same write:
 *
 *  - **watch** — adapters that can push exits (`RuntimeAdapter.watchExits`; Docker's `docker
 *    events`) report each one as the runtime announces it, and the reconciler checks that one
 *    resource after a short grace.
 *  - **poll** — every `WORKSPACE_RUNTIME_EXIT_POLL_INTERVAL_MS` the reconciler asks each adapter
 *    (`RuntimeAdapter.inspect`) about every `ready` instance it owns. This is the only feed on
 *    Kubernetes and the convergence net behind Docker's stream (an exit announced while the
 *    stream was down is never replayed).
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
 */
import {
  SealantDB,
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
  RuntimeAdapterInspection,
  RuntimeExitWatch,
} from "../runtime/runtime-adapter.js";

export interface ReconcileRuntimeExitsEffectOptions {
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  /** Check only these runtime resources (an exit event names one); absent = every `ready` instance. */
  readonly resourceIds?: readonly string[];
  /** Where this worker staged launch material; defaults to host directories (Docker). */
  readonly launchMaterialStager?: LaunchMaterialStager;
}

export interface ReconcileRuntimeExitsOptions extends ReconcileRuntimeExitsEffectOptions {
  readonly db: DB;
}

type RuntimeEnd = Exclude<RuntimeAdapterInspection, { readonly state: "running" }>;

const describeExit = (instance: WorkspaceRuntimeInstance, end: RuntimeEnd): string => {
  const name = instance.reference ?? instance.resourceId ?? instance.runId;
  if (end.state === "missing") {
    return `Workspace runtime '${name}' is gone: the runtime no longer knows it, and no stop was requested.`;
  }
  const exitCode = end.exitCode === undefined ? "unknown" : String(end.exitCode);
  return `Workspace runtime '${name}' exited on its own (exitCode: ${exitCode}). ${end.detail}`;
};

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

    const inspections = yield* Effect.tryPromise(() =>
      inspect.call(
        adapter,
        owned.flatMap((instance) => (instance.resourceId === null ? [] : [instance.resourceId])),
      ),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Runtime exit reconciler: inspecting ${adapter.id} runtimes failed.`,
          cause,
        ).pipe(Effect.as(undefined)),
      ),
    );
    if (inspections === undefined) {
      continue;
    }

    for (const instance of owned) {
      const resourceId = instance.resourceId;
      if (resourceId === null) {
        continue;
      }
      const inspection = inspections.get(resourceId);
      if (inspection === undefined || inspection.state === "running") {
        continue;
      }

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
    }
  }

  return recorded;
});

export const reconcileRuntimeExits = async (
  options: ReconcileRuntimeExitsOptions,
): Promise<number> => {
  const { db, ...effectOptions } = options;
  return Effect.runPromise(
    reconcileRuntimeExitsEffect(effectOptions).pipe(
      Effect.provide(
        WorkspaceRuntimeInstanceRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db))),
      ),
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
export const watchRuntimeExits = (options: WatchRuntimeExitsOptions): RuntimeExitWatch => {
  const { exitGraceMs, onError, ...reconcileOptions } = options;
  const grace = exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
  const timers = new Set<NodeJS.Timeout>();
  const watches: RuntimeExitWatch[] = [];

  for (const adapter of options.runtimeAdapters) {
    if (adapter.watchExits === undefined) {
      continue;
    }
    watches.push(
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
        ...(onError === undefined ? {} : { onError }),
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
