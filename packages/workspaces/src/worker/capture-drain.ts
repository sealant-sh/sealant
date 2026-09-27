/**
 * Drain before stop: a capture-sourced workspace (sealantd ADR-0015) holds work that exists
 * nowhere else until the daemon's capture queue is empty — staged captures live on the executor's
 * own disk and are lost with it. Every platform-initiated stop (the expiry, stranded, superseded
 * and orphaned reapers, a lifecycle stop, the exit reconciler when the daemon still answers) asks
 * the daemon to flush and then polls `capture.status` until `pending === 0` before the runtime is
 * torn down.
 *
 * The rules, in order:
 *
 *  - **drained**: the daemon reports `pending === 0` — the stop proceeds.
 *  - **pending**: the queue is still moving (or the daemon stopped answering only moments ago)
 *    and this call's time budget is spent — the stop is deferred; the caller comes back later
 *    (the reaper's next tick) and the same tracker entry carries the progress forward.
 *  - **stalled**: the daemon answers but nothing moved for the stall window — the workspace is
 *    KEPT and logged `not saved · kept`. Nothing stops it; the next sweep re-checks, and a queue
 *    that starts moving again drains and stops normally.
 *  - **unreachable**: the daemon has not answered for the unreachable window — treated as the
 *    crash it almost certainly is; the stop proceeds and says so loudly.
 *
 * Progress is state across calls (`CaptureDrainTracker`), so a drain spanning many reaper ticks
 * measures its stall window from the last time anything moved, not from the current tick.
 */
import { Clock, Effect } from "effect";
import { z } from "zod";

import {
  SealantControlError,
  SealantRuntime,
  type CaptureFlushReport,
  type SealantTarget,
} from "../sealantd/runtime.js";

export interface CaptureDrainSettings {
  /** How often `capture.status` is polled while the queue drains. */
  readonly pollIntervalMs: number;
  /** Answering but no progress for this long: keep the workspace (`not saved · kept`). */
  readonly stallWindowMs: number;
  /** No answer at all for this long: the daemon is gone; the stop may proceed. */
  readonly unreachableWindowMs: number;
  /** Bound on one flush or status round trip (the daemon bounds its own flush; this is a net). */
  readonly requestTimeoutMs: number;
}

export const DEFAULT_CAPTURE_DRAIN_SETTINGS: CaptureDrainSettings = {
  pollIntervalMs: 5_000,
  stallWindowMs: 10 * 60_000,
  unreachableWindowMs: 5 * 60_000,
  requestTimeoutMs: 60_000,
};

/** What one drain call concluded; only `drained` and `unreachable` let a stop proceed. */
export type CaptureDrainOutcome =
  | { readonly kind: "drained"; readonly status: CaptureFlushReport }
  | { readonly kind: "pending"; readonly status: CaptureFlushReport | undefined }
  | {
      readonly kind: "stalled";
      readonly status: CaptureFlushReport | undefined;
      readonly stalledForMs: number;
      readonly detail: string | undefined;
    }
  | { readonly kind: "unreachable"; readonly unreachableForMs: number; readonly detail: string }
  /** Another drain of the same run is in flight (overlapping sweeps); do nothing this time. */
  | { readonly kind: "busy" };

/** Whether an outcome lets the caller tear the runtime down now. */
export const drainPermitsStop = (outcome: CaptureDrainOutcome): boolean =>
  outcome.kind === "drained" || outcome.kind === "unreachable";

interface DrainEntry {
  /** When the daemon last answered with movement (or first answered at all). */
  lastProgressAt: number | undefined;
  last: CaptureFlushReport | undefined;
  unreachableSince: number | undefined;
  /** The stall was already logged; the next log line is the one that says it moved again. */
  keptLogged: boolean;
}

/**
 * Per-worker memory of every drain in progress. Plain state, shared by every sweep of one worker
 * process (reaper, lifecycle consumer, exit reconciler): overlapping calls for one run are refused
 * (`busy`), and progress survives between calls. A worker restart forgets it, which only restarts
 * the stall window — the conservative direction.
 */
export class CaptureDrainTracker {
  readonly #entries = new Map<string, DrainEntry>();
  readonly #inFlight = new Set<string>();

