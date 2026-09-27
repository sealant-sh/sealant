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
 * the executor needs to upload what it still holds: `pendingBytes` over the upload throughput
 * observed on it, times a safety factor. The sweep samples each runtime's `capture.status` once
 * it is inside the watch window, keeps the throughput (an average of observed rates) and the
 * computed start in `workspace_capture_drains`, and from the start on drives the shared stop
 * path (`processWorkspaceStopEffect`, label `deadline preservation`) every tick until the stop
 * is done. A drain the daemon cannot confirm keeps the executor, as every drain does — the
 * platform may still end it at the deadline, which the exit reconciler then reports loudly.
 *
 * With the pinned sealantd (0.18.2) `pendingBytes` is not reported, so the estimate is 0 and the
 * configured lead alone decides; it grows as soon as the daemon reports the field.
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
}

export const DEFAULT_CAPTURE_DEADLINE_SETTINGS: CaptureDeadlineSettings = {
  leadMs: 15 * 60_000,
  watchWindowMs: 60 * 60_000,
  estimateSafetyFactor: 1.5,
};

/** When the final drain of a runtime must start, from its deadline and what it still holds. */
export const planPreservationStart = (input: {
  readonly deadlineMs: number;
  readonly leadMs: number;
  /** Bytes still to upload, when the daemon reports them. */
  readonly pendingBytes: number | undefined;
  /** Observed upload throughput, when any was observed. */
  readonly uploadBytesPerSecond: number | undefined;
  readonly safetyFactor: number;
}): { readonly startsAtMs: number; readonly estimateMs: number } => {
  const estimateMs =
    input.pendingBytes === undefined ||
    input.pendingBytes <= 0 ||
    input.uploadBytesPerSecond === undefined ||
    input.uploadBytesPerSecond <= 0
      ? 0
      : Math.ceil((input.pendingBytes / input.uploadBytesPerSecond) * 1000 * input.safetyFactor);
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
  /** Upper bound on runtimes driven to a stop per tick. Default 5. */
  readonly maxStopsPerTick?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_STOPS_PER_TICK = 5;
const DEFAULT_DRAIN_BUDGET_PER_TICK_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;

/**
 * One sweep over the `ready` runtime instances with a deadline. Returns how many it drove a stop
 * for. Best-effort per instance: one failure never aborts the sweep.
 */
export const preserveBeforeDeadlineEffect = Effect.fn("preserveBeforeDeadline")(function* (
  options: PreserveBeforeDeadlineOptions,
) {
  const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
  const now = options.now ?? Date.now;
  const maxStops = options.maxStopsPerTick ?? DEFAULT_MAX_STOPS_PER_TICK;
  const capped = (yield* runtimeInstances.listRunningInstances()).filter(
    (instance) => instance.runtimeDeadlineAt !== null,
  );
  let driven = 0;
  for (const instance of capped) {
    if (driven >= maxStops) {
      break;
    }
    const drove = yield* preserveOne(options, instance, now).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Deadline preservation: run ${instance.runId} could not be checked this sweep.`,
          cause,
        ).pipe(Effect.as(false)),
      ),
    );
    if (drove) {
      driven += 1;
    }
  }
  return driven;
});

const preserveOne = (
  options: PreserveBeforeDeadlineOptions,
  instance: WorkspaceRuntimeInstance,
  now: () => number,
) =>
  Effect.gen(function* () {
    const deadlineMs = instance.runtimeDeadlineAt?.getTime();
    if (deadlineMs === undefined) {
      return false;
    }
    const settings = options.deadline;
    if (now() < deadlineMs - settings.leadMs - settings.watchWindowMs) {
      return false;
    }
    const attempts = yield* WorkspaceAttemptRepo;
    const captureSourced = yield* runIsCaptureSourced({
      runId: instance.runId,
      sourceKind: instance.sourceKind,
      readSnapshotPayload: attempts.getAttemptSnapshotByRunId(instance.runId),
    });
    if (!captureSourced) {
      return false;
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
      uploadBytesPerSecond: rate,
      safetyFactor: settings.estimateSafetyFactor ?? 1.5,
    });
    // A start once reached stays reached: an estimate that shrinks later never un-starts a drain.
    const recordedStartMs = row?.preservationStartsAt?.getTime();
    const startsAtMs =
      recordedStartMs !== undefined && recordedStartMs <= sampledAtMs
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
      return false;
    }

    if (recordedStartMs === undefined || recordedStartMs > sampledAtMs) {
      yield* Effect.logWarning(
        `Deadline preservation: run ${instance.runId} ends at ${new Date(deadlineMs).toISOString()} (the runtime's own deadline); starting its final drain and a planned stop now (lead ${String(Math.round(settings.leadMs / 1000))} s + upload estimate ${String(Math.round(plan.estimateMs / 1000))} s).`,
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
