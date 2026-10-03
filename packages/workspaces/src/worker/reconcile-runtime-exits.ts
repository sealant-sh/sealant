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
 * nowhere else until the daemon confirms them saved. With `captureDrain`, before an exit is
 * recorded the reconciler asks the daemon one `capture.status`. A daemon that answers means the
 * runtime is not dead, so it is drained first (`capture-drain.ts`) and the exit recorded and the
 * remains removed only once its final flush is confirmed complete; a queue still moving is
 * revisited next sweep, one that cannot be confirmed is left untouched (`not saved · kept`). A
 * daemon that does not answer leaves an ended executor WITH ITS DISK: sealantd exits 75 with its
 * staging there after an incomplete final flush, whether or not any drain reached it (a plain
 * `docker stop`, its own shutdown FINAL, a lost reply). The exit is recorded, and the remains
 * go only through the one preservation policy (`decideExecutorDeletion`): removed when Core
 * observed its final flush complete, the control plane attested a sealed final capture of it,
 * the owner discarded it, or nothing of it is left — otherwise retained (recorded; recovery is
 * attempted). A runtime reported `running` with a `detail` (a guest service failed, the executor
 * survived) is reported, never removed.
 *
 * A retained executor's retention and its terminal write (`failed`, or `stopped` for a planned
 * stop) commit in ONE transaction (`withRetention`, review 4 #5): a terminal row without its
 * retention is an executor every later sweep passes over (they key on `ready`, a retained launch
 * or a retention), so when the retention cannot be recorded neither is written and the runtime
 * stays `ready` for the next sweep. And every sweep also looks again at each ended capture
 * executor nothing settled — `failed` or `stopped` with no retention and no removal recorded,
 * whatever its earlier status (`settleUnsettledExecutors`) — so a row an older worker left in
 * that state is recovered too.
 */
import {
  DatabaseTransaction,
  DatabaseTransactionLive,
  SealantDB,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DatabaseTransactionError,
  type DB,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Effect, Layer, Option, Schema } from "effect";

import {
  decideExecutorDeletion,
  type ExecutorDeletionBasis,
} from "../runtime/executor-preservation.js";
import {
  hostDirectoryLaunchMaterialStager,
  type LaunchMaterialStager,
} from "../runtime/launch-material.js";
import type {
  RuntimeAdapter,
  RuntimeAdapterExitWatch,
  RuntimeAdapterInspectResult,
} from "../runtime/runtime-adapter.js";
import { SealantRuntimeControlLive, type SealantRuntime } from "../sealantd/runtime.js";
import {
  sealantTargetForRuntimeInstance,
  type SealantTargetDerivationOptions,
} from "../sealantd/target.js";
import { adoptStrandedLaunchesEffect } from "./adopt-stranded-launches.js";
import {
  describeDeletionBasis,
  drainCaptureBeforeStop,
  recordedDeletionEvidence,
  runIsCaptureSourced,
  probeCaptureDaemon,
  ledgerObservationRecorder,
  authorizedDeletion,
  removeUnderDeletion,
  type CaptureDrainLedger,
  type CaptureDrainSettings,
  type DeletionTicket,
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
   * removing it. Absent, a runtime whose source is capture (or cannot be read) is left untouched —
   * neither recorded nor removed, and reported: without its drain record nothing can say its disk
   * was saved, and a missing option is no evidence (review 5 #12). Every other runtime is recorded
   * and removed as before.
   */
  readonly captureDrain?: {
    readonly ledger: CaptureDrainLedger;
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
 * How close to a lifetime-capped runtime's (Lambda MicroVM) deadline an ended executor is reported
 * with its deadline (`describeCappedRuntimeEnd`). Proximity is reported, never taken as the cause.
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

  // Launches stranded by a lost worker after their executor started are observed here too: they
  // are adopted as retained launches, and one that already ended is recorded retained.
  yield* adoptStrandedLaunchesEffect({
    runtimeAdapters: options.runtimeAdapters,
    ...(options.resourceIds === undefined ? {} : { resourceIds: options.resourceIds }),
    ...(options.captureDrain === undefined ? {} : { ledger: options.captureDrain.ledger }),
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Runtime exit reconciler: the stranded-launch sweep failed.", cause),
    ),
  );

  const wanted = options.resourceIds === undefined ? undefined : new Set(options.resourceIds);
  const live = (yield* runtimeInstances.listRunningInstances()).filter(
    (instance) =>
      instance.resourceId !== null &&
      instance.adapter !== null &&
      (wanted === undefined || wanted.has(instance.resourceId)),
  );

  // The remains: an exited container keeps its filesystem and any sidecar; a dead Pod keeps its
  // Service and Secrets. The adapter stop is idempotent (`not-found` = already gone).
  // A capture executor removed here ends its drain record the way every other removal does
  // (`stopped`, with why it could go): its retention ends, and the sealed capture token kept for
  // its recovery is cleared — nothing can recover an executor that is gone.
  // A removal authorized on recorded evidence runs under its ticket (decision 21): re-checked
  // right before the runtime call; voided (newer evidence arrived), nothing is removed and the
  // unsettled sweep looks at it again.
  const removeRemains = (
    adapter: RuntimeAdapter,
    instance: WorkspaceRuntimeInstance,
    resourceId: string,
    removal: RemovalBasis,
  ) =>
    Effect.gen(function* () {
      const removed = yield* removeUnderDeletion({
        ledger: options.captureDrain?.ledger,
        runId: instance.runId,
        ticket: removal.ticket,
        remove: Effect.tryPromise(() =>
          adapter.stop({
            resourceId,
            ...(instance.reference === null ? {} : { reference: instance.reference }),
          }),
        ),
      }).pipe(
        Effect.map((outcome) => outcome.removed),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Runtime exit reconciler: removing the exited runtime for run ${instance.runId} failed.`,
            cause,
          ).pipe(Effect.as(false)),
        ),
      );
      if (removed && removal.captureSourced && options.captureDrain !== undefined) {
        yield* options.captureDrain.ledger.observe(instance.runId, {
          state: "stopped",
          detail: `the ended runtime was removed: ${describeDeletionBasis(removal.basis)}`,
        });
      }
      yield* Effect.tryPromise(() => stager.removeAll(instance.runId)).pipe(
        swallowingFailure("removing staged launch material", instance.runId),
      );
    });

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

      const decided = yield* drainBeforeRecording(options, instance, adapter, inspection);
      if (decided.verdict === "leave") {
        continue;
      }
      // A removal held for remains that end up not removed (the terminal write failed) is given
      // up, so observations of the executor resume — unless it is one issued earlier and taken
      // over (`issued-before`): that request may still act on the runtime, so it stays issued
      // and is settled from the runtime (review 9 #5).
      const giveUpRemoval = (() => {
        const removal = decided.verdict === "record" ? decided.removal : undefined;
        const ticket = removal?.ticket;
        const ledger = options.captureDrain?.ledger;
        if (ticket === undefined || ledger === undefined) {
          return Effect.void;
        }
        return removal?.basis === "issued-before"
          ? ledger.lapseIssuedDeletion(instance.runId, ticket)
          : ledger.releaseDeletion(instance.runId, ticket);
      })();
      const verdict = decided.verdict;
      // A kept executor's retention and its terminal write land together or not at all
      // (`withRetention`): a terminal row with no retention is an executor no sweep looks at
      // again, so when the retention cannot be recorded the runtime is left `ready` for the next.
      const terminally = <A, E, R>(terminal: Effect.Effect<A, E, R>) =>
        verdict === "record-keep-remains"
          ? withRetention(options.captureDrain?.ledger, instance.runId, decided.reason, terminal)
          : terminal;
      if (instance.stopReason !== null) {
        // A stop is under way for this run (`markStopRequested`): the exit is that planned stop
        // completing, not a crash. Record it stopped with the stop's reason; the stop path's own
        // `markStopped` is idempotent.
        const stopReason = instance.stopReason;
        const settled = yield* terminally(
          Effect.suspend(() => runtimeInstances.markStopped({ runId: instance.runId, stopReason })),
        ).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logError(
              `Runtime exit reconciler: recording the planned stop of run ${instance.runId} failed${
                verdict === "record-keep-remains"
                  ? " (with its retention: neither was written)"
                  : ""
              }; the runtime is left as it was for the next sweep.`,
              cause,
            ).pipe(Effect.as(false)),
          ),
        );
        if (settled) {
          recorded += 1;
          yield* Effect.logInfo(
            `Runtime exit reconciler: run ${instance.runId} (${adapter.id} ${resourceId}) ended by its planned stop (${instance.stopReason}); recorded stopped.`,
          );
          if (verdict === "record-keep-remains") {
            yield* Effect.logError(
              `Runtime exit reconciler: run ${instance.runId} (${adapter.id} ${resourceId}) ended by its planned stop without a final flush confirmed complete: not saved · executor exited · kept · ${decided.reason}. Its remains are left in place; recovery is attempted.`,
            );
          } else {
            // The remains, as below; the stop path may be removing them already (idempotent).
            yield* removeRemains(adapter, instance, resourceId, decided.removal);
          }
        } else {
          yield* giveUpRemoval;
        }
        continue;
      }
      yield* reportHardCap(instance, inspection);

      const exited = yield* terminally(
        Effect.suspend(() =>
          runtimeInstances.markExited({
            runId: instance.runId,
            resourceId,
            errorMessage: describeExit(instance, inspection),
          }),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            `Runtime exit reconciler: recording the exit of run ${instance.runId} failed${
              verdict === "record-keep-remains" ? " (with its retention: neither was written)" : ""
            }; the runtime is left \`ready\` for the next sweep.`,
            cause,
          ).pipe(Effect.as(undefined)),
        ),
      );
      if (exited === undefined) {
        // Fenced out: a stop settled the row first, or a relaunch replaced the resource.
        yield* giveUpRemoval;
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

      if (verdict === "record-keep-remains") {
        // The executor ended and nothing proves its disk saved: the exit is recorded; the remains
        // are NOT removed (the preservation policy retained them).
        yield* Effect.logError(
          `Runtime exit reconciler: run ${instance.runId} (${adapter.id} ${resourceId}) ended without a final flush confirmed complete: not saved · executor exited · kept · ${decided.reason}. Its remains are left in place; recovery is attempted.`,
        );
        continue;
      }

      yield* removeRemains(adapter, instance, resourceId, decided.removal);
    }
  }

  // Ended capture executors nothing settled (a terminal row with no retention and no removal):
  // whatever their earlier status, each is looked at again until its retention or its removal
  // is recorded.
  if (options.captureDrain !== undefined) {
    yield* settleUnsettledExecutors(options, options.captureDrain.ledger, removeRemains).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Runtime exit reconciler: the sweep of ended capture executors failed.",
          cause,
        ),
      ),
    );
  }

  // The remains of ended executors (a stop whose removal failed, a worker that died between a
  // stop's two phases): on a full poll only, never on the check of one named resource.
  if (options.resourceIds === undefined) yield* reapRemainsOf(options.runtimeAdapters);

  return recorded;
});

