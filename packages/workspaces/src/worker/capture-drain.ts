/**
 * Drain before stop: a capture-sourced workspace (sealantd ADR-0015) holds work that exists
 * nowhere else until the daemon has saved it — staged captures live on the executor's own disk and
 * are lost with it. Every platform-initiated stop (the expiry, stranded, superseded and orphaned
 * reapers, a lifecycle stop, a retained launch, the deadline sweep, the exit reconciler when the
 * daemon still answers) asks the daemon for a FINAL flush — this executor is ending — and then
 * polls `capture.status` before the runtime is torn down.
 *
 * The rules, in order:
 *
 *  - **drained** (`saved`): the daemon reports the final flush `complete` — it quiesced every
 *    managed process, snapshotted both capture classes, and registered everything. The stop
 *    proceeds. Nothing else counts: `pending === 0` alone is not proof (a daemon that never
 *    snapshotted bulk reports an empty queue), and a daemon that does not report `complete` at
 *    all (every release up to the pinned 0.18.2) is never taken as saved.
 *  - **pending**: the queue is still moving (or the daemon stopped answering only moments ago)
 *    and this call's time budget is spent — the stop is deferred; the caller comes back later and
 *    the ledger carries the progress forward.
 *  - **unconfirmed**: the queue is empty but the daemon did not report the final flush complete —
 *    the workspace is KEPT, logged `not saved · not confirmed · kept`; the next sweep flushes
 *    again.
 *  - **stalled**: the daemon answers but nothing moved for the stall window, or it reports a
 *    capture class `refused` for the session's quota — KEPT, logged `not saved · kept` /
 *    `not saved · refused · kept`. Nothing stops it; the next sweep re-checks.
 *  - **silent**: the daemon has not answered for the silent window while the runtime still
 *    reports the executor running — KEPT, logged `not saved · daemon silent · kept`.
 *  - **gone**: the daemon is silent AND the runtime positively reports nothing of the executor
 *    left (`missing`) — there is no disk to keep, so the stop proceeds (it only cleans up). An
 *    executor that EXITED keeps its disk, which holds whatever was not saved (sealantd exits 75
 *    after an incomplete final flush, and a plain `docker stop` or a lost reply looks the same):
 *    it is kept (`silent`), whatever this or any earlier drain saw, unless the preservation
 *    policy (`executor-preservation.ts`) finds evidence it may go.
 *  - **busy**: another worker holds the run's drain; this call does nothing.
 *
 * A daemon that reports a class's snaps failing (`snaps`) is saving none of that class's newest
 * work, whatever `pending` says: the drain logs it as an error once per distinct error,
 * and every keep it concludes names it. It never lets a stop proceed (a failing snap never
 * reports the final flush complete).
 *
 * The FINAL flush carries a deadline (`finalFlushDeadlineMs`, never more than the round trip's
 * own bound less a margin, so the daemon answers before the worker gives up on it) and a grace
 * (`finalFlushGraceMs`, SIGTERM to SIGKILL for managed processes, inside the deadline). A FINAL
 * past its deadline answers `complete: false` and keeps shipping in the daemon (sealantd #102):
 * the status polls that follow, the second flush and the next sweep's flush all see the same
 * shipment move on, so a large upload converges over several polls rather than restarting.
 *
 * Progress and ownership are durable (`CaptureDrainLedger`; the worker's is the
 * `workspace_capture_drains` table): one drain of a run at a time — across every worker process,
 * and within one (every claim carries its own token, so two sweeps of one worker never share a
 * lease), a drain spanning many sweeps (or moving to another worker when its holder dies)
 * measures its stall window from the last time anything moved, and the last observation is what
 * the API reports while a stop is in progress.
 */
import { Clock, Effect } from "effect";
import { z } from "zod";

import {
  attestationCoversExecutor,
  type ExecutorDeletionBasis,
  type ExecutorIdentity,
} from "../runtime/executor-preservation.js";
import {
  SealantControlError,
  SealantRuntime,
  type CaptureFlushReport,
  type CaptureFlushRequest,
  type SealantTarget,
} from "../sealantd/runtime.js";

