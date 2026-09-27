/**
 * Preservation before a runtime's own deadline. A Lambda MicroVM ends at its maximum duration
 * whatever anyone asks, and the terminate hook it runs then is bounded by the platform (at most
 * 60 s) — a last resort, not a plan. Every capture-sourced runtime with a recorded deadline
 * (`workspace_runtime_instances.runtime_deadline_at`) is therefore drained EARLY: this sweep
 * starts a FINAL drain and a planned stop at
 *
 *     preservationStartsAt = deadline − lead − estimate
 *
 * where `lead` is configured (`WORKSPACE_CAPTURE_DEADLINE_LEAD_MS`) and `estimate` is the time
 * the executor needs to upload what it still holds, times a safety factor: the bytes still to
 * ship (`pendingBytes`, else everything staged) plus, while a bulk snapshot is still being built
 * (`bulkBuilding` — its bytes are not pending yet), at least the staged size again or a fixed
 * allowance, over the upload throughput observed on it — or, until any throughput has been
 * observed, a conservative assumed rate (never "instant").
 *
 * Each tick has two phases, so no drain can starve another runtime:
 *
 *  1. **Plan every runtime first.** Every capture-sourced runtime inside its watch window has its
 *     `capture.status` sampled (bounded concurrency) and its schedule — the start, the throughput
 *     — persisted in `workspace_capture_drains`, before any drain is driven.
 *  2. **Drive every due runtime, earliest deadline first**, through the shared stop path
 *     (`processWorkspaceStopEffect`, label `deadline preservation`) with bounded concurrency and a
 *     per-runtime budget. Every due runtime gets its turn every tick: a drain still pending only
 *     returns `draining` and is picked up again next tick; it never holds a slot another due
 *     runtime needs across ticks.
 *
 * A drain the daemon cannot confirm keeps the executor, as every drain does — the platform may
 * still end it at the deadline, which the exit reconciler then reports loudly.
 */
