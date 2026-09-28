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
 Each tick, no runtime waits on another's plan (review 6 #11):
 *
 *  - **Due by its record → driven at once.** A runtime whose recorded start passed, or whose
 *    deadline less the lead did (the latest its start can ever be), is driven with no status
 *    sampled first; its drain's FINAL reads the queue itself.
 *  - **Otherwise sampled, then driven the moment its own plan is due.** Its `capture.status` is
 *    sampled (bounded concurrency; the wait and the read together bounded by the time left before
 *    its latest possible start) and its schedule — the start, the throughput — persisted in
 *    `workspace_capture_drains`.
 *  - **Every due FINAL is sent first** (review 7 #6). A due runtime whose executor has not
 *    answered a FINAL yet goes through the shared stop path (`processWorkspaceStopEffect`, label
 *    `deadline preservation`) for that one FINAL round trip only, under its own wide permit
 *    (`initiateConcurrency`), the most urgent first. Waiting for that permit and the round trip
 *    are bounded by the runtime's remaining lifetime. Polling another executor never holds it,
 *    and neither does a removal (review 8 #6): the permit is released once the FINAL is
 *    answered (or the removal it permits begins).
 *  - **A removal is never waited out.** Removing a runtime is uninterruptible and may last the
 *    executor's whole stop grace; it runs in its own fiber, holding no permit, and the sweep waits
 *    for it only until the sweep ends. A later sweep finds its run claimed and leaves it to it.
 *  - **Then the started drains are polled** — status first, never a second FINAL — with bounded
 *    concurrency (`drainConcurrency`) and a budget, and the whole sweep ends by the drain budget
 *    after it began, so a later tick (and the runtimes that become due then) never waits on it.
 *    A drain still pending returns `draining` and is picked up again next tick.
 *  - **The queue is in the plan.** A runtime's start is moved earlier by the FINAL round trips
 *    ahead of it: its rank among the runtimes still to be sent one, over the permits, times the
 *    round trip's bound.
 *
 * The candidates are every runtime with a deadline that may still hold work, not only `ready`
 * ones: a retained launch (`failed`, `launch-retained`) is drained and stopped the same way; an
 * executor whose daemon ended on a machine that still runs (sealantd exited 75 on a MicroVM) and
 * was retained has its recovery made due now (the recovery sweep restarts its daemon on its own
 * disk and drains it); and a launch still in progress (`pending`, even while its launching worker
 * still owns it) whose preservation start arrives is taken from its worker (`preemptLaunch`,
 * which fences every later write of that worker) and drained as a retained launch: a pending
 * state never postpones the platform's cap (review 4 #6).
 *
 * A drain the daemon cannot confirm keeps the executor, as every drain does — the platform may
 * still end it at the deadline, which the exit reconciler then reports loudly.
 */
import type { CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepoLive,
  LAUNCH_RETAINED_ERROR_CODE,
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
  type WorkspaceCaptureDrain,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Semaphore } from "effect";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { SealantRuntimeControlLive, type CaptureFlushReport } from "../sealantd/runtime.js";
import {
  sealantTargetForRuntimeInstance,
  type SealantTargetDerivationOptions,
} from "../sealantd/target.js";
import {
  ledgerObservationRecorder,
  readCaptureStatus,
  runIsCaptureSourced,
  type CaptureDrainLedger,
  type CaptureDrainSettings,
} from "./capture-drain.js";
import {
  processWorkspaceStopEffect,
  type WorkspaceStopOutcome,
  type WorkspaceStopPhase,
} from "./process-workspace-stop.js";

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
  /**
   * How many started drains are polled (and stopped once complete) at once. Default 4. It never
   * delays a first FINAL: those have their own permits (`initiateConcurrency`).
   */
  readonly drainConcurrency?: number;
  /**
   * How many due runtimes are sent their first FINAL at once (one round trip each, bounded by the
   * drain's request timeout). Default 32. The plan counts the round trips queued ahead of a
   * runtime into its start.
   */
  readonly initiateConcurrency?: number;
  readonly now?: () => number;
}

const DEFAULT_DRAIN_CONCURRENCY = 4;
const DEFAULT_INITIATE_CONCURRENCY = 32;
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
  /** How much earlier its start was moved for the FINAL round trips queued ahead of it. */
  readonly queueAheadMs: number;
}