export interface CaptureDrainSettings {
  /** How often `capture.status` is polled while the queue drains. */
  readonly pollIntervalMs: number;
  /** Answering but no progress for this long: keep the workspace (`not saved · kept`). */
  readonly stallWindowMs: number;
  /**
   * No answer at all for this long: ask the runtime whether the executor still exists. Running:
   * kept (`not saved · daemon silent · kept`). Ended: the stop proceeds.
   */
  readonly unreachableWindowMs: number;
  /** Bound on one flush or status round trip (the daemon bounds its own flush; this is a net). */
  readonly requestTimeoutMs: number;
  /**
   * The FINAL flush's deadline sent to the daemon (wire `deadline_ms`). Capped at
   * `requestTimeoutMs` less a margin so the daemon answers inside the round trip; absent, the
   * cap itself. A FINAL past it answers incomplete and keeps shipping (sealantd #102).
   */
  readonly finalFlushDeadlineMs?: number;
  /**
   * The FINAL flush's SIGTERM → SIGKILL grace for managed processes (wire `grace_ms`), counted
   * inside the deadline and capped at it. Absent: `DEFAULT_FINAL_FLUSH_GRACE_MS`.
   */
  readonly finalFlushGraceMs?: number;
  /**
   * How long a worker's claim on a run's drain lasts without renewal (every poll renews it). A
   * worker that dies mid-drain loses the run to the next sweep of any worker after this.
   */
  readonly leaseMs?: number;
}

export const DEFAULT_CAPTURE_DRAIN_SETTINGS: CaptureDrainSettings = {
  pollIntervalMs: 5_000,
  stallWindowMs: 10 * 60_000,
  unreachableWindowMs: 5 * 60_000,
  requestTimeoutMs: 60_000,
  leaseMs: 3 * 60_000,
};

const DEFAULT_LEASE_MS = 3 * 60_000;

/** Managed processes get this long between SIGTERM and SIGKILL when a drain's FINAL runs. */
export const DEFAULT_FINAL_FLUSH_GRACE_MS = 30_000;

/** Headroom between the daemon's deadline and the worker's round-trip bound: 5 s, or a tenth. */
const finalFlushDeadlineMargin = (requestTimeoutMs: number): number =>
  Math.min(5_000, Math.floor(requestTimeoutMs / 10));

/**
 * The FINAL flush a drain sends: `kind: "final"`, a deadline inside the round trip's own bound
 * (`requestTimeoutMs` less a margin, or `finalFlushDeadlineMs` when lower) and a grace inside
 * that deadline.
 */
export const finalFlushRequest = (settings: CaptureDrainSettings): CaptureFlushRequest => {
  const cap = Math.max(
    1,
    settings.requestTimeoutMs - finalFlushDeadlineMargin(settings.requestTimeoutMs),
  );
  const deadlineMs = Math.min(settings.finalFlushDeadlineMs ?? cap, cap);
  const graceMs = Math.min(settings.finalFlushGraceMs ?? DEFAULT_FINAL_FLUSH_GRACE_MS, deadlineMs);
  return { kind: "final", deadlineMs, graceMs };
};

/** What one drain call concluded; only `drained` and `gone` let a stop proceed. */
export type CaptureDrainOutcome =
  | { readonly kind: "drained"; readonly status: CaptureFlushReport }
  | { readonly kind: "pending"; readonly status: CaptureFlushReport | undefined }
  /** The queue is empty but the daemon did not report the final flush complete: kept. */
  | { readonly kind: "unconfirmed"; readonly status: CaptureFlushReport; readonly detail: string }
  | {
      readonly kind: "stalled";
      readonly status: CaptureFlushReport | undefined;
      readonly stalledForMs: number;
      readonly detail: string | undefined;
    }
  /** The daemon is silent but the runtime reports the executor running: kept. */
  | { readonly kind: "silent"; readonly silentForMs: number; readonly detail: string }
  /** The daemon is silent and the runtime reports nothing of the executor left: nothing to keep. */
  | { readonly kind: "gone"; readonly silentForMs: number; readonly detail: string }
  /** Another drain of the same run is in flight (another sweep or worker); do nothing this time. */
  | { readonly kind: "busy" };

/** Whether an outcome lets the caller tear the runtime down now. */
export const drainPermitsStop = (outcome: CaptureDrainOutcome): boolean =>
  outcome.kind === "drained" || outcome.kind === "gone";

/** A drain's progress across calls: what the ledger keeps between sweeps and workers. */
export interface CaptureDrainEntry {
  /** When the daemon last answered with movement (or first answered at all). */
  readonly lastProgressAt: number | undefined;
  readonly last: CaptureFlushReport | undefined;
  readonly unreachableSince: number | undefined;
  /** The keep was already logged; the next log line is the one that says it moved again. */
  readonly keptLogged: boolean;
  /** Likewise for a silent daemon on a running executor. */
  readonly silentLogged: boolean;
  /**
   * The owner asked to discard this run's unsaved captures (the audit: when, and who). Read-only
   * here: the API records it, every stop path honours it by terminating without a drain.
   */
  readonly discardRequested?: { readonly atMs: number; readonly by: string } | undefined;
  /**
   * The control plane's attestation, from a stop request, that its store holds a sealed FINAL of
   * this run's executor (`executor-preservation.ts`); the preservation policy checks the
   * executor id and epoch before it counts.
   */
  readonly completionAttested?:
    | {
        readonly executorId: string;
        readonly epoch: number;
        readonly captureN: number;
        readonly atMs: number;
        readonly by: string;
      }
    | undefined;
  /**
   * The executor is retained: kept because its disk holds work not confirmed saved. Recovery
   * (`recover-retained-executors.ts`) retries on a backoff until it is saved, gone or discarded.
   */
  readonly retained?:
    | {
        readonly atMs: number;
        readonly reason: string;
        readonly recoveryAttempts: number;
        readonly nextRecoveryAtMs: number | undefined;
        readonly lastRecoveryError: string | undefined;
      }
    | undefined;
}