import type { CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepoLive,
  SealantDB,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { SealantRuntimeControlLive } from "../sealantd/runtime.js";
import {
  sealantTargetForRuntimeInstance,
  type SealantTargetDerivationOptions,
} from "../sealantd/target.js";
import {
  readCaptureStatus,
  runIsCaptureSourced,
  type CaptureDrainLedger,
  type CaptureDrainSettings,
} from "./capture-drain.js";
import { processWorkspaceStopEffect } from "./process-workspace-stop.js";

export interface CaptureDeadlineSettings {
  /** Fixed lead: the final drain starts at least this long before the deadline. */
  readonly leadMs: number;
  /**
   * How long before the earliest possible start the sweep begins sampling upload throughput. A
   * runtime further from its deadline than lead + this is not touched.
   */
  readonly watchWindowMs: number;
  /** Multiplier on the upload estimate; the estimate errs long. Default 1.5. */
  readonly estimateSafetyFactor?: number;
  /**
   * The upload rate assumed until one has been observed on the executor (bytes per second): an
   * unmeasured link is slow, never instant. Default 1 MiB/s.
   */
  readonly assumedBytesPerSecond?: number;
  /**
   * While a bulk snapshot is still being built its bytes are not pending yet: at least the
   * staged size again, or this many bytes, whichever is larger, are counted. Default 256 MiB.
   */
  readonly bulkBuildingAllowanceBytes?: number;
}

export const DEFAULT_CAPTURE_DEADLINE_SETTINGS: CaptureDeadlineSettings = {
  leadMs: 15 * 60_000,
  watchWindowMs: 60 * 60_000,
  estimateSafetyFactor: 1.5,
  assumedBytesPerSecond: 1024 * 1024,
  bulkBuildingAllowanceBytes: 256 * 1024 * 1024,
};

const DEFAULT_ASSUMED_BYTES_PER_SECOND = 1024 * 1024;
const DEFAULT_BULK_BUILDING_ALLOWANCE_BYTES = 256 * 1024 * 1024;

/** When the final drain of a runtime must start, from its deadline and what it still holds. */
export const planPreservationStart = (input: {
  readonly deadlineMs: number;
  readonly leadMs: number;
  /** Bytes staged that no upload has taken yet (`pendingBytes`), when the daemon reports them. */
  readonly pendingBytes: number | undefined;
  /** Everything staged on the executor (`stagedBytes`); stands in when `pendingBytes` is absent. */
  readonly stagedBytes?: number | undefined;
  /** A bulk snapshot is still being built: its bytes are not in `pendingBytes` yet. */
  readonly bulkBuilding?: boolean | undefined;
  /** Observed upload throughput, when any was observed. */
  readonly uploadBytesPerSecond: number | undefined;
  readonly safetyFactor: number;
  /** The rate assumed while none has been observed. Default 1 MiB/s. */
  readonly assumedBytesPerSecond?: number;
  /** The least a bulk snapshot being built is assumed to add. Default 256 MiB. */
  readonly bulkBuildingAllowanceBytes?: number;
}): { readonly startsAtMs: number; readonly estimateMs: number } => {
  const staged = Math.max(0, input.stagedBytes ?? 0);
  const building =
    input.bulkBuilding === true
      ? Math.max(staged, input.bulkBuildingAllowanceBytes ?? DEFAULT_BULK_BUILDING_ALLOWANCE_BYTES)
      : 0;
  const bytes = Math.max(0, input.pendingBytes ?? staged) + building;
  const rate =
    input.uploadBytesPerSecond !== undefined && input.uploadBytesPerSecond > 0
      ? input.uploadBytesPerSecond
      : Math.max(1, input.assumedBytesPerSecond ?? DEFAULT_ASSUMED_BYTES_PER_SECOND);
  const estimateMs = bytes <= 0 ? 0 : Math.ceil((bytes / rate) * 1000 * input.safetyFactor);
  return { startsAtMs: input.deadlineMs - input.leadMs - estimateMs, estimateMs };
};

/**
 * Fold one `uploadedBytes` sample into the observed throughput. Only an interval in which bytes
 * moved is a reading (an idle queue says nothing about the link); readings are averaged with
 * the previous estimate. A counter that went backwards (the daemon restarted) restarts sampling.
 */
export const observeUploadThroughput = (input: {
  readonly previousRate: number | undefined;
  readonly previousSample: { readonly bytes: number; readonly atMs: number } | undefined;
  readonly sample: { readonly bytes: number; readonly atMs: number };
}): number | undefined => {
  const { previousRate, previousSample, sample } = input;
  if (previousSample === undefined || sample.bytes <= previousSample.bytes) {
    return previousRate;
  }
  const elapsedMs = sample.atMs - previousSample.atMs;
  if (elapsedMs <= 0) {
    return previousRate;
  }
  const reading = ((sample.bytes - previousSample.bytes) * 1000) / elapsedMs;
  return previousRate === undefined ? reading : (previousRate + reading) / 2;
};

export interface PreserveBeforeDeadlineOptions {
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  readonly credentialCipher?: CredentialCipherService;
  readonly targetOptions?: SealantTargetDerivationOptions;
  readonly captureDrain: {
    readonly ledger: CaptureDrainLedger;
    readonly settings: CaptureDrainSettings;
    /** How long one tick may wait on one runtime's queue. */
    readonly budgetMs?: number;
  };
  readonly deadline: CaptureDeadlineSettings;
  /** How many due runtimes are driven at once. Every due runtime is driven every tick. Default 4. */
  readonly drainConcurrency?: number;
  readonly now?: () => number;
}

const DEFAULT_DRAIN_CONCURRENCY = 4;
const PLAN_CONCURRENCY = 16;
const DEFAULT_DRAIN_BUDGET_PER_TICK_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;

/** A runtime whose final drain is due this tick. */
interface DuePreservation {
  readonly instance: WorkspaceRuntimeInstance;
  readonly deadlineMs: number;
  readonly startsAtMs: number;
  readonly estimateMs: number;
  /** The start was reached only now (the first tick that drives it): say so. */
  readonly firstStart: boolean;
}

/**
 * One sweep over the `ready` runtime instances with a deadline: plan and persist every runtime in
 * its watch window, then drive every due one, earliest deadline first, with bounded concurrency.
 * Returns how many due runtimes it drove a stop for (`stopped` or still `draining`). Best-effort
 * per instance: one failure never aborts the sweep.
 */
export const preserveBeforeDeadlineEffect = Effect.fn("preserveBeforeDeadline")(function* (
  options: PreserveBeforeDeadlineOptions,
) {
  const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
  const now = options.now ?? Date.now;
  const capped = (yield* runtimeInstances.listRunningInstances()).filter(
    (instance) => instance.runtimeDeadlineAt !== null,
  );

  // Phase 1: every plan is persisted before any drain is driven.
  const plans = yield* Effect.forEach(
    capped,
    (instance) =>
      planOne(options, instance, now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Deadline preservation: run ${instance.runId} could not be planned this sweep.`,
            cause,
          ).pipe(Effect.as(undefined)),
        ),
      ),
    { concurrency: PLAN_CONCURRENCY },
  );

  // Phase 2: earliest deadline first; every due runtime gets its turn this tick.
  const due = plans
    .filter((plan): plan is DuePreservation => plan !== undefined)
    .toSorted((a, b) => a.deadlineMs - b.deadlineMs || a.startsAtMs - b.startsAtMs);
  const driven = yield* Effect.forEach(
    due,
    (plan) =>
      driveOne(options, plan).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Deadline preservation: run ${plan.instance.runId} could not be driven this sweep.`,
            cause,
          ).pipe(Effect.as(false)),
        ),
      ),
    { concurrency: Math.max(1, options.drainConcurrency ?? DEFAULT_DRAIN_CONCURRENCY) },
  );
  return driven.filter(Boolean).length;
});