/**
 * How long an exited container is left before the remains sweep removes it: long enough for the
 * exit reconciler to have read a crash's post-mortem and recorded it, and for a stop's own
 * `remove` phase, which follows its `end` within seconds.
 */
const REMAINS_GRACE_MS = 5 * 60_000;

/** Every adapter that keeps remains removes those older than the grace; a failure is logged. */
const reapRemainsOf = (adapters: readonly RuntimeAdapter[]): Effect.Effect<void> =>
  Effect.forEach(
    adapters,
    (adapter) => {
      const reap = adapter.reapRemains;
      if (reap === undefined) return Effect.void;
      return Effect.tryPromise(() => reap.call(adapter, { olderThanMs: REMAINS_GRACE_MS })).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            `Runtime exit reconciler: removing the remains of ended ${adapter.id} executors failed.`,
            cause,
          ).pipe(Effect.as(0)),
        ),
        Effect.flatMap((removed) =>
          removed > 0
            ? Effect.logInfo(
                `Runtime exit reconciler: removed the remains of ${removed} ended ${adapter.id} executor(s).`,
              )
            : Effect.void,
        ),
      );
    },
    { discard: true },
  );

/** The retention a terminal write depends on could not be recorded; nothing was written. */
export class RetentionNotRecordedError extends Schema.TaggedErrorClass<RetentionNotRecordedError>()(
  "RetentionNotRecordedError",
  { runId: Schema.String },
) {}