export const EMPTY_CAPTURE_DRAIN_ENTRY: CaptureDrainEntry = {
  lastProgressAt: undefined,
  last: undefined,
  unreachableSince: undefined,
  keptLogged: false,
  silentLogged: false,
};

/** What the last observation concluded, for the API (`workspace_capture_drains.state`). */
export type CaptureDrainState =
  | "draining"
  | "kept"
  | "saved"
  | "gone"
  | "stop-failed"
  | "stopped"
  | "discarded";

export interface CaptureDrainObservation {
  readonly state: CaptureDrainState;
  readonly detail: string | undefined;
}

/** One drain's hold on a run: its progress, and the token that is its lease. */
export interface CaptureDrainClaim {
  readonly entry: CaptureDrainEntry;
  /** Unique per claim: two drains of one run never share a lease, not even within one worker. */
  readonly token: string;
}

/**
 * What a read of a run's drain record found: the entry (`undefined` when there is none), or that
 * it could not be read — which is NOT "none": nothing in it (a completion, an attestation, a
 * discard) is known, and the preservation policy keeps the executor.
 */
export type CaptureDrainRead =
  | { readonly readable: true; readonly entry: CaptureDrainEntry | undefined }
  | { readonly readable: false };

/**
 * Where a drain's ownership and progress live. The worker's ledger is the database
 * (`databaseCaptureDrainLedger`): a claim is a lease on the run's `workspace_capture_drains` row,
 * so no two drains of one run ever overlap — across workers, and within one worker (each claim
 * has its own token) — and a lease whose holder died is taken over once it expires. Methods
 * never fail: a claim that cannot be made answers `undefined` (busy — nothing is stopped), a
 * write that cannot be made answers `false` (the claim is given up), a record that cannot be read
 * answers `{ readable: false }`.
 */
export interface CaptureDrainLedger {
  /** Claim the run's drain for this call and load its progress; `undefined` when held elsewhere. */
  readonly claim: (runId: string) => Effect.Effect<CaptureDrainClaim | undefined>;
  /** Persist progress (and the observation, when one was made) and renew the claim. */
  readonly save: (
    runId: string,
    token: string,
    entry: CaptureDrainEntry,
    observation: CaptureDrainObservation | undefined,
  ) => Effect.Effect<boolean>;
  /** Give the claim up; progress and the observation stay. */
  readonly release: (runId: string, token: string) => Effect.Effect<void>;
  /** The run's recorded progress, without claiming it. */
  readonly read: (runId: string) => Effect.Effect<CaptureDrainRead>;
  /**
   * Record an observation outside a drain (what the stop that followed it did); no claim needed.
   * `stopped`, `discarded` and `gone` also end a retention. Best-effort: a failed write is logged.
   */
  readonly observe: (runId: string, observation: CaptureDrainObservation) => Effect.Effect<void>;
  /**
   * Record that the run's executor is retained (kept: its disk holds work not confirmed saved),
   * with why; recovery picks it up. Keeps the first instant. Best-effort: a failed write is
   * logged loudly (the executor is kept either way).
   */
  readonly markRetained: (runId: string, reason: string) => Effect.Effect<void>;
}

/** Rows of an in-memory ledger; share one store between ledgers to model several workers. */
export class InMemoryCaptureDrainStore {
  readonly rows = new Map<
    string,
    {
      entry: CaptureDrainEntry;
      observation: CaptureDrainObservation | undefined;
      owner: string | undefined;
      expiresAt: number | undefined;
    }
  >();
}

let inMemoryOwnerSequence = 0;
let inMemoryClaimSequence = 0;

/** Whether an observation ends a retention: the executor was removed, or found gone. */
export const observationEndsRetention = (state: CaptureDrainState): boolean =>
  state === "stopped" || state === "discarded" || state === "gone";

/** A lease holder for one claim: the ledger's owner plus a token unique to the claim. */
export const claimLeaseOwner = (owner: string, token: string): string => `${owner}#${token}`;

/**
 * An in-memory ledger with the database ledger's lease semantics (tests, single-process tools).
 * Ledgers built on one `store` behave like workers sharing one database.
 */