/**
 * One sweep over the runtime instances with a deadline. Nothing waits on another runtime: each
 * candidate is driven as soon as its OWN plan says it is due (review 6 #11), the most urgent
 * first. A runtime already due by its record (its recorded start passed, or its deadline less the
 * lead did — the latest its start can ever be) is driven at once, with no status sampled first;
 * the others are sampled (bounded concurrency), and each sample — the wait for its turn included
 * — is bounded by the time left before that runtime's latest possible start, so a slow or silent
 * daemon elsewhere never delays a due FINAL. Drives are bounded by `drainConcurrency` and granted
 * in the order runtimes became due. Returns how many due runtimes it drove a stop for (`stopped`
 * or still `draining`). Best-effort per instance: one failure never aborts the sweep.
 */
export const preserveBeforeDeadlineEffect = Effect.fn("preserveBeforeDeadline")(function* (
  options: PreserveBeforeDeadlineOptions,
) {
  const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
  const now = options.now ?? Date.now;
  // Every runtime with a deadline that may still hold work: `ready`, a launch in progress or
  // stranded (`pending` with an executor), and a retained one (`failed` with an executor whose
  // machine may still be up — a retained launch, or a daemon that exited on a VM that runs on).
  const capped = (yield* runtimeInstances.listPreservationCandidates()).filter(
    (instance) => instance.runtimeDeadlineAt !== null,
  );

  // What the records alone say (no daemon is asked): which runtimes are in their watch window,
  // capture-sourced and still holding work, and which of them are due already.
  const prepared = (yield* Effect.forEach(
    capped,
    (instance) =>
      prepareOne(options, instance, now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Deadline preservation: run ${instance.runId} could not be planned this sweep.`,
            cause,
          ).pipe(Effect.as(undefined)),
        ),
      ),
    { concurrency: PLAN_CONCURRENCY },
  ))
    .filter((candidate): candidate is PreparedPreservation => candidate !== undefined)
    // The most urgent first: every permit below is granted in this order.
    .toSorted((a, b) => a.latestStartMs - b.latestStartMs || a.deadlineMs - b.deadlineMs);

  // The FINAL round trips queued ahead of each runtime still to be sent one are in its plan:
  // its rank among them, over the permits, times the round trip's bound (review 7 #6).
  const initiateConcurrency = Math.max(
    1,
    options.initiateConcurrency ?? DEFAULT_INITIATE_CONCURRENCY,
  );
  const roundTripMs = Math.max(0, options.captureDrain.settings.requestTimeoutMs);
  let unstartedRank = 0;
  const queued = prepared.map((candidate) => {
    if (candidate.finalAnswered) {
      return candidate;
    }
    const queueAheadMs = Math.floor(unstartedRank / initiateConcurrency) * roundTripMs;
    unstartedRank += 1;
    const latestStartMs = Math.min(
      candidate.latestStartMs,
      candidate.deadlineMs - options.deadline.leadMs - queueAheadMs,
    );
    return { ...candidate, queueAheadMs, latestStartMs, dueByRecord: latestStartMs <= now() };
  });

  const budgetMs = options.captureDrain.budgetMs ?? DEFAULT_DRAIN_BUDGET_PER_TICK_MS;
  // The sweep ends by then: polling started drains never holds the next tick (and the runtimes
  // that become due in it) back.
  const sweepEndsAtMs = now() + budgetMs;
  const samplers = yield* Semaphore.make(PLAN_CONCURRENCY);
  const initiations = yield* Semaphore.make(initiateConcurrency);
  const drives = yield* Semaphore.make(
    Math.max(1, options.drainConcurrency ?? DEFAULT_DRAIN_CONCURRENCY),
  );
  const driven = yield* Effect.forEach(
    queued,
    (candidate) =>
      Effect.gen(function* () {
        // Due by its record: driven now; its drain's FINAL reads the queue itself. Otherwise
        // sampled, for no longer than is left before its latest possible start.
        const sample = candidate.dueByRecord
          ? undefined
          : yield* samplers.withPermit(sampleOne(options, candidate, now)).pipe(
              Effect.timeoutOrElse({
                duration: Math.max(0, candidate.latestStartMs - now()),
                orElse: () => Effect.succeed(undefined),
              }),
            );
        const plan = yield* planOne(options, candidate, sample, now);
        if (plan === undefined) {
          return false;
        }
        const guarded = <E, R>(effect: Effect.Effect<DriveOutcome, E, R>) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Deadline preservation: run ${plan.instance.runId} could not be driven this sweep.`,
                cause,
              ).pipe(Effect.as("not-driven" as const)),
            ),
          );

        // 1. Its first FINAL, before anything polls anything: one round trip, under its own
        // permit, the wait and the trip bounded by the runtime's remaining lifetime (at least
        // one round trip, so a runtime at its deadline is still asked once). The permit is held
        // until that FINAL is answered (or the removal it permits begins), never through the
        // removal (review 8 #6): an executor that answered complete does not hold up another's
        // first FINAL while its runtime is removed, and that removal goes on past this sweep.
        let outcome: DriveOutcome = "draining";
        if (!candidate.finalAnswered) {
          const lifetimeLeftMs = Math.max(plan.deadlineMs - now(), roundTripMs);
          const initiated = yield* driveReleasingPermit({
            permits: initiations,
            waitMs: lifetimeLeftMs,
            joinUntilMs: sweepEndsAtMs,
            now,
            drive: (onPhase) =>
              guarded(driveOne(options, plan, { budgetMs: 0, opensWithStatus: false, onPhase })),
          });
          outcome = yield* reportInitiation(plan, initiated);
          if (outcome !== "draining") {
            return countsAsDriven(outcome);
          }
        }

        // 2. Poll the started drain (status first: its FINAL was answered) and stop it once
        // complete, under the drive permits, for no longer than the sweep lasts — the permit, too,
        // only until the drain returns: a removal it permits goes on without it. A runtime just
        // sent its first FINAL is polled as what that made it (a launch taken from its worker
        // is a retained launch now), and its start is not announced twice.
        const leftMs = sweepEndsAtMs - now();
        if (leftMs <= 0) {
          return countsAsDriven(outcome);
        }
        const current = candidate.finalAnswered
          ? plan.instance
          : yield* runtimeInstances.getRuntimeInstanceByRunId(plan.instance.runId);
        if (current === undefined) {
          return countsAsDriven(outcome);
        }
        const polling: DuePreservation = candidate.finalAnswered
          ? plan
          : { ...plan, instance: current, firstStart: false };
        const polled = yield* driveReleasingPermit({
          permits: drives,
          // The drain's own budget ends with the sweep; the bound adds the one round trip it
          // may be in when its budget runs out.
          waitMs: leftMs + roundTripMs,
          joinUntilMs: sweepEndsAtMs + roundTripMs,
          now,
          drive: (onPhase) =>
            Effect.suspend(() => {
              const remainingMs = sweepEndsAtMs - now();
              return remainingMs <= 0
                ? Effect.succeed<DriveOutcome>("draining")
                : guarded(
                    driveOne(options, polling, {
                      budgetMs: remainingMs,
                      opensWithStatus: true,
                      onPhase,
                    }),
                  );
            }),
        });
        if (polled.kind === "removal-continues") {
          yield* logRemovalContinues(plan, polled.drain);
          return countsAsDriven("removing");
        }
        if (polled.kind === "deciding") {
          yield* logStopContinues(plan, polled.drain);
          return countsAsDriven("draining");
        }
        return countsAsDriven(polled.kind === "done" ? polled.outcome : "draining");
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Deadline preservation: run ${candidate.instance.runId} could not be planned this sweep.`,
            cause,
          ).pipe(Effect.as(false)),
        ),
      ),
    { concurrency: "unbounded" },
  );
  return driven.filter(Boolean).length;
});

/**
 * What driving a due runtime did: a stop's outcome, its removal under way past the sweep, its
 * recovery made due, or nothing.
 */
type DriveOutcome = WorkspaceStopOutcome | "removing" | "recovery-due" | "not-driven";

/**
 * Whether an outcome counts as driven (a stop removed it, is removing it or goes on draining;
 * recovery due).
 */
const countsAsDriven = (outcome: DriveOutcome): boolean =>
  outcome === "stopped" ||
  outcome === "removing" ||
  outcome === "draining" ||
  outcome === "recovery-due";

/**
 * How one drive went while the sweep waited on it (`driveReleasingPermit`):
 *
 *  - `no-permit`: its bound ran out while every permit was held — it never started.
 *  - `unanswered`: it started (its FINAL or status was being asked) and nothing came back within
 *    the bound; it was interrupted.
 *  - `removal-continues`: the runtime was asked to remove the executor (its removal was issued:
 *    nothing could veto it any more) and the removal outlasts the sweep; it goes on in its own
 *    fiber, holding no permit of the sweep. `drain`: what its drain returned, when one ran.
 *  - `deciding`: its drain returned, and the stop outlasts the sweep with no removal issued (review
 *    9 #9): it is still weighing the evidence, recording a keep, or inspecting the runtime — the
 *    executor may yet be kept. It goes on in its own fiber, holding no permit of the sweep.
 *  - `done`: it ended within the sweep.
 */
type ReleasedDrive =
  | { readonly kind: "no-permit" }
  | { readonly kind: "unanswered"; readonly startedAtMs: number }
  | { readonly kind: "removal-continues"; readonly drain: DrainEnded | undefined }
  | { readonly kind: "deciding"; readonly drain: DrainEnded | undefined }
  | { readonly kind: "done"; readonly outcome: DriveOutcome };

/** What a stop's drain returned, as its `drain-ended` phase said. */
type DrainEnded = Extract<WorkspaceStopPhase, { readonly kind: "drain-ended" }>["drain"];

/**
 * Run one drive in its own fiber, holding one of `permits` only until the drive's drain returns,
 * its runtime's removal begins, or it ends — never through a removal, which is uninterruptible
 * and may take the executor's whole stop grace (review 8 #6). Waiting for the permit and for the
 * drain together are bounded by `waitMs`; past it an unanswered drive is interrupted. After the
 * permit is released the sweep waits for the drive until `joinUntilMs`, then leaves it running on
 * its own: a later sweep finds its run claimed and leaves it to it.
 */
const driveReleasingPermit = <R>(input: {
  readonly permits: Semaphore.Semaphore;
  readonly waitMs: number;
  readonly joinUntilMs: number;
  readonly now: () => number;
  readonly drive: (
    onPhase: (phase: WorkspaceStopPhase) => Effect.Effect<void>,
  ) => Effect.Effect<DriveOutcome, never, R>;
}): Effect.Effect<ReleasedDrive, never, R> =>
  Effect.gen(function* () {
    const signal = yield* Deferred.make<WorkspaceStopPhase | { readonly kind: "ended" }>();
    // Every phase the stop passed, not only the first: the permit goes at the first, and what the
    // sweep reports at its end follows the latest (review 9 #9).
    let drainEnded: DrainEnded | undefined;
    let removalIssued = false;
    const passed = (phase: WorkspaceStopPhase) =>
      Effect.sync(() => {
        if (phase.kind === "drain-ended") {
          drainEnded = phase.drain;
        } else {
          removalIssued = true;
        }
      }).pipe(Effect.andThen(Deferred.succeed(signal, phase)), Effect.asVoid);
    let started: { readonly fiber: Fiber.Fiber<DriveOutcome>; readonly atMs: number } | undefined;
    const waited = yield* input.permits
      .withPermit(
        Effect.gen(function* () {
          const atMs = input.now();
          const fiber = yield* Effect.forkDetach(
            input.drive(passed).pipe(Effect.ensuring(Deferred.succeed(signal, { kind: "ended" }))),
          );
          started = { fiber, atMs };
          return yield* Deferred.await(signal);
        }),
      )
      .pipe(Effect.timeoutOption(Math.max(0, input.waitMs)));
    if (started === undefined) {
      return { kind: "no-permit" } satisfies ReleasedDrive;
    }
    const { fiber } = started;
    let phase: WorkspaceStopPhase | { readonly kind: "ended" };
    if (Option.isSome(waited)) {
      phase = waited.value;
    } else if (yield* Deferred.isDone(signal)) {
      // It passed the point in the same instant the bound ran out: not unanswered.
      phase = yield* Deferred.await(signal);
    } else {
      yield* Fiber.interrupt(fiber);
      return { kind: "unanswered", startedAtMs: started.atMs } satisfies ReleasedDrive;
    }
    const joined = yield* Fiber.await(fiber).pipe(
      Effect.timeoutOption(Math.max(0, input.joinUntilMs - input.now())),
    );
    if (Option.isNone(joined)) {
      if (phase.kind === "ended") {
        return { kind: "done", outcome: "draining" } satisfies ReleasedDrive;
      }
      // Only an issued removal is one under way; a drain that ended leaves the executor's fate
      // to what the stop decides next.
      return removalIssued
        ? ({ kind: "removal-continues", drain: drainEnded } satisfies ReleasedDrive)
        : ({ kind: "deciding", drain: drainEnded } satisfies ReleasedDrive);
    }
    return {
      kind: "done",
      outcome: Exit.isSuccess(joined.value) ? joined.value.value : "not-driven",
    } satisfies ReleasedDrive;
  });

/**
 * What a first FINAL's drive came to, said as what happened (review 8 #6): its permit never came
 * before the runtime's end, its FINAL went unanswered, or its complete answer arrived and the
 * removal it permits goes on past the sweep. The outcome for the sweep.
 */
const reportInitiation = (plan: DuePreservation, initiated: ReleasedDrive) =>
  Effect.gen(function* () {
    const ends = new Date(plan.deadlineMs).toISOString();
    switch (initiated.kind) {
      case "no-permit":
        yield* Effect.logError(
          `Deadline preservation: run ${plan.instance.runId} ends at ${ends}; its final flush could not be sent before then (every FINAL permit was held): not saved · the platform may end it with its work.`,
        );
        return "not-driven" as const;
      case "unanswered":
        yield* Effect.logError(
          `Deadline preservation: run ${plan.instance.runId} ends at ${ends}; its final flush was started at ${new Date(initiated.startedAtMs).toISOString()} and no answer came before then: not saved · the platform may end it with its work.`,
        );
        return "not-driven" as const;
      case "removal-continues":
        yield* logRemovalContinues(plan, initiated.drain);
        return "removing" as const;
      case "deciding":
        yield* logStopContinues(plan, initiated.drain);
        return "draining" as const;
      case "done":
        return initiated.outcome;
    }
  });

/**
 * A removal that outlasts the sweep, said with what the drain before it observed. Only for a
 * removal that was issued (review 9 #9).
 */
const logRemovalContinues = (plan: DuePreservation, drain: DrainEnded | undefined) =>
  Effect.logInfo(
    `Deadline preservation: run ${plan.instance.runId}: ${
      drain === "drained"
        ? "its final flush answered complete · observed"
        : drain === "gone"
          ? "its daemon is silent and nothing of the executor is left"
          : "the evidence on record lets it go"
    }; the runtime was asked to remove it, and the removal continues past this sweep.`,
  );

/**
 * A stop that outlasts the sweep with no removal issued (review 9 #9): its drain returned, and the
 * stop is still deciding — nothing says the executor goes. Said with what the drain observed.
 */
const logStopContinues = (plan: DuePreservation, drain: DrainEnded | undefined) => {
  const prefix = `Deadline preservation: run ${plan.instance.runId}`;
  switch (drain) {
    case "drained":
      return Effect.logInfo(
        `${prefix}: its final flush answered complete · observed; whether the executor may be removed is still being weighed on the evidence on record, past this sweep · nothing removed yet.`,
      );
    case "gone":
      return Effect.logInfo(
        `${prefix}: its daemon is silent and the runtime reported nothing of the executor left; the stop goes on past this sweep · nothing removed yet.`,
      );
    case "silent":
    case "stalled":
    case "unconfirmed":
    case "pending":
      return Effect.logError(
        `${prefix}: not saved · its drain ended ${drain} · the stop goes on past this sweep deciding what to keep · nothing removed.`,
      );
    case "busy":
    case undefined:
      return Effect.logInfo(`${prefix}: the stop goes on past this sweep · nothing removed yet.`);
  }
};

/** A candidate in its watch window, as its records describe it before any daemon is asked. */
interface PreparedPreservation {
  readonly instance: WorkspaceRuntimeInstance;
  readonly row: WorkspaceCaptureDrain | undefined;
  readonly deadlineMs: number;
  /** The latest its final drain can start: the recorded start, else the deadline less the lead. */
  readonly latestStartMs: number;
  /** Its start has been reached already: it is driven without a status sample first. */
  readonly dueByRecord: boolean;
  /**
   * Its executor answered a FINAL already (a drain of it recorded an answer): its drain is
   * started, and it is only polled — its first FINAL is never queued behind anything again.
   */
  readonly finalAnswered: boolean;
  /** How much earlier its start is for the FINAL round trips queued ahead of it (set in order). */
  readonly queueAheadMs: number;
}

/** Whether a runtime is in its watch window and holds work that may need saving; no daemon call. */
const prepareOne = (
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
    if (
      instance.status === "failed" &&
      instance.errorCode !== LAUNCH_RETAINED_ERROR_CODE &&
      (row?.retainedAt === null || row?.retainedAt === undefined)
    ) {
      // Ended and not retained: nothing of it is waiting to be saved.
      return undefined;
    }
    // No estimate is negative: a start is never later than the deadline less the lead.
    const recordedStartMs = row?.preservationStartsAt?.getTime();
    const latestStartMs = Math.min(
      deadlineMs - settings.leadMs,
      recordedStartMs ?? Number.POSITIVE_INFINITY,
    );
    return {
      instance,
      row,
      deadlineMs,
      latestStartMs,
      dueByRecord: latestStartMs <= now(),
      // Every drain opens with a FINAL, and its first answer starts its progress clock.
      finalAnswered: row?.lastProgressAt !== null && row?.lastProgressAt !== undefined,
      queueAheadMs: 0,
    } satisfies PreparedPreservation;
  });

/**
 * One `capture.status` of a candidate's daemon; `undefined` when none was read. What the sampler
 * reads is evidence about the executor like any other reading (review 5 #3): recorded as it
 * arrives, under an observation fence opened before it was asked for (review 6 #5).
 */
const sampleOne = (
  options: PreserveBeforeDeadlineOptions,
  candidate: PreparedPreservation,
  now: () => number,
) =>
  Effect.gen(function* () {
    const { instance } = candidate;
    const target = sealantTargetForRuntimeInstance(instance, options.targetOptions ?? {});
    if (target === undefined) {
      return undefined;
    }
    const status = yield* readCaptureStatus(
      target,
      STATUS_TIMEOUT_MS,
      ledgerObservationRecorder(options.captureDrain.ledger, instance.runId, STATUS_TIMEOUT_MS),
    );
    return status === undefined ? undefined : { status, atMs: now() };
  });

/**
 * Plan and persist one runtime's preservation from its record and, when one was read, a status
 * sample; the plan when its start is reached.
 */
const planOne = (
  options: PreserveBeforeDeadlineOptions,
  candidate: PreparedPreservation,
  sample: { readonly status: CaptureFlushReport; readonly atMs: number } | undefined,
  now: () => number,
) =>
  Effect.gen(function* () {
    const { instance, row, deadlineMs } = candidate;
    const settings = options.deadline;
    const drains = yield* WorkspaceCaptureDrainRepo;
    const status = sample?.status;
    const sampledAtMs = sample?.atMs ?? now();
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
      // The FINAL round trips queued ahead of it count like lead (review 7 #6).
      leadMs: settings.leadMs + candidate.queueAheadMs,
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
      queueAheadMs: candidate.queueAheadMs,
    } satisfies DuePreservation;
  });

/**
 * Drive one due runtime for this tick's budget: its final drain and planned stop; for one whose
 * daemon ended on a machine that runs on (a retained executor), its recovery, now — the recovery
 * sweep restarts its daemon on its own disk and drains it; for a launch still in progress, the
 * launch is taken from its worker and its executor drained like a retained launch.
 */
const driveOne = (
  options: PreserveBeforeDeadlineOptions,
  plan: DuePreservation,
  drive: {
    /** How long its drain may poll: 0 = the one FINAL round trip only. */
    readonly budgetMs: number;
    /** Its drain is started (its FINAL was answered): it opens with a status read. */
    readonly opensWithStatus: boolean;
    /** Told when the drain returns and when the removal begins (review 8 #6). */
    readonly onPhase?: (phase: WorkspaceStopPhase) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const { instance } = plan;
    if (instance.status === "pending") {
      // A launch still in progress when its preservation start arrives (a slow readiness wait,
      // a worker that died before its lease lapsed): a pending state cannot postpone the
      // platform's cap. The launch is taken from its worker (`preemptLaunch`: every later write of
      // that worker is fenced, and it abandons the launch) and becomes a retained launch, and the
      // executor it created gets its FINAL drain now, like any other.
      const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
      const preempted = yield* runtimeInstances.preemptLaunch({
        runId: instance.runId,
        errorMessage: `The runtime ends at ${new Date(plan.deadlineMs).toISOString()} (its own deadline) and its launch had not settled when its preservation had to start; the launch was taken from its worker and the executor kept as a retained launch, drained before it is stopped.`,
      });
      if (preempted === undefined) {
        // It settled in between: the next tick drives it as what it became.
        return "not-driven" as const;
      }
      yield* (yield* WorkspaceAttemptRepo)
        .markAttemptFailed({ id: instance.runId })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `Deadline preservation: marking run ${instance.runId}'s attempt failed failed.`,
              cause,
            ),
          ),
        );
      yield* Effect.logError(
        `Deadline preservation: run ${instance.runId} ends at ${new Date(plan.deadlineMs).toISOString()} and its launch had not settled by its preservation start (lead ${String(Math.round(options.deadline.leadMs / 1000))} s + upload estimate ${String(Math.round(plan.estimateMs / 1000))} s): the launch is taken from its worker (${instance.launchOwner ?? "no owner recorded"}) and kept as a retained launch · starting its final drain now.`,
      );
    }
    if (instance.status === "failed" && instance.errorCode !== LAUNCH_RETAINED_ERROR_CODE) {
      const drains = yield* WorkspaceCaptureDrainRepo;
      const due = yield* drains.requestRecovery(instance.runId);
      if (due === undefined) {
        return "not-driven" as const;
      }
      yield* (plan.firstStart ? Effect.logError : Effect.logWarning)(
        `Deadline preservation: run ${instance.runId} ends at ${new Date(plan.deadlineMs).toISOString()} (the runtime's own deadline) and its daemon ended with work not confirmed saved: not saved · retained; its recovery is due now (restart on its own disk, then a final drain).`,
      );
      return "recovery-due" as const;
    }
    if (plan.firstStart && instance.status !== "pending") {
      yield* Effect.logWarning(
        `Deadline preservation: run ${instance.runId} ends at ${new Date(plan.deadlineMs).toISOString()} (the runtime's own deadline); starting its final drain and a planned stop now (lead ${String(Math.round(options.deadline.leadMs / 1000))} s + upload estimate ${String(Math.round(plan.estimateMs / 1000))} s${plan.queueAheadMs > 0 ? ` + ${String(Math.round(plan.queueAheadMs / 1000))} s of FINAL round trips queued ahead of it` : ""}).`,
      );
    }
    const workspaces = yield* WorkspaceRepo;
    const workspace = yield* workspaces.getWorkspaceByAttemptId(instance.runId);
    return yield* processWorkspaceStopEffect({
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
        budgetMs: drive.budgetMs,
        label: "deadline preservation",
        ...(drive.opensWithStatus ? { opensWithStatus: true } : {}),
        ...(drive.onPhase === undefined ? {} : { onPhase: drive.onPhase }),
      },
    });
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