  /** Claim the run for one drain call; false when another call holds it. */
  tryBegin(runId: string): boolean {
    if (this.#inFlight.has(runId)) {
      return false;
    }
    this.#inFlight.add(runId);
    return true;
  }

  end(runId: string): void {
    this.#inFlight.delete(runId);
  }

  entry(runId: string): DrainEntry {
    const existing = this.#entries.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const created: DrainEntry = {
      lastProgressAt: undefined,
      last: undefined,
      unreachableSince: undefined,
      keptLogged: false,
    };
    this.#entries.set(runId, created);
    return created;
  }

  /** Drop a run's state once its runtime is gone. */
  forget(runId: string): void {
    this.#entries.delete(runId);
  }

  /** Runs with drain state (tests and diagnostics). */
  runIds(): readonly string[] {
    return [...this.#entries.keys()];
  }
}

/** Only the source kind is read, so a snapshot of any vintage answers. */
const blueprintSourceSchema = z.object({
  sources: z.object({ workspace: z.object({ kind: z.string() }) }),
});

/** Whether a stored blueprint payload names a capture source (sealantd ADR-0015). */
export const isCaptureSourcedBlueprint = (blueprintPayload: unknown): boolean => {
  const parsed = blueprintSourceSchema.safeParse(blueprintPayload);
  return parsed.success && parsed.data.sources.workspace.kind === "capture";
};

/** The queue moved: fewer pending, or more uploaded or registered, since the last answer. */
export const captureProgressed = (
  previous: CaptureFlushReport | undefined,
  next: CaptureFlushReport,
): boolean =>
  previous === undefined ||
  next.pending < previous.pending ||
  next.uploadedBytes > previous.uploadedBytes ||
  next.uploadedObjects > previous.uploadedObjects ||
  next.registered > previous.registered;

export const describeCaptureStatus = (status: CaptureFlushReport): string =>
  [
    `pending ${String(status.pending)}`,
    `staged ${String(status.stagedBytes)} bytes`,
    `uploaded ${String(status.uploadedBytes)} bytes`,
    `registered ${String(status.registered)}`,
    ...(status.fenced ? ["fenced"] : []),
    ...(status.paused ? ["paused"] : []),
  ].join(" · ");

type Sample =
  | { readonly kind: "status"; readonly status: CaptureFlushReport }
  /** The daemon answered but refused the command: it is alive, the queue cannot be read. */
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "unreachable"; readonly detail: string };

const sampleCapture = (
  target: SealantTarget,
  command: "flush" | "status",
  timeoutMs: number,
): Effect.Effect<Sample, never, SealantRuntime> =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* SealantRuntime;
      const daemon = yield* runtime.connect(target);
      return yield* command === "flush" ? daemon.captureFlush() : daemon.captureStatus();
    }),
  ).pipe(
    Effect.timeout(timeoutMs),
    Effect.map((status): Sample => ({ kind: "status", status })),
    Effect.catch((error) =>
      Effect.succeed<Sample>(
        error instanceof SealantControlError
          ? { kind: "refused", detail: error.message }
          : {
              kind: "unreachable",
              detail: error instanceof Error ? error.message : `capture ${command} timed out`,
            },
      ),
    ),
    Effect.catchDefect((defect) =>
      Effect.succeed<Sample>({
        kind: "unreachable",
        detail: defect instanceof Error ? defect.message : String(defect),
      }),
    ),
  );

/**
 * One `capture.status` round trip: whether the daemon answers at all (a refusal is an answer).
 * The exit reconciler asks this before recording an exit — a runtime whose daemon still answers
 * is not dead, whatever the runtime reports, and must be drained before anything removes it.
 */
export const captureDaemonAnswers = (
  target: SealantTarget,
  timeoutMs: number,
): Effect.Effect<boolean, never, SealantRuntime> =>
  sampleCapture(target, "status", timeoutMs).pipe(
    Effect.map((sample) => sample.kind !== "unreachable"),
  );