export const inMemoryCaptureDrainLedger = (
  options: {
    readonly store?: InMemoryCaptureDrainStore;
    readonly owner?: string;
    readonly leaseMs?: number;
    readonly now?: () => number;
  } = {},
): CaptureDrainLedger & { readonly store: InMemoryCaptureDrainStore } => {
  const store = options.store ?? new InMemoryCaptureDrainStore();
  inMemoryOwnerSequence += 1;
  const owner = options.owner ?? `ledger-${String(inMemoryOwnerSequence)}`;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? Date.now;
  return {
    store,
    claim: (runId) =>
      Effect.sync(() => {
        inMemoryClaimSequence += 1;
        const token = String(inMemoryClaimSequence);
        const holder = claimLeaseOwner(owner, token);
        const row = store.rows.get(runId);
        if (row === undefined) {
          store.rows.set(runId, {
            entry: EMPTY_CAPTURE_DRAIN_ENTRY,
            observation: undefined,
            owner: holder,
            expiresAt: now() + leaseMs,
          });
          return { entry: EMPTY_CAPTURE_DRAIN_ENTRY, token };
        }
        const free =
          row.owner === undefined || row.expiresAt === undefined || row.expiresAt <= now();
        if (!free) {
          return undefined;
        }
        row.owner = holder;
        row.expiresAt = now() + leaseMs;
        return { entry: row.entry, token };
      }),
    save: (runId, token, entry, observation) =>
      Effect.sync(() => {
        const row = store.rows.get(runId);
        if (row === undefined || row.owner !== claimLeaseOwner(owner, token)) {
          return false;
        }
        row.entry = entry;
        row.observation = observation ?? row.observation;
        row.expiresAt = now() + leaseMs;
        return true;
      }),
    release: (runId, token) =>
      Effect.sync(() => {
        const row = store.rows.get(runId);
        if (row !== undefined && row.owner === claimLeaseOwner(owner, token)) {
          row.owner = undefined;
          row.expiresAt = undefined;
        }
      }),
    read: (runId) =>
      Effect.sync(() => ({ readable: true as const, entry: store.rows.get(runId)?.entry })),
    observe: (runId, observation) =>
      Effect.sync(() => {
        const row = store.rows.get(runId);
        if (row === undefined) {
          store.rows.set(runId, {
            entry: EMPTY_CAPTURE_DRAIN_ENTRY,
            observation,
            owner: undefined,
            expiresAt: undefined,
          });
        } else {
          row.observation = observation;
          if (observationEndsRetention(observation.state)) {
            row.entry = { ...row.entry, retained: undefined };
          }
        }
      }),
    markRetained: (runId, reason) =>
      Effect.sync(() => {
        const row = store.rows.get(runId) ?? {
          entry: EMPTY_CAPTURE_DRAIN_ENTRY,
          observation: undefined,
          owner: undefined,
          expiresAt: undefined,
        };
        const retained = row.entry.retained;
        row.entry = {
          ...row.entry,
          retained: {
            atMs: retained?.atMs ?? now(),
            reason,
            recoveryAttempts: retained?.recoveryAttempts ?? 0,
            nextRecoveryAtMs: retained?.nextRecoveryAtMs ?? now(),
            lastRecoveryError: retained?.lastRecoveryError,
          },
        };
        row.observation = { state: "kept", detail: `not saved · retained · ${reason}` };
        store.rows.set(runId, row);
      }),
  };
};

/** Only the source kind is read, so a snapshot of any vintage answers. */
const blueprintSourceSchema = z.object({
  sources: z.object({ workspace: z.object({ kind: z.string() }) }),
});

/** A stored blueprint payload's `sources.workspace.kind`; `undefined` when it cannot be read. */
export const blueprintSourceKind = (blueprintPayload: unknown): string | undefined => {
  const parsed = blueprintSourceSchema.safeParse(blueprintPayload);
  return parsed.success ? parsed.data.sources.workspace.kind : undefined;
};

/** Whether a stored blueprint payload names a capture source (sealantd ADR-0015). */
export const isCaptureSourcedBlueprint = (blueprintPayload: unknown): boolean =>
  blueprintSourceKind(blueprintPayload) === "capture";

/**
 * Whether a run must be treated as capture-sourced before its runtime is stopped. FAILS CLOSED:
 * the source kind recorded on the runtime instance decides; a row that predates it falls back
 * to the attempt snapshot; a run whose source cannot be read at all (no recorded kind, no
 * snapshot, or a snapshot that does not name its source) IS treated as capture-sourced — drained,
 * and kept when the drain cannot confirm — because stopping unknown work unsaved is the one
 * mistake that cannot be undone. A failed snapshot read fails the effect (the caller leaves the
 * runtime alone this time).
 */