/** Sample, plan and persist one runtime's preservation; the plan when its start is reached. */
const planOne = (
  options: PreserveBeforeDeadlineOptions,
  instance: WorkspaceRuntimeInstance,
  now: () => number,
) =>
  Effect.gen(function* () {
    const deadlineMs = instance.runtimeDeadlineAt?.getTime();
    if (deadlineMs === undefined) {
      return undefined;
    }
    const settings = options.deadline;
    if (now() < deadlineMs - settings.leadMs - settings.watchWindowMs) {
      return undefined;
    }
    const attempts = yield* WorkspaceAttemptRepo;
    const captureSourced = yield* runIsCaptureSourced({
      runId: instance.runId,
      sourceKind: instance.sourceKind,
      readSnapshotPayload: attempts.getAttemptSnapshotByRunId(instance.runId),
    });
    if (!captureSourced) {
      return undefined;
    }

    const drains = yield* WorkspaceCaptureDrainRepo;
    const row = yield* drains.getByRunId(instance.runId);
    const target = sealantTargetForRuntimeInstance(instance, options.targetOptions ?? {});
    const status =
      target === undefined ? undefined : yield* readCaptureStatus(target, STATUS_TIMEOUT_MS);
    const sampledAtMs = now();
    const previousSample =
      row?.uploadSampleBytes === null ||
      row?.uploadSampleBytes === undefined ||
      row.uploadSampledAt === null
        ? undefined
        : { bytes: row.uploadSampleBytes, atMs: row.uploadSampledAt.getTime() };
    const rate =
      status === undefined
        ? (row?.uploadBytesPerSecond ?? undefined)
        : observeUploadThroughput({
            previousRate: row?.uploadBytesPerSecond ?? undefined,
            previousSample,
            sample: { bytes: status.uploadedBytes, atMs: sampledAtMs },
          });
    const plan = planPreservationStart({
      deadlineMs,
      leadMs: settings.leadMs,
      pendingBytes: status?.pendingBytes,
      stagedBytes: status?.stagedBytes,
      bulkBuilding: status?.bulkBuilding,
      uploadBytesPerSecond: rate,
      safetyFactor: settings.estimateSafetyFactor ?? 1.5,
      ...(settings.assumedBytesPerSecond === undefined
        ? {}
        : { assumedBytesPerSecond: settings.assumedBytesPerSecond }),
      ...(settings.bulkBuildingAllowanceBytes === undefined
        ? {}
        : { bulkBuildingAllowanceBytes: settings.bulkBuildingAllowanceBytes }),
    });
    // A start once reached stays reached: an estimate that shrinks later never un-starts a drain.
    // With no fresh status the estimate knows nothing new, so an earlier recorded start stands.
    const recordedStartMs = row?.preservationStartsAt?.getTime();
    const startsAtMs =
      recordedStartMs !== undefined &&
      (recordedStartMs <= sampledAtMs ||
        (status === undefined && recordedStartMs < plan.startsAtMs))
        ? recordedStartMs
        : plan.startsAtMs;
    yield* drains.recordSchedule({
      runId: instance.runId,
      schedule: {
        preservationStartsAt: new Date(startsAtMs),
        uploadBytesPerSecond: rate ?? null,
        ...(status === undefined
          ? {}
          : { uploadSampleBytes: status.uploadedBytes, uploadSampledAt: new Date(sampledAtMs) }),
      },
    });
    if (sampledAtMs < startsAtMs) {
      return undefined;
    }
    return {
      instance,
      deadlineMs,
      startsAtMs,
      estimateMs: plan.estimateMs,
      firstStart: recordedStartMs === undefined || recordedStartMs > sampledAtMs,
    } satisfies DuePreservation;
  });