export interface DrainCaptureInput {
  readonly runId: string;
  /** How to reach the daemon (any adapter). */
  readonly target: SealantTarget;
  readonly tracker: CaptureDrainTracker;
  readonly settings: CaptureDrainSettings;
  /** How long THIS call may wait before returning `pending`; the tracker carries the rest. */
  readonly budgetMs: number;
  /** Who is stopping and why, for the log lines ("expiry reaper", "exit reconciler", …). */
  readonly label: string;
}

/**
 * Flush, then poll the daemon's capture status until the queue is empty, the budget is spent,
 * the queue stalls, or the daemon stays silent for the unreachable window. Never fails.
 */
export const drainCaptureBeforeStop = Effect.fn("drainCaptureBeforeStop")(function* (
  input: DrainCaptureInput,
) {
  const { runId, tracker, settings, label } = input;
  if (!tracker.tryBegin(runId)) {
    return { kind: "busy" } satisfies CaptureDrainOutcome;
  }
  const prefix = `Capture drain (${label}) · run ${runId}`;
  return yield* Effect.gen(function* () {
    const entry = tracker.entry(runId);
    const startedAt = yield* Clock.currentTimeMillis;
    let command: "flush" | "status" = "flush";

    for (;;) {
      const sample = yield* sampleCapture(input.target, command, settings.requestTimeoutMs);
      const now = yield* Clock.currentTimeMillis;
      let refusedDetail: string | undefined;

      if (sample.kind === "unreachable") {
        entry.unreachableSince ??= now;
        const unreachableForMs = now - entry.unreachableSince;
        if (unreachableForMs >= settings.unreachableWindowMs) {
          yield* Effect.logError(
            `${prefix}: not saved · sealantd has not answered for ${String(Math.round(unreachableForMs / 1000))} s (${sample.detail}); the stop proceeds without a drain.${
              entry.last === undefined ? "" : ` Last status: ${describeCaptureStatus(entry.last)}.`
            }`,
          );
          return {
            kind: "unreachable",
            unreachableForMs,
            detail: sample.detail,
          } satisfies CaptureDrainOutcome;
        }
        yield* Effect.logWarning(
          `${prefix}: sealantd did not answer (${sample.detail}); retrying before any stop.`,
        );
      } else {
        entry.unreachableSince = undefined;
        // The first answer starts the stall window; a flush after that is the only command
        // needed — the daemon keeps shipping on its own while the executor lives.
        entry.lastProgressAt ??= now;
        command = "status";
        if (sample.kind === "refused") {
          refusedDetail = sample.detail;
          yield* Effect.logWarning(
            `${prefix}: sealantd refused the capture command: ${sample.detail}`,
          );
        } else {
          const { status } = sample;
          const moved = captureProgressed(entry.last, status);
          if (moved) {
            entry.lastProgressAt = now;
          }
          if (status.pending === 0) {
            yield* Effect.logInfo(`${prefix}: saved · ${describeCaptureStatus(status)}`);
            entry.last = status;
            entry.keptLogged = false;
            return { kind: "drained", status } satisfies CaptureDrainOutcome;
          }
          if (moved) {
            yield* Effect.logInfo(`${prefix}: saving · ${describeCaptureStatus(status)}`);
            entry.keptLogged = false;
          }
          entry.last = status;
        }

        const stalledForMs = now - (entry.lastProgressAt ?? now);
        if (stalledForMs >= settings.stallWindowMs) {
          if (!entry.keptLogged) {
            entry.keptLogged = true;
            yield* Effect.logError(
              `${prefix}: not saved · kept · no capture progress for ${String(Math.round(stalledForMs / 1000))} s${
                entry.last === undefined ? "" : ` · ${describeCaptureStatus(entry.last)}`
              }${refusedDetail === undefined ? "" : ` · ${refusedDetail}`}. The workspace is left running; nothing stops it until its queue drains.`,
            );
          }
          return {
            kind: "stalled",
            status: entry.last,
            stalledForMs,
            detail: refusedDetail,
          } satisfies CaptureDrainOutcome;
        }
      }

      if (now - startedAt + settings.pollIntervalMs > input.budgetMs) {
        return { kind: "pending", status: entry.last } satisfies CaptureDrainOutcome;
      }
      yield* Effect.sleep(settings.pollIntervalMs);
    }
  }).pipe(Effect.ensuring(Effect.sync(() => tracker.end(runId))));
});