export const runIsCaptureSourced = <E, R>(input: {
  readonly runId: string;
  /** `workspace_runtime_instances.source_kind`; null on rows that predate it. */
  readonly sourceKind: string | null | undefined;
  /** The attempt snapshot's blueprint payload, `undefined` when there is no snapshot. */
  readonly readSnapshotPayload: Effect.Effect<
    { readonly blueprintPayload: unknown } | undefined,
    E,
    R
  >;
}): Effect.Effect<boolean, E, R> =>
  Effect.gen(function* () {
    if (input.sourceKind !== null && input.sourceKind !== undefined) {
      return input.sourceKind === "capture";
    }
    const snapshot = yield* input.readSnapshotPayload;
    const kind =
      snapshot === undefined ? undefined : blueprintSourceKind(snapshot.blueprintPayload);
    if (kind === undefined) {
      yield* Effect.logWarning(
        `Capture drain: run ${input.runId} records no workspace source (${
          snapshot === undefined ? "no attempt snapshot" : "the snapshot names none"
        }); treated as capture-sourced, so it is drained before any stop.`,
      );
      return true;
    }
    return kind === "capture";
  });

/** Whether Core itself read `complete: true` from the run's daemon (the drain's last status). */
export const observedComplete = (entry: CaptureDrainEntry | undefined): boolean =>
  entry?.last?.complete === true;

/**
 * Whether the control plane's recorded attestation covers THIS executor: it names the run's
 * executor and is not for an epoch older than the executor last reported
 * (`attestationCoversExecutor`). No attestation, or one about another executor, is `false`.
 */
export const attestedCompleteFor = (
  entry: CaptureDrainEntry | undefined,
  executor: ExecutorIdentity,
): boolean => {
  const attested = entry?.completionAttested;
  return (
    attested !== undefined &&
    attestationCoversExecutor(attested, executor, entry?.last?.epoch).covers
  );
};

/** What the drain record says of an executor, for the preservation policy. */
export const recordedDeletionEvidence = (
  record: CaptureDrainRead,
  executor: ExecutorIdentity,
): {
  readonly observedComplete: boolean;
  readonly attestedComplete: boolean;
  readonly discarded: boolean;
  readonly ledgerUnreadable: boolean;
} =>
  record.readable
    ? {
        observedComplete: observedComplete(record.entry),
        attestedComplete: attestedCompleteFor(record.entry, executor),
        discarded: record.entry?.discardRequested !== undefined,
        ledgerUnreadable: false,
      }
    : {
        observedComplete: false,
        attestedComplete: false,
        discarded: false,
        ledgerUnreadable: true,
      };