/** Drive one due runtime's final drain and planned stop for this tick's budget. */
const driveOne = (options: PreserveBeforeDeadlineOptions, plan: DuePreservation) =>
  Effect.gen(function* () {
    const { instance } = plan;
    if (plan.firstStart) {
      yield* Effect.logWarning(
        `Deadline preservation: run ${instance.runId} ends at ${new Date(plan.deadlineMs).toISOString()} (the runtime's own deadline); starting its final drain and a planned stop now (lead ${String(Math.round(options.deadline.leadMs / 1000))} s + upload estimate ${String(Math.round(plan.estimateMs / 1000))} s).`,
      );
    }
    const workspaces = yield* WorkspaceRepo;
    const workspace = yield* workspaces.getWorkspaceByAttemptId(instance.runId);
    const outcome = yield* processWorkspaceStopEffect({
      ...(workspace !== undefined && workspace.latestRunId === instance.runId
        ? { workspaceId: workspace.id }
        : {}),
      runId: instance.runId,
      stopReason: "expired",
      runtimeAdapters: options.runtimeAdapters,
      ...(options.credentialCipher === undefined
        ? {}
        : { credentialCipher: options.credentialCipher }),
      ...(options.targetOptions === undefined ? {} : { targetOptions: options.targetOptions }),
      captureDrain: {
        ledger: options.captureDrain.ledger,
        settings: options.captureDrain.settings,
        budgetMs: options.captureDrain.budgetMs ?? DEFAULT_DRAIN_BUDGET_PER_TICK_MS,
        label: "deadline preservation",
      },
    });
    return outcome === "stopped" || outcome === "draining";
  });

export interface PreserveBeforeDeadlineRunOptions extends PreserveBeforeDeadlineOptions {
  readonly db: DB;
}

export const preserveBeforeDeadline = (
  options: PreserveBeforeDeadlineRunOptions,
): Promise<number> => {
  const { db, ...effectOptions } = options;
  const dataAccessLayer = Layer.mergeAll(
    WorkspaceRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceAttemptRepoLive,
    ConnectedAccountRepoLive,
    WorkspaceCaptureDrainRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));
  return Effect.runPromise(
    preserveBeforeDeadlineEffect(effectOptions).pipe(
      Effect.provide(Layer.mergeAll(dataAccessLayer, SealantRuntimeControlLive)),
    ),
  );
};