/**
 * Record the run's executor retained, then `terminal` (the write that ends the runtime's row),
 * as ONE database transaction when the worker has one (`DatabaseTransaction`): both land, or
 * neither does. Without a ledger there is nothing to record and `terminal` runs alone; without a
 * transaction the retention is written first and `terminal` runs only once it was recorded. A
 * retention that could not be recorded fails with `RetentionNotRecordedError`, and `terminal`
 * never ran (or was rolled back). Once committed, recovery is told (`notifyRetained`).
 */
export const withRetention = <A, E, R>(
  ledger: CaptureDrainLedger | undefined,
  runId: string,
  reason: string,
  terminal: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RetentionNotRecordedError | DatabaseTransactionError, R> => {
  if (ledger === undefined) {
    return terminal;
  }
  const both = Effect.gen(function* () {
    if (!(yield* ledger.markRetained(runId, reason, { notify: false }))) {
      return yield* new RetentionNotRecordedError({ runId });
    }
    return yield* terminal;
  });
  return Effect.gen(function* () {
    const transaction = yield* Effect.serviceOption(DatabaseTransaction);
    const result = Option.isSome(transaction) ? yield* transaction.value.run(both) : yield* both;
    yield* ledger.notifyRetained?.(runId) ?? Effect.void;
    return result;
  });
};

/** How many unsettled ended executors one sweep looks at. */
const UNSETTLED_PER_SWEEP = 50;

/**
 * Every ended capture executor that nothing settled — `failed` or `stopped`, naming an executor,
 * with no retention recorded and no removal observed (`listUnsettledCaptureExecutors`) — is
 * looked at again, whatever brought it there: the runtime is asked what is left of it, and the
 * one preservation policy decides. Nothing left: recorded `gone`. Evidence it may go (an observed
 * complete final flush, an attestation, a discard) on an executor that ENDED: its remains are
 * removed. Anything else — an ended executor whose disk holds unconfirmed work, and a running one
 * (only a drain can let a running executor go) — is recorded retained, and recovery takes it. A
 * runtime that cannot say is left for the next sweep.
 */
const settleUnsettledExecutors = (
  options: ReconcileRuntimeExitsEffectOptions,
  ledger: CaptureDrainLedger,
  removeRemains: (
    adapter: RuntimeAdapter,
    instance: WorkspaceRuntimeInstance,
    resourceId: string,
    removal: RemovalBasis,
  ) => Effect.Effect<void, never, never>,
) =>
  Effect.gen(function* () {
    const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
    const unsettled = yield* runtimeInstances.listUnsettledCaptureExecutors({
      limit: UNSETTLED_PER_SWEEP,
      ...(options.resourceIds === undefined ? {} : { resourceIds: options.resourceIds }),
    });
    for (const instance of unsettled) {
      const runId = instance.runId;
      const resourceId = instance.resourceId;
      const adapter = options.runtimeAdapters.find(
        (candidate) => candidate.id === instance.adapter,
      );
      const inspect = adapter?.inspect;
      if (resourceId === null || adapter === undefined || inspect === undefined) {
        continue;
      }
      yield* Effect.gen(function* () {
        // A row that records no source kind (it predates the column) is read from its attempt
        // snapshot; one whose source cannot be read at all is treated as capture-sourced.
        const attempts = yield* WorkspaceAttemptRepo;
        const captureSourced = yield* runIsCaptureSourced({
          runId,
          sourceKind: instance.sourceKind,
          readSnapshotPayload: attempts.getAttemptSnapshotByRunId(runId),
        });
        if (!captureSourced) {
          return;
        }
        const inspection = yield* Effect.tryPromise(() => inspect.call(adapter, { resourceId }));
        // Only a drain lets a RUNNING executor go: the policy weighs recorded evidence only for
        // one that ended — as it stands after the inspection, authorized against it.
        const { decision, ticket, heldElsewhere } = yield* authorizedDeletion({
          ledger,
          runId,
          runtime: inspection.state,
          removalFenceMs: adapter.removalFenceMs,
          decide: (record) =>
            decideExecutorDeletion({
              captureSourced: true,
              runtime: inspection.state,
              ...recordedDeletionEvidence(record, {
                runId,
                resourceId,
                reference: instance.reference,
              }),
            }),
        });
        if (decision.delete && decision.basis === "missing") {
          yield* ledger.observe(runId, {
            state: "gone",
            detail: `the ended runtime (${adapter.id} ${resourceId}) is gone; nothing of it is left`,
          });
          return;
        }
        if (decision.delete) {
          yield* removeRemains(adapter, instance, resourceId, {
            captureSourced: true,
            basis: decision.basis,
            ticket,
          });
          return;
        }
        if (heldElsewhere === true) {
          // Another path is removing it right now: not a retention.
          return;
        }
        const reason =
          inspection.state === "running"
            ? "the executor of an ended run is still running and its work is not confirmed saved"
            : decision.reason;
        if (yield* ledger.markRetained(runId, reason)) {
          yield* Effect.logError(
            `Runtime exit reconciler: run ${runId} (${adapter.id} ${resourceId}) ended (${instance.status}) with no retention recorded: not saved · retained · ${reason}. Recovery is attempted.`,
          );
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Runtime exit reconciler: looking at the ended capture executor of run ${runId} failed; the next sweep asks again.`,
            cause,
          ),
        ),
      );
    }
  });

/**
 * Before an exit is recorded: `record` (go ahead: record and remove the remains), `leave` (touch
 * nothing this sweep), or `record-keep-remains` (record the exit, keep the remains: retained).
 * A capture-sourced runtime (or one whose source cannot be read) whose daemon still answers is
 * drained first, and `record` only once its work is confirmed saved. One whose daemon does not
 * answer — or that this worker cannot address — goes through the preservation policy with what
 * the runtime reported (`exited` keeps a disk, `missing` does not) and what the drain record
 * holds (an observed complete flush, an attestation, a discard). Everything that is not
 * capture-sourced is `record`. Never fails — a failed read leaves the instance alone.
 */
const drainBeforeRecording = (
  options: ReconcileRuntimeExitsEffectOptions,
  instance: WorkspaceRuntimeInstance,
  adapter: RuntimeAdapter,
  inspection: RuntimeEnd,
): Effect.Effect<
  | { readonly verdict: "record"; readonly removal: RemovalBasis }
  | { readonly verdict: "leave" }
  | { readonly verdict: "record-keep-remains"; readonly reason: string },
  never,
  WorkspaceAttemptRepo | SealantRuntime
> =>
  Effect.gen(function* () {
    const drain = options.captureDrain;
    if (drain === undefined) {
      // No drain record to consult: the source decides alone, and a capture (or unreadable)
      // source is never recorded or removed from here — this worker cannot preserve it.
      const attempts = yield* WorkspaceAttemptRepo;
      const captureSourced = yield* runIsCaptureSourced({
        runId: instance.runId,
        sourceKind: instance.sourceKind,
        readSnapshotPayload: attempts.getAttemptSnapshotByRunId(instance.runId),
      });
      if (!captureSourced) {
        return { verdict: "record" as const, removal: NOT_CAPTURE };
      }
      yield* Effect.logError(
        `Runtime exit reconciler: run ${instance.runId} (${adapter.id} ${instance.resourceId ?? ""}) ended and is capture-sourced, but this reconciler has no capture drain configured: not saved · kept · nothing recorded or removed.`,
      );
      return { verdict: "leave" as const };
    }
    const record = yield* drain.ledger.read(instance.runId);
    if (record.readable && record.entry?.discardRequested !== undefined) {
      // The owner discarded this run's unsaved captures: nothing is drained or kept for them.
      return {
        verdict: "record" as const,
        removal: { captureSourced: true, basis: "discarded" as const },
      };
    }
    const attempts = yield* WorkspaceAttemptRepo;
    const captureSourced = yield* runIsCaptureSourced({
      runId: instance.runId,
      sourceKind: instance.sourceKind,
      readSnapshotPayload: attempts.getAttemptSnapshotByRunId(instance.runId),
    });
    const executor = {
      runId: instance.runId,
      resourceId: instance.resourceId,
      reference: instance.reference,
    };
    // Decided on the evidence as it stands after the last thing learned about the executor, and
    // authorized against it (decision 18): a newer observation recorded meanwhile, or one still
    // in flight, is weighed rather than raced.
    const decide = (drainedNow: boolean) =>
      authorizedDeletion({
        ledger: drain.ledger,
        runId: instance.runId,
        runtime: inspection.state,
        removalFenceMs: adapter.removalFenceMs,
        decide: (current) => {
          const evidence = recordedDeletionEvidence(current, executor);
          return decideExecutorDeletion({
            captureSourced,
            runtime: inspection.state,
            ...evidence,
            drainedNow: drainedNow && evidence.observedComplete,
          });
        },
      }).pipe(
        Effect.map(({ decision, ticket, heldElsewhere }) =>
          decision.delete
            ? {
                verdict: "record" as const,
                removal: { captureSourced, basis: decision.basis, ticket },
              }
            : heldElsewhere === true
              ? // Another path is removing it right now: nothing is recorded this sweep.
                { verdict: "leave" as const }
              : { verdict: "record-keep-remains" as const, reason: decision.reason },
        ),
      );
    if (!captureSourced) {
      return yield* decide(false);
    }
    const target = sealantTargetForRuntimeInstance(instance, options.targetOptions ?? {});
    // What the probe reads is evidence about this executor like any other reading: recorded as
    // it arrives, under a fence opened before it was asked for.
    const probe =
      target === undefined
        ? undefined
        : yield* probeCaptureDaemon(
            target,
            DAEMON_PROBE_TIMEOUT_MS,
            ledgerObservationRecorder(drain.ledger, instance.runId, DAEMON_PROBE_TIMEOUT_MS),
          );
    if (probe?.kind === "unrecorded") {
      // Nothing could be asked: nothing is concluded this sweep.
      return { verdict: "leave" as const };
    }
    if (target === undefined || probe === undefined || probe.kind === "unreachable") {
      return yield* decide(false);
    }
    yield* Effect.logWarning(
      `Runtime exit reconciler: ${adapter.id} reports run ${instance.runId} ended, but its sealantd still answers; draining its captures before anything is recorded or removed.`,
    );
    const outcome = yield* drainCaptureBeforeStop({
      runId: instance.runId,
      target,
      ledger: drain.ledger,
      settings: drain.settings,
      budgetMs: drain.budgetMs ?? DEFAULT_DRAIN_BUDGET_PER_SWEEP_MS,
      label: "exit reconciler",
      runtimeState: runtimeReportsState(adapter, instance.resourceId ?? ""),
    });
    if (outcome.kind === "gone") {
      return {
        verdict: "record" as const,
        removal: { captureSourced: true, basis: "missing" as const },
      };
    }
    if (outcome.kind !== "drained") {
      return { verdict: "leave" as const };
    }
    const drained = yield* decide(true);
    return drained.verdict === "record" ? drained : { verdict: "leave" as const };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Runtime exit reconciler: checking the capture queue of run ${instance.runId} failed; leaving it for the next sweep.`,
        cause,
      ).pipe(Effect.as({ verdict: "leave" as const })),
    ),
  );

/** Why an ended executor's remains may go, and whether it was a capture executor. */
interface RemovalBasis {
  readonly captureSourced: boolean;
  readonly basis: ExecutorDeletionBasis;
  /** Holds a removal authorized on recorded evidence (decision 21). */
  readonly ticket?: DeletionTicket | undefined;
}

const NOT_CAPTURE: RemovalBasis = { captureSourced: false, basis: "not-capture" };

/** A fresh `inspect`: exited or missing only on a positive answer; unknown is `running`. */
const runtimeReportsState = (
  adapter: RuntimeAdapter,
  resourceId: string,
): Effect.Effect<"running" | "exited" | "missing"> => {
  const inspect = adapter.inspect;
  if (inspect === undefined) {
    return Effect.succeed("running");
  }
  return Effect.tryPromise(() => inspect.call(adapter, { resourceId })).pipe(
    Effect.map((result) => result.state),
    Effect.catchCause(() => Effect.succeed("running" as const)),
  );
};

/** How far `now` is from `deadline`, as observed: "12 s left" or "passed 3 s ago". */
const describeDeadlineDistance = (deadline: Date, nowMs: number): string => {
  const deltaS = Math.round((deadline.getTime() - nowMs) / 1000);
  return deltaS >= 0 ? `${String(deltaS)} s left` : `passed ${String(-deltaS)} s ago`;
};

/**
 * Report an ended executor of a lifetime-capped runtime near (or past) its deadline, as what was
 * OBSERVED, never as what timing suggests (review 5 #7): the daemon's exit, what the platform
 * says of the machine under it, and the distance to the deadline, each on its own. The platform
 * ended the machine — and its disk with it — only when the platform said so (`platformEnded`,
 * or the resource is `missing`); "at its lifetime cap" only when that happened at or past the
 * deadline. A daemon that exited on a machine the platform still runs is a retained disk, not a
 * lost one; one the runtime does not separate is reported as not observed.
 */
export const describeCappedRuntimeEnd = (
  instance: Pick<WorkspaceRuntimeInstance, "runId" | "runtimeDeadlineAt">,
  end: RuntimeEnd,
  nowMs: number,
): { readonly level: "error" | "warning"; readonly message: string } | undefined => {
  const deadline = instance.runtimeDeadlineAt;
  if (deadline === null || nowMs < deadline.getTime() - HARD_CAP_SLACK_MS) {
    return undefined;
  }
  const timing = `deadline ${deadline.toISOString()} · ${describeDeadlineDistance(deadline, nowMs)}`;
  const pastDeadline = nowMs >= deadline.getTime();
  const platformEnded = end.state === "missing" || end.platformEnded === true;
  if (platformEnded) {
    const how =
      end.state === "missing"
        ? "the platform no longer knows it"
        : `platform ${end.platformState ?? "ended"}${end.detail === undefined ? "" : ` (${end.detail})`}`;
    return {
      level: "error",
      message: `Runtime exit reconciler: run ${instance.runId} · executor ended by the platform · observed (${how}) · ${timing}${
        pastDeadline ? " · at or past its lifetime cap" : ""
      }. Its disk went with it: whatever its daemon had not shipped is not recoverable from it.`,
    };
  }
  const exit = `daemon exited${end.exitCode === undefined ? "" : ` with ${String(end.exitCode)}`}${
    end.detail === undefined ? "" : ` (${end.detail})`
  }`;
  const machine =
    end.platformEnded === false
      ? `platform still reports the machine ${end.platformState ?? "up"} · disk present`
      : "platform state not observed";
  return {
    level: "warning",
    message: `Runtime exit reconciler: run ${instance.runId} · ${exit} · ${machine} · ${timing}. Nothing observed says the platform ended it; its disk is kept or released by the preservation policy, and any recovery must finish before the deadline.`,
  };
};

const reportHardCap = (instance: WorkspaceRuntimeInstance, end: RuntimeEnd) =>
  Effect.gen(function* () {
    const report = describeCappedRuntimeEnd(instance, end, Date.now());
    if (report === undefined) {
      return;
    }
    yield* report.level === "error"
      ? Effect.logError(report.message)
      : Effect.logWarning(report.message);
  });

export const reconcileRuntimeExits = async (
  options: ReconcileRuntimeExitsOptions,
): Promise<number> => {
  const { db, ...effectOptions } = options;
  const dataAccessLayer = Layer.mergeAll(
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceAttemptRepoLive,
    // A kept executor's retention and its terminal write commit together (`withRetention`).
    DatabaseTransactionLive,
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