/** Why a deletion was allowed, as a status line. */
export const describeDeletionBasis = (basis: ExecutorDeletionBasis): string => {
  switch (basis) {
    case "not-capture":
      return "the executor holds no captures";
    case "missing":
      return "nothing of the executor was left";
    case "observed-complete":
      return "its daemon reported the final flush complete";
    case "attested-complete":
      return "the control plane attested a sealed final capture of this executor";
    case "discarded":
      return "the owner discarded its unsaved captures";
  }
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
  next.registered > previous.registered ||
  (next.complete === true && previous.complete !== true);

/** A daemon-supplied string cut for a log line: a path can be longer than PATH_MAX. */
const clip = (text: string, max = 160): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The failing classes' errors as one comparable key; `undefined` when no class is failing. */
const snapFailureKey = (status: CaptureFlushReport | undefined): string | undefined => {
  const failing = (status?.snaps ?? []).flatMap((entry) =>
    entry.lastSnapError === undefined ? [] : [`${entry.class}: ${entry.lastSnapError}`],
  );
  return failing.length === 0 ? undefined : failing.join("\n");
};

/**
 * Snaps are failing (sealantd `snaps`, per class): the executor's newest work in that class is
 * not being captured, whatever `pending` says. One part per failing class; `undefined` when the
 * daemon reports no class failing.
 */
export const snapFailureDetail = (status: CaptureFlushReport): string | undefined => {
  const parts = (status.snaps ?? []).flatMap((entry) =>
    entry.lastSnapError === undefined
      ? []
      : [
          `${entry.class} snaps failing${
            entry.snapFailingSinceUnixMs === undefined
              ? ""
              : ` since ${new Date(entry.snapFailingSinceUnixMs).toISOString()}`
          } (${String(entry.snapsFailed)} failed): ${clip(entry.lastSnapError, 400)}`,
        ],
  );
  return parts.length === 0 ? undefined : parts.join(" · ");
};

export const describeCaptureStatus = (status: CaptureFlushReport): string => {
  const snapFailure = snapFailureDetail(status);
  return [
    `pending ${String(status.pending)}`,
    ...(status.pendingBulk === undefined || status.pendingBulk === 0
      ? []
      : [`${String(status.pendingBulk)} bulk pending`]),
    ...(status.bulkBuilding === true ? ["bulk building"] : []),
    ...(status.pendingBytes === undefined ? [] : [`${String(status.pendingBytes)} bytes to ship`]),
    `staged ${String(status.stagedBytes)} bytes`,
    `uploaded ${String(status.uploadedBytes)} bytes`,
    `registered ${String(status.registered)}`,
    status.complete === true
      ? "final flush complete"
      : status.complete === false
        ? `final flush incomplete${status.incompleteReason === undefined ? "" : ` (${status.incompleteReason})`}`
        : "completion not reported",
    ...(status.fenced ? ["fenced"] : []),
    ...(status.paused ? ["paused"] : []),
    ...(status.refused.length === 0 ? [] : [`refused ${status.refused.join(", ")}`]),
    ...(snapFailure === undefined ? [] : [snapFailure]),
    ...(status.unreadable === undefined || status.unreadable === 0
      ? []
      : [
          `unreadable ${String(status.unreadable)}${
            status.carried === undefined ? "" : ` (${String(status.carried)} carried forward)`
          }${
            status.unreadablePaths === undefined
              ? ""
              : `: ${status.unreadablePaths
                  .slice(0, 3)
                  .map((path) => clip(path))
                  .join(", ")}${status.unreadablePaths.length > 3 ? ", …" : ""}`
          }`,
        ]),
    ...(status.registerRefused === undefined
      ? []
      : [
          `register refused ${status.registerRefused}${
            status.registerRefusedN === undefined ? "" : ` at n ${String(status.registerRefusedN)}`
          }${
            status.registerMissing === undefined
              ? ""
              : ` (${String(status.registerMissing.length)} missing keys listed)`
          }`,
        ]),
    ...(status.repairing === true ? ["repairing"] : []),
    ...(status.registerRefusals === undefined || status.registerRefusals === 0
      ? []
      : [`${String(status.registerRefusals)} register refusals`]),
  ].join(" · ");
};

/** The parts that are present, joined as one detail; `undefined` when none is. */
const joinDetail = (...parts: ReadonlyArray<string | undefined>): string | undefined => {
  const present = parts.filter((part): part is string => part !== undefined);
  return present.length === 0 ? undefined : present.join(" · ");
};

type Sample =
  | { readonly kind: "status"; readonly status: CaptureFlushReport }
  /** The daemon answered but refused the command: it is alive, the queue cannot be read. */
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "unreachable"; readonly detail: string };

/**
 * One round trip: `{ flush }` sends that request (every drain ends the executor, so a drain's is
 * FINAL: quiesce, snapshot both classes, ship, report `complete`); a `status` reads the queue.
 */
const sampleCapture = (
  target: SealantTarget,
  command: { readonly flush: CaptureFlushRequest } | "status",
  timeoutMs: number,
): Effect.Effect<Sample, never, SealantRuntime> =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* SealantRuntime;
      const daemon = yield* runtime.connect(target);
      return yield* command === "status"
        ? daemon.captureStatus()
        : daemon.captureFlush(command.flush);
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
              detail:
                error instanceof Error
                  ? error.message
                  : `capture ${command === "status" ? "status" : "flush"} timed out`,
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

/** One `capture.status` round trip, for callers that only watch (the deadline sweep). */
export const readCaptureStatus = (
  target: SealantTarget,
  timeoutMs: number,
): Effect.Effect<CaptureFlushReport | undefined, never, SealantRuntime> =>
  sampleCapture(target, "status", timeoutMs).pipe(
    Effect.map((sample) => (sample.kind === "status" ? sample.status : undefined)),
  );

export interface DrainCaptureInput {
  readonly runId: string;
  /** How to reach the daemon (any adapter). */
  readonly target: SealantTarget;
  readonly ledger: CaptureDrainLedger;
  readonly settings: CaptureDrainSettings;
  /** How long THIS call may wait before returning `pending`; the ledger carries the rest. */
  readonly budgetMs: number;
  /** Who is stopping and why, for the log lines ("expiry reaper", "exit reconciler", …). */
  readonly label: string;
  /**
   * What the runtime positively reports of the executor: `missing` (nothing of it is left),
   * `exited` (it ended, but its disk can remain — a stopped container, a terminated Pod's
   * emptyDir), or `running`. Asked only once the daemon has been silent for the window; an
   * unknown answer must be `running`.
   */
  readonly runtimeState: Effect.Effect<"running" | "exited" | "missing">;
}

const observationOf = (outcome: CaptureDrainOutcome): CaptureDrainObservation | undefined => {
  switch (outcome.kind) {
    case "drained":
      return { state: "saved", detail: describeCaptureStatus(outcome.status) };
    case "gone":
      return { state: "gone", detail: outcome.detail };
    case "pending":
      return {
        state: "draining",
        detail: outcome.status === undefined ? undefined : describeCaptureStatus(outcome.status),
      };
    case "unconfirmed":
      return { state: "kept", detail: `not saved · not confirmed · ${outcome.detail}` };
    case "stalled":
      return {
        state: "kept",
        detail: `not saved · kept${outcome.detail === undefined ? "" : ` · ${outcome.detail}`}`,
      };
    case "silent":
      return { state: "kept", detail: `not saved · daemon silent · ${outcome.detail}` };
    case "busy":
      return undefined;
  }
};

/**
 * FINAL flush, then poll the daemon's capture status until it reports the flush complete, the
 * budget is spent, the queue stalls or empties without confirmation, or the daemon stays silent
 * for the silent window (then `runtimeState` decides between kept and gone). Never fails.
 */
export const drainCaptureBeforeStop = Effect.fn("drainCaptureBeforeStop")(function* (
  input: DrainCaptureInput,
) {
  const { runId, ledger, settings, label } = input;
  const claimed = yield* ledger.claim(runId);
  if (claimed === undefined) {
    return { kind: "busy" } satisfies CaptureDrainOutcome;
  }
  const { token } = claimed;
  const prefix = `Capture drain (${label}) · run ${runId}`;
  let entry: CaptureDrainEntry = claimed.entry;
  let lost = false;

  // Persist what this iteration learned (renewing the claim); a lost claim ends the call as
  // `busy` — another drain owns the run now.
  const persist = (outcome: CaptureDrainOutcome | undefined) =>
    ledger
      .save(runId, token, entry, outcome === undefined ? undefined : observationOf(outcome))
      .pipe(Effect.tap((kept) => Effect.sync(() => (lost = !kept))));

  const finish = (outcome: CaptureDrainOutcome) =>
    Effect.gen(function* () {
      yield* persist(outcome);
      return lost ? ({ kind: "busy" } satisfies CaptureDrainOutcome) : outcome;
    });

  return yield* Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    let command: "flush" | "status" = "flush";
    // One FINAL flush opens every call; one more is allowed when the queue empties without the
    // daemon confirming (a daemon that finished shipping after an incomplete flush snapshots
    // again). Past that, the next sweep asks again.
    let flushesLeft = 2;

    for (;;) {
      if (command === "flush") {
        flushesLeft -= 1;
      }
      const sample = yield* sampleCapture(
        input.target,
        command === "flush" ? { flush: finalFlushRequest(settings) } : "status",
        settings.requestTimeoutMs,
      );
      const now = yield* Clock.currentTimeMillis;
      let refusedDetail: string | undefined;

      if (sample.kind === "unreachable") {
        const unreachableSince = entry.unreachableSince ?? now;
        entry = { ...entry, unreachableSince };
        const unreachableForMs = now - unreachableSince;
        if (unreachableForMs >= settings.unreachableWindowMs) {
          const seconds = String(Math.round(unreachableForMs / 1000));
          const last =
            entry.last === undefined ? "" : ` Last status: ${describeCaptureStatus(entry.last)}.`;
          const runtimeState = yield* input.runtimeState;
          if (runtimeState === "missing") {
            yield* Effect.logWarning(
              `${prefix}: sealantd silent for ${seconds} s (${sample.detail}) and the runtime reports nothing of the executor left; there is no disk to keep, the stop proceeds.${last}`,
            );
            return yield* finish({
              kind: "gone",
              silentForMs: unreachableForMs,
              detail: sample.detail,
            });
          }
          if (runtimeState === "exited") {
            // The executor ended and its daemon is silent, never having confirmed a final flush
            // complete: a daemon whose final flush is incomplete exits (75) and keeps its staging
            // on the executor's disk — whether or not any drain reached it first (a plain
            // `docker stop`, its own shutdown FINAL, a lost reply). That disk remains until the
            // runtime is removed; removing it would destroy the only copy. Keep it.
            const detail = `the executor ended without a final flush confirmed complete; its disk keeps the staged captures (${sample.detail})`;
            if (!entry.silentLogged) {
              entry = { ...entry, silentLogged: true };
              yield* Effect.logError(
                `${prefix}: not saved · executor exited · kept · ${detail}. The runtime is left in place; remove it only once its captures are recovered.${last}`,
              );
            }
            return yield* finish({ kind: "silent", silentForMs: unreachableForMs, detail });
          }
          if (!entry.silentLogged) {
            entry = { ...entry, silentLogged: true };
            yield* Effect.logError(
              `${prefix}: not saved · daemon silent · kept · sealantd has not answered for ${seconds} s (${sample.detail}) while the runtime reports the executor running. The workspace is left running; every sweep asks again.${last}`,
            );
          }
          return yield* finish({
            kind: "silent",
            silentForMs: unreachableForMs,
            detail: sample.detail,
          });
        }
        yield* Effect.logWarning(
          `${prefix}: sealantd did not answer (${sample.detail}); retrying before any stop.`,
        );
      } else {
        // The first answer starts the stall window; after the FINAL flush the daemon keeps
        // shipping on its own, so status polls follow.
        entry = {
          ...entry,
          unreachableSince: undefined,
          silentLogged: false,
          lastProgressAt: entry.lastProgressAt ?? now,
        };
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
            entry = { ...entry, lastProgressAt: now };
          }
          const snapFailure = snapFailureDetail(status);
          if (snapFailure !== undefined && snapFailureKey(entry.last) !== snapFailureKey(status)) {
            // Snaps are failing: whatever the queue says, the newest work on the executor is not
            // being captured. Said once per distinct error; the drain goes on (only `complete`
            // lets a stop proceed, and a failing snap never reports it).
            yield* Effect.logError(
              `${prefix}: not captured · ${snapFailure}. The executor's newest work is not being saved; the workspace is not stopped until the daemon reports a complete final flush.`,
            );
          }
          if (status.refused.length > 0) {
            // The registrar refused a class for the session's byte quota: nothing of it ships
            // until a new epoch or a re-plan, whatever `pending` says. Keep the executor.
            const firstKeep = !entry.keptLogged;
            entry = { ...entry, last: status, keptLogged: true };
            if (firstKeep) {
              yield* Effect.logError(
                `${prefix}: not saved · refused · kept · ${describeCaptureStatus(status)}. The registrar refused these captures for the session's byte quota; the workspace is left running.`,
              );
            }
            return yield* finish({
              kind: "stalled",
              status,
              stalledForMs: now - (entry.lastProgressAt ?? now),
              detail: joinDetail(`refused ${status.refused.join(", ")}`, snapFailure),
            });
          }
          if (status.complete === true) {
            yield* Effect.logInfo(`${prefix}: saved · ${describeCaptureStatus(status)}`);
            entry = { ...entry, last: status, keptLogged: false };
            return yield* finish({ kind: "drained", status });
          }
          if (status.pending === 0) {
            entry = { ...entry, last: status };
            if (flushesLeft > 0) {
              // Empty but unconfirmed: one more FINAL flush in this call.
              command = "flush";
              continue;
            }
            const detail = [
              status.complete === false
                ? `the daemon reports its final flush incomplete${
                    status.incompleteReason === undefined ? "" : ` (${status.incompleteReason})`
                  }`
                : "the daemon does not report whether its final flush completed (sealantd predates capture.flush FINAL); an empty queue is not proof",
              ...(snapFailure === undefined ? [] : [snapFailure]),
            ].join(" · ");
            if (!entry.keptLogged) {
              entry = { ...entry, keptLogged: true };
              yield* Effect.logError(
                `${prefix}: not saved · not confirmed · kept · ${describeCaptureStatus(status)}. ${detail}; the workspace is left running and every sweep flushes again.`,
              );
            }
            return yield* finish({ kind: "unconfirmed", status, detail });
          }
          if (moved) {
            yield* Effect.logInfo(`${prefix}: saving · ${describeCaptureStatus(status)}`);
            entry = { ...entry, keptLogged: false };
          }
          entry = { ...entry, last: status };
        }

        const stalledForMs = now - (entry.lastProgressAt ?? now);
        if (stalledForMs >= settings.stallWindowMs) {
          if (!entry.keptLogged) {
            entry = { ...entry, keptLogged: true };
            yield* Effect.logError(
              `${prefix}: not saved · kept · no capture progress for ${String(Math.round(stalledForMs / 1000))} s${
                entry.last === undefined ? "" : ` · ${describeCaptureStatus(entry.last)}`
              }${refusedDetail === undefined ? "" : ` · ${refusedDetail}`}. The workspace is left running; nothing stops it until its queue is saved.`,
            );
          }
          return yield* finish({
            kind: "stalled",
            status: entry.last,
            stalledForMs,
            detail: joinDetail(
              refusedDetail,
              entry.last === undefined ? undefined : snapFailureDetail(entry.last),
            ),
          });
        }
      }

      if (now - startedAt + settings.pollIntervalMs > input.budgetMs) {
        return yield* finish({ kind: "pending", status: entry.last });
      }
      yield* persist(undefined);
      if (lost) {
        return { kind: "busy" } satisfies CaptureDrainOutcome;
      }
      yield* Effect.sleep(settings.pollIntervalMs);
    }
  }).pipe(Effect.ensuring(ledger.release(runId, token)));
});
