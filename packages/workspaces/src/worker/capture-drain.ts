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
 *    policy (`executor-preservation.ts`) finds evidence it may go. The runtime is asked at the
 *    first silence, not only when the window closes: an executor that ended is kept at once (a
 *    retry cannot reach a daemon that is not running), and one that ended AFTER its daemon
 *    reported the final flush complete is `drained` at once on that recorded completion (the
 *    stop that followed it) — never retried, never reported gone.
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
import {
  nextUnsavedObservations,
  statusSupersedes,
  type ExecutorOrigin,
  type UnsavedObservation,
} from "@sealant/db";
import { Cause, Clock, Effect, Exit, Option, Result } from "effect";
import { z } from "zod";

import {
  attestationCoversExecutor,
  attestationCoversObservations,
  type ExecutorDeletionBasis,
  type ExecutorDeletionDecision,
  type ExecutorIdentity,
  type ExecutorRuntimeState,
  type ObservedCapture,
} from "../runtime/executor-preservation.js";
import { isRemovalRefusal } from "../runtime/runtime-adapter.js";
import {
  SealantControlError,
  SealantRuntime,
  TransportError,
  type CaptureFlushReport,
  type CaptureFlushRequest,
  type SealantError,
  type SealantSession,
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

/** How long a drain claim lasts without renewal when the settings name none. */
export const DEFAULT_CAPTURE_DRAIN_LEASE_MS = 3 * 60_000;
const DEFAULT_LEASE_MS = DEFAULT_CAPTURE_DRAIN_LEASE_MS;

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
  /** When `last` was read (this worker's clock; the database's once stored). */
  readonly lastAtMs?: number | undefined;
  /**
   * A status is on record but cannot be read (`last` is then absent): Core observed something it
   * cannot weigh, so no attestation may be taken over it.
   */
  readonly lastUnreadable?: boolean | undefined;
  /**
   * Every answer on record that says the executor's work is not saved and that no answer recorded
   * since covers (review 9 #4, decision 25), `last` among them when it is one. Two answers no
   * position orders are both here; nothing reads saved — no observed complete, no seal — until
   * every one of them is covered.
   */
  readonly unsaved?: readonly CaptureFlushReport[] | undefined;
  /** An unsaved answer is on record that cannot be read: nothing reads saved over it. */
  readonly unsavedUnreadable?: boolean | undefined;
  /**
   * The evidence version this entry was read at (`workspace_capture_drains.evidence_version`):
   * every status recorded, observation opened or resolved, and attestation bumps it. A deletion
   * decided on this entry is authorized only while it is still current (`authorizeDeletion`).
   */
  readonly evidenceVersion?: number | undefined;
  /**
   * Observations of the executor in flight or unresolved when this was read (a request sent whose
   * answer is not recorded — possibly because recording it failed): while any is, nothing on
   * record is known to be current, and no deletion rests on it (review 6 #5).
   */
  readonly observationsInFlight?: number | undefined;
  /**
   * The runtime was asked to remove the executor (`deleting-issued`, review 8 #7) and nothing has
   * recorded the outcome yet: its issuer may still be waiting on the runtime, or nobody knows.
   * Nothing is observed or recovered until it is settled (`authorizedDeletion` settles it from
   * what the runtime says of the executor).
   */
  readonly removalIssued?: boolean | undefined;
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
        /** When the attesting store recorded the seal, when the attestation said (display). */
        readonly sealedAtMs?: number | undefined;
        /** The seal's executor-origin position, when the attestation carried it. */
        readonly origin?: ExecutorOrigin | undefined;
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

/** A held removal of an executor (decision 21): the token its `deleting` transition is owned by. */
export interface DeletionTicket {
  readonly token: string;
}

/**
 * What authorizing a removal found: `authorized` (held by `ticket`), `changed` (the evidence
 * moved or is unresolved: decide again), `held` (another deleter's removal is live, or one was
 * issued and its issuer still holds it), `unresolved` (one was issued and its issuer's hold
 * lapsed: settle it from the runtime first, `reconcileIssuedDeletion`), `deleted` (it was removed
 * already).
 */
export type DeletionAuthorization =
  | { readonly kind: "authorized"; readonly ticket: DeletionTicket }
  | { readonly kind: "changed" }
  | { readonly kind: "held" }
  | { readonly kind: "unresolved" }
  | { readonly kind: "deleted" };

/**
 * How an issued removal whose issuer's hold lapsed was settled (review 8 #7): `deleted` (the
 * runtime no longer has the executor), `reissue` (it still does, and the evidence the removal was
 * authorized on still stands: taken over by `ticket`, to be issued again), `outstanding` (it
 * still does, the evidence changed since, and the request may still act: it stays issued and
 * exclusionary, and the executor is kept; review 9 #5), `released` (it still does, the evidence
 * changed since, and the runtime's bound on a removal request has passed since it was issued:
 * given up, decide again on what is current), `held` (its issuer, or another, holds it again),
 * `none` (nothing issued is left), `unknown` (the record could not be written or read: nothing is
 * settled).
 */
export type IssuedDeletionSettlement =
  | { readonly kind: "deleted" }
  | { readonly kind: "reissue"; readonly ticket: DeletionTicket }
  | { readonly kind: "outstanding" }
  | { readonly kind: "released" }
  | { readonly kind: "held" }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

/** How long a removal's hold lasts without renewal; its deleter renews it while it removes. */
export const DELETION_HOLD_MS = 120_000;

/** How often a deleter renews its hold while the runtime call runs. */
const DELETION_RENEW_EVERY_MS = 30_000;

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
   * Mark an observation of the run's executor in flight BEFORE its request is sent (review 6 #5):
   * until it is resolved — `recordStatus` with its answer, `closeObservation` when none was
   * received — nothing on record is known to be current and no deletion rests on it. Lapses
   * `ttlMs` after it was opened; a lapsed fence still counts until an observation opened after it
   * lapsed is recorded. `undefined` when it cannot be opened: then nothing may be asked — also
   * while the executor's removal is held, and once it was removed (decision 21).
   */
  readonly openObservation: (
    runId: string,
    ttlMs: number,
  ) => Effect.Effect<CaptureObservationFence | undefined>;
  /** Resolve an observation under which no answer was received. Best-effort: it may stay open. */
  readonly closeObservation: (runId: string, fence: CaptureObservationFence) => Effect.Effect<void>;
  /**
   * Record a capture status received from the run's executor — by a drain, a probe, a sampler:
   * every status Core receives is evidence about its disk (review 5 #3) — resolving `fence`, the
   * observation it answers. Ordered by the executor's own history, never by any clock
   * (`statusSupersedes`, review 6 #6). Answers whether it was recorded durably: `false` leaves
   * the fence open, and the executor reads unknown until a later observation is recorded.
   */
  readonly recordStatus: (
    runId: string,
    status: CaptureFlushReport,
    atMs: number,
    fence?: CaptureObservationFence,
  ) => Effect.Effect<boolean>;
  /**
   * Authorize a deletion decided on evidence version `evidenceVersion` (decision 18) and take it
   * as an owned durable transition (review 7 #5, decision 21): only while the version is still
   * current, no observation is in flight and no other deleter's removal is live — then the
   * executor is `deleting`, held by the answered ticket: no observation is admitted and no
   * recovery starts it until the ticket is completed or released (or its hold lapses), and a
   * status recorded anyway voids it. `changed` on any change, and when it cannot be checked.
   */
  readonly authorizeDeletion: (
    runId: string,
    evidenceVersion: number,
  ) => Effect.Effect<DeletionAuthorization>;
  /**
   * Renew the hold of the removal the ticket holds: before it is issued, only while nothing
   * voided it and the evidence it was authorized on is still current; once issued, while the
   * ticket still holds it. `false` (and when it cannot be checked): not held.
   */
  readonly confirmDeletion: (runId: string, ticket: DeletionTicket) => Effect.Effect<boolean>;
  /**
   * RIGHT BEFORE the runtime call that removes the executor (decision 21, review 8 #7): as
   * `confirmDeletion`, and in the same step the removal becomes issued — exclusionary from then on
   * whatever becomes of its hold, until its outcome is recorded (`completeDeletion`,
   * `releaseDeletion`) or settled from the runtime (`reconcileIssuedDeletion`). `false` (and when
   * it cannot be checked): nothing may be called — decide again.
   */
  readonly issueDeletion: (runId: string, ticket: DeletionTicket) => Effect.Effect<boolean>;
  /**
   * Settle an issued removal whose issuer's hold lapsed, from what the runtime says of the
   * executor now (`gone` or `present`; review 8 #7). `fenceMs`: the runtime's bound on a removal
   * request (`RuntimeAdapter.removalFenceMs`), past which one issued earlier can no longer act.
   * See `IssuedDeletionSettlement`.
   */
  readonly reconcileIssuedDeletion: (
    runId: string,
    runtime: "gone" | "present",
    fenceMs?: number,
  ) => Effect.Effect<IssuedDeletionSettlement>;
  /** The runtime removed the executor: `deleted` for good. Best-effort: a failed write is logged. */
  readonly completeDeletion: (runId: string, ticket: DeletionTicket) => Effect.Effect<void>;
  /**
   * Give a held removal up: its runtime call was not made, or the runtime definitively refused it
   * (`isRemovalRefusal`). Never for a call whose outcome is unknown. Best-effort.
   */
  readonly releaseDeletion: (runId: string, ticket: DeletionTicket) => Effect.Effect<void>;
  /**
   * The runtime call of the issued removal the ticket holds ended with an outcome nobody knows
   * (review 9 #5): it stays issued and exclusionary, its hold ends now, and it is settled from
   * the runtime (`reconcileIssuedDeletion`). Best-effort: otherwise its hold lapses on its own.
   */
  readonly lapseIssuedDeletion: (runId: string, ticket: DeletionTicket) => Effect.Effect<void>;
  /**
   * May recovery start the run's executor (decision 21)? `deleting`: a live removal holds it, or
   * one was issued (settled only from the runtime, review 8 #7); `deleted`: it was removed;
   * `unknown`: it cannot be checked (nothing is started). A removal not yet issued whose hold
   * lapsed is voided and recovery `admitted`.
   */
  readonly admitRecovery: (
    runId: string,
  ) => Effect.Effect<"admitted" | "deleting" | "deleted" | "unknown">;
  /**
   * Record an observation outside a drain (what the stop that followed it did); no claim needed.
   * `stopped`, `discarded` and `gone` also end a retention. Best-effort: a failed write is logged.
   */
  readonly observe: (runId: string, observation: CaptureDrainObservation) => Effect.Effect<void>;
  /**
   * Record that the run's executor is retained (kept: its disk holds work not confirmed saved),
   * with why; recovery picks it up. Keeps the first instant. Answers whether it was recorded: a
   * failed write is logged loudly and answers `false` — the executor is kept either way, but only
   * a recorded retention brings recovery to it, so a caller that is about to make the executor's
   * end terminal must not do so on `false` (`reconcile-runtime-exits.ts` writes both in one
   * transaction and leaves the runtime for the next sweep otherwise).
   */
  readonly markRetained: (
    runId: string,
    reason: string,
    options?: {
      /**
       * `false`: do not tell recovery yet (the retention is written inside a transaction that
       * has not committed; the caller calls `notifyRetained` once it has). Default `true`.
       */
      readonly notify?: boolean;
    },
  ) => Effect.Effect<boolean>;
  /**
   * Tell whoever recovers retained executors that one was recorded (the worker starts a
   * recovery sweep at once). `markRetained` does this itself unless told not to; a caller that
   * recorded the retention inside a transaction calls this once that transaction committed, since
   * a sweep started before the commit cannot see the row. Absent: nobody listens.
   */
  readonly notifyRetained?: (runId: string) => Effect.Effect<void>;
}

/**
 * The ledger, with `onRetained` called after every executor it records retained: the worker
 * starts a recovery sweep at once rather than on its next tick, so a retained executor's first
 * recovery attempt follows its exit within seconds.
 */
export const notifyingRetention = (
  ledger: CaptureDrainLedger,
  onRetained: (runId: string) => void,
): CaptureDrainLedger => ({
  ...ledger,
  markRetained: (runId, reason, options) =>
    ledger
      .markRetained(runId, reason, options)
      .pipe(
        Effect.tap((recorded) =>
          recorded && options?.notify !== false
            ? Effect.sync(() => onRetained(runId))
            : Effect.void,
        ),
      ),
  notifyRetained: (runId) => Effect.sync(() => onRetained(runId)),
});

/** One row of an in-memory ledger. */
export interface InMemoryCaptureDrainRow {
  entry: CaptureDrainEntry;
  observation: CaptureDrainObservation | undefined;
  owner: string | undefined;
  expiresAt: number | undefined;
  /** Observations in flight, by token: when opened (the store's own order and clock), lapsing when. */
  fences?: Map<
    string,
    { readonly openedTick: number; readonly openedAtMs: number; readonly expiresAtMs: number }
  >;
  /** When the status on record was recorded, in the store's own order. */
  recordedTick?: number;
  /** The unsaved answers no later one covers, with when each was recorded (the store's tick). */
  unsaved?: UnsavedObservation<CaptureFlushReport>[];
  /** The executor's removal (decision 21), as `deletion_*` holds it. */
  deletion?:
    | {
        readonly state: "deleting" | "deleting-issued" | "deleted";
        readonly token: string;
        readonly evidenceVersion: number;
        readonly expiresAtMs: number;
        /** When the runtime was last asked to remove it (review 9 #5). */
        readonly issuedAtMs?: number;
      }
    | undefined;
}

/**
 * Rows of an in-memory ledger; share one store between ledgers to model several workers. Its
 * `tick` is the one clock every ledger on it shares, as workers share the database's.
 */
export class InMemoryCaptureDrainStore {
  readonly rows = new Map<string, InMemoryCaptureDrainRow>();
  tick = 0;
}

let inMemoryOwnerSequence = 0;
let inMemoryClaimSequence = 0;

/** Whether an observation ends a retention: the executor was removed, or found gone. */
export const observationEndsRetention = (state: CaptureDrainState): boolean =>
  state === "stopped" || state === "discarded" || state === "gone";

/** A lease holder for one claim: the ledger's owner plus a token unique to the claim. */
export const claimLeaseOwner = (owner: string, token: string): string => `${owner}#${token}`;

/** An in-memory row's observations in flight. */
const fencesOf = (row: InMemoryCaptureDrainRow) => {
  row.fences ??= new Map();
  return row.fences;
};

/** Every change to an in-memory row's evidence bumps its version (as `evidence_version`). */
const bump = (row: InMemoryCaptureDrainRow) => {
  row.entry = { ...row.entry, evidenceVersion: (row.entry.evidenceVersion ?? 0) + 1 };
};

/** An in-memory row as a read answers it: its version and observations in flight included. */
const entryOf = (row: InMemoryCaptureDrainRow): CaptureDrainEntry => ({
  ...row.entry,
  ...(row.unsaved === undefined || row.unsaved.length === 0
    ? {}
    : { unsaved: row.unsaved.map((member) => member.status) }),
  evidenceVersion: row.entry.evidenceVersion ?? 0,
  observationsInFlight: row.fences?.size ?? 0,
  ...(row.deletion?.state === "deleting-issued" ? { removalIssued: true } : {}),
});

/**
 * Whether `ticket` still holds the row's removal: issued already (nothing voids it any more), or
 * not yet issued and nothing voided it — the evidence it was authorized on still current, none in
 * flight.
 */
const heldBy = (row: InMemoryCaptureDrainRow, ticket: DeletionTicket): boolean => {
  const deletion = row.deletion;
  if (deletion === undefined || deletion.token !== ticket.token) {
    return false;
  }
  return (
    deletion.state === "deleting-issued" ||
    (deletion.state === "deleting" &&
      deletion.evidenceVersion === (row.entry.evidenceVersion ?? 0) &&
      (row.fences?.size ?? 0) === 0)
  );
};

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
  const nextTick = () => {
    store.tick += 1;
    return store.tick;
  };
  const rowOf = (runId: string): InMemoryCaptureDrainRow => {
    const existing = store.rows.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const row: InMemoryCaptureDrainRow = {
      entry: EMPTY_CAPTURE_DRAIN_ENTRY,
      observation: undefined,
      owner: undefined,
      expiresAt: undefined,
    };
    store.rows.set(runId, row);
    return row;
  };
  return {
    store,
    claim: (runId) =>
      Effect.sync(() => {
        inMemoryClaimSequence += 1;
        const token = String(inMemoryClaimSequence);
        const holder = claimLeaseOwner(owner, token);
        const row = store.rows.get(runId);
        if (row === undefined) {
          const created = rowOf(runId);
          created.owner = holder;
          created.expiresAt = now() + leaseMs;
          return { entry: entryOf(created), token };
        }
        const free =
          row.owner === undefined || row.expiresAt === undefined || row.expiresAt <= now();
        if (!free) {
          return undefined;
        }
        row.owner = holder;
        row.expiresAt = now() + leaseMs;
        return { entry: entryOf(row), token };
      }),
    save: (runId, token, entry, observation) =>
      Effect.sync(() => {
        const row = store.rows.get(runId);
        if (row === undefined || row.owner !== claimLeaseOwner(owner, token)) {
          return false;
        }
        // Progress only, as `recordProgress` writes it: statuses are recorded as they arrive.
        row.entry = {
          ...row.entry,
          lastProgressAt: entry.lastProgressAt,
          unreachableSince: entry.unreachableSince,
          keptLogged: entry.keptLogged,
          silentLogged: entry.silentLogged,
        };
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
      Effect.sync(() => {
        const row = store.rows.get(runId);
        return { readable: true as const, entry: row === undefined ? undefined : entryOf(row) };
      }),
    openObservation: (runId, ttlMs) =>
      Effect.sync(() => {
        const row = rowOf(runId);
        if (row.deletion !== undefined) {
          if (
            row.deletion.state !== "deleting" || // deleted, or issued: whatever its hold
            row.deletion.expiresAtMs > now()
          ) {
            return undefined;
          }
          // Its deleter's hold lapsed before it issued anything: voided by what it admits.
          row.deletion = undefined;
        }
        inMemoryClaimSequence += 1;
        const token = `observation-${String(inMemoryClaimSequence)}`;
        const openedAtMs = now();
        fencesOf(row).set(token, {
          openedTick: nextTick(),
          openedAtMs,
          expiresAtMs: openedAtMs + Math.max(0, ttlMs),
        });
        bump(row);
        return { token };
      }),
    closeObservation: (runId, fence) =>
      Effect.sync(() => {
        const row = store.rows.get(runId);
        if (row !== undefined && fencesOf(row).delete(fence.token)) {
          bump(row);
        }
      }),
    recordStatus: (runId, status, atMs, fence) =>
      Effect.sync(() => {
        const row = rowOf(runId);
        const fences = fencesOf(row);
        const opened = fence === undefined ? undefined : fences.get(fence.token);
        // Unfenced: taken as read just now, after everything already recorded.
        const openedTick = fence === undefined ? nextTick() : opened?.openedTick;
        const causallyAfter =
          row.recordedTick === undefined ||
          (openedTick !== undefined && openedTick > row.recordedTick);
        const stored =
          row.entry.lastUnreadable === true
            ? { unreadable: true }
            : row.entry.last === undefined
              ? undefined
              : storedStatusRecord(row.entry.last);
        const recordedTick = nextTick();
        // Every unsaved answer no later one covers stays on record (review 9 #4).
        row.unsaved = [
          ...nextUnsavedObservations({
            unsaved: row.unsaved ?? [],
            stored,
            storedRecordedAt: row.recordedTick ?? null,
            incoming: status,
            askedAt: openedTick ?? null,
            recordedAt: recordedTick,
          }),
        ];
        if (statusSupersedes({ stored, incoming: storedStatusRecord(status), causallyAfter })) {
          row.entry = { ...row.entry, last: status, lastAtMs: atMs, lastUnreadable: false };
          row.recordedTick = recordedTick;
        }
        if (row.deletion?.state === "deleting") {
          // Received evidence outranks a removal decided before it: voided.
          row.deletion = undefined;
        }
        if (fence !== undefined) {
          fences.delete(fence.token);
          if (opened !== undefined) {
            for (const [token, other] of fences) {
              if (other.expiresAtMs < opened.openedAtMs) {
                fences.delete(token);
              }
            }
          }
        }
        bump(row);
        return true;
      }),
    authorizeDeletion: (runId, evidenceVersion) =>
      Effect.sync((): DeletionAuthorization => {
        const row = store.rows.get(runId);
        if (row?.deletion?.state === "deleted") {
          return { kind: "deleted" };
        }
        if (row?.deletion?.state === "deleting-issued") {
          return row.deletion.expiresAtMs > now() ? { kind: "held" } : { kind: "unresolved" };
        }
        if (row?.deletion !== undefined && row.deletion.expiresAtMs > now()) {
          return { kind: "held" };
        }
        if ((row?.entry.evidenceVersion ?? 0) !== evidenceVersion || (row?.fences?.size ?? 0) > 0) {
          return { kind: "changed" };
        }
        const held = rowOf(runId);
        inMemoryClaimSequence += 1;
        const token = `deletion-${String(inMemoryClaimSequence)}`;
        held.deletion = {
          state: "deleting",
          token,
          evidenceVersion,
          expiresAtMs: now() + DELETION_HOLD_MS,
        };
        return { kind: "authorized", ticket: { token } };
      }),
    confirmDeletion: (runId, ticket) =>
      Effect.sync(() => {
        const row = store.rows.get(runId);
        if (row === undefined || !heldBy(row, ticket)) {
          return false;
        }
        row.deletion = row.deletion && { ...row.deletion, expiresAtMs: now() + DELETION_HOLD_MS };
        return true;
      }),
    issueDeletion: (runId, ticket) =>
      Effect.sync(() => {
        const row = store.rows.get(runId);
        if (row === undefined || row.deletion === undefined || !heldBy(row, ticket)) {
          return false;
        }
        row.deletion = {
          ...row.deletion,
          state: "deleting-issued",
          expiresAtMs: now() + DELETION_HOLD_MS,
          issuedAtMs: now(),
        };
        return true;
      }),
    reconcileIssuedDeletion: (runId, runtime, fenceMs) =>
      Effect.sync((): IssuedDeletionSettlement => {
        const row = store.rows.get(runId);
        const deletion = row?.deletion;
        if (deletion?.state === "deleted") {
          return { kind: "deleted" };
        }
        if (row === undefined || deletion === undefined || deletion.state !== "deleting-issued") {
          return { kind: "none" };
        }
        if (deletion.expiresAtMs > now()) {
          return { kind: "held" };
        }
        if (runtime === "gone") {
          row.deletion = { ...deletion, state: "deleted", expiresAtMs: Number.POSITIVE_INFINITY };
          bump(row);
          return { kind: "deleted" };
        }
        if (
          deletion.evidenceVersion === (row.entry.evidenceVersion ?? 0) &&
          (row.fences?.size ?? 0) === 0
        ) {
          inMemoryClaimSequence += 1;
          const token = `deletion-${String(inMemoryClaimSequence)}`;
          row.deletion = { ...deletion, token, expiresAtMs: now() + DELETION_HOLD_MS };
          return { kind: "reissue", ticket: { token } };
        }
        if (
          fenceMs === undefined ||
          deletion.issuedAtMs === undefined ||
          deletion.issuedAtMs + fenceMs > now()
        ) {
          // The request already sent may still act (review 9 #5): it stays issued.
          return { kind: "outstanding" };
        }
        row.deletion = undefined;
        bump(row);
        return { kind: "released" };
      }),
    completeDeletion: (runId, ticket) =>
      Effect.sync(() => {
        const row = rowOf(runId);
        row.deletion = {
          state: "deleted",
          token: ticket.token,
          evidenceVersion: row.entry.evidenceVersion ?? 0,
          expiresAtMs: Number.POSITIVE_INFINITY,
        };
        bump(row);
      }),
    releaseDeletion: (runId, ticket) =>
      Effect.sync(() => {
        const row = store.rows.get(runId);
        if (row?.deletion?.state !== "deleted" && row?.deletion?.token === ticket.token) {
          row.deletion = undefined;
        }
      }),
    lapseIssuedDeletion: (runId, ticket) =>
      Effect.sync(() => {
        const row = store.rows.get(runId);
        if (row?.deletion?.state === "deleting-issued" && row.deletion.token === ticket.token) {
          row.deletion = { ...row.deletion, expiresAtMs: now() };
        }
      }),
    admitRecovery: (runId) =>
      Effect.sync(() => {
        const row = store.rows.get(runId);
        const deletion = row?.deletion;
        if (row === undefined || deletion === undefined) {
          return "admitted" as const;
        }
        if (deletion.state === "deleted") {
          return "deleted" as const;
        }
        if (deletion.state === "deleting-issued" || deletion.expiresAtMs > now()) {
          return "deleting" as const;
        }
        row.deletion = undefined;
        bump(row);
        return "admitted" as const;
      }),
    observe: (runId, observation) =>
      Effect.sync(() => {
        const row = rowOf(runId);
        row.observation = observation;
        if (observationEndsRetention(observation.state)) {
          row.entry = { ...row.entry, retained: undefined };
        }
      }),
    markRetained: (runId, reason) =>
      Effect.sync(() => {
        const row = rowOf(runId);
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
        return true;
      }),
  };
};

/** A status as a record, the shape `statusSupersedes` weighs (as the database stores it). */
const storedStatusRecord = (status: CaptureFlushReport): Readonly<Record<string, unknown>> => ({
  ...status,
  refused: [...status.refused],
});

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

/**
 * Whether a status says the executor's work is saved: `complete: true` and no reason it is not.
 * Every `incompleteReason` — known (`not-final`, `changed`, `sealing`, `unwatched`, …) or one a
 * newer daemon adds — is not saved: a drain asks for FINAL again, and nothing is removed on it.
 */
export const reportsComplete = (status: CaptureFlushReport | undefined): boolean =>
  status?.complete === true && status.incompleteReason === undefined;

/**
 * Whether Core itself read `complete: true` from the run's daemon (the drain's last status), and
 * no unsaved answer on record is left that it does not cover (review 9 #4).
 */
export const observedComplete = (entry: CaptureDrainEntry | undefined): boolean =>
  reportsComplete(entry?.last) && unsavedOnRecord(entry) === undefined;

/**
 * An unsaved answer on record that nothing recorded since covers (review 9 #4), as a line; the
 * executor reads saved only when there is none. `undefined`: none.
 */
export const unsavedOnRecord = (entry: CaptureDrainEntry | undefined): string | undefined => {
  if (entry?.unsavedUnreadable === true) {
    return "an answer of the executor that says its work is not saved is on record and cannot be read";
  }
  const first = entry?.unsaved?.[0];
  return first === undefined
    ? undefined
    : `an answer of the executor that no later one covers says its work is not saved (${describeCaptureStatus(first)})`;
};

/** Core's own latest observation of the run's daemon, as the preservation policy weighs it. */
export const observedCaptureOf = (
  entry: CaptureDrainEntry | undefined,
): ObservedCapture | undefined => {
  const last = entry?.last;
  if (last === undefined && entry?.lastUnreadable === true) {
    return { readable: false };
  }
  return last === undefined ? undefined : observedCaptureOfStatus(last, entry?.lastAtMs);
};

/** One status the daemon answered, as the preservation policy weighs it. */
export const observedCaptureOfStatus = (
  status: CaptureFlushReport,
  atMs?: number,
): ObservedCapture => ({
  readable: true,
  epoch: status.epoch,
  ...(status.headN === undefined ? {} : { headN: status.headN }),
  complete: reportsComplete(status),
  ...(status.incompleteReason === undefined ? {} : { incompleteReason: status.incompleteReason }),
  ...(atMs === undefined ? {} : { atMs }),
  ...(status.origin === undefined ? {} : { origin: status.origin }),
});

/**
 * Whether the control plane's recorded attestation covers THIS executor, weighed at the moment
 * it is consumed: it names the run's executor, and nothing Core observed from it — before or
 * after the attestation was accepted — contradicts it (`attestationCoversExecutor`: an older
 * epoch, a later capture, or an observation that the work is not saved made after the seal).
 * No attestation, or one about another executor, is `false`.
 */
export const attestedCompleteFor = (
  entry: CaptureDrainEntry | undefined,
  executor: ExecutorIdentity,
): boolean => {
  const attested = entry?.completionAttested;
  if (attested === undefined || entry?.unsavedUnreadable === true) {
    return false;
  }
  // The seal must cover Core's latest observation AND every unsaved answer no later one covers
  // (review 9 #4): a failure no position orders against the seal is never erased by an answer
  // that arrived after it.
  return attestationCoversObservations(
    attested,
    executor,
    observedCaptureOf(entry),
    (entry?.unsaved ?? []).map((status) => observedCaptureOfStatus(status)),
  ).covers;
};

/**
 * What the drain record says of an executor, for the preservation policy. While an observation
 * of it is in flight or unresolved (`observationsInFlight`: a request sent whose answer is not
 * recorded — possibly because recording it failed), nothing on record is known to be current:
 * neither an observed complete nor an attestation counts (review 6 #5). A discard still does.
 */
export const recordedDeletionEvidence = (
  record: CaptureDrainRead,
  executor: ExecutorIdentity,
): {
  readonly observedComplete: boolean;
  readonly attestedComplete: boolean;
  readonly discarded: boolean;
  readonly ledgerUnreadable: boolean;
} => {
  if (!record.readable) {
    return {
      observedComplete: false,
      attestedComplete: false,
      discarded: false,
      ledgerUnreadable: true,
    };
  }
  const current = (record.entry?.observationsInFlight ?? 0) === 0;
  return {
    observedComplete: current && observedComplete(record.entry),
    attestedComplete: current && attestedCompleteFor(record.entry, executor),
    discarded: record.entry?.discardRequested !== undefined,
    ledgerUnreadable: false,
  };
};

/** Whether a deletion basis rests on recorded evidence a newer observation could revoke. */
const basisRestsOnEvidence = (basis: ExecutorDeletionBasis): boolean =>
  basis === "observed-complete" || basis === "attested-complete" || basis === "issued-before";

/** How often a deletion is decided again when its evidence changed under it. */
const DELETION_AUTHORIZATION_ATTEMPTS = 4;

/** How long a deletion waits for an observation in flight to be recorded before deciding again. */
const IN_FLIGHT_OBSERVATION_WAIT_MS = 200;

/**
 * Decide, and AUTHORIZE, the deletion of an executor on the evidence as it stands (decision 18):
 * the drain record is read afresh, `decide` weighs it, and a deletion that rests on recorded
 * evidence (an observed complete, an attestation) is authorized only while the evidence version
 * it was decided on is still current and no observation is in flight — a compare-and-set
 * serialized with every ingestion of evidence about the executor. Changed meanwhile, or an
 * observation in flight (waited on briefly): decided again on what is current (at most
 * `DELETION_AUTHORIZATION_ATTEMPTS` times, then kept).
 *
 * The authorization is an owned durable transition, not a reusable answer (review 7 #5,
 * decision 21): the executor is `deleting`, held by the answered `ticket`, and from then on no
 * observation of it is admitted, no recovery starts it, and a status recorded anyway voids the
 * removal. The caller removes the runtime through `removeUnderDeletion` with that ticket, which
 * re-checks it right before the runtime call and records `deleted` after. `held`: another
 * deleter's removal is live — nothing is decided here (kept for now, never marked retained).
 * Without a ledger nothing is known: `decide` sees an unreadable record.
 */
export const authorizedDeletion = (input: {
  readonly ledger: CaptureDrainLedger | undefined;
  readonly runId: string;
  readonly decide: (record: CaptureDrainRead) => ExecutorDeletionDecision;
  /**
   * What the runtime said of the executor when the caller last looked (the state `decide` weighs):
   * how a removal issued earlier whose outcome nobody recorded is settled (review 8 #7). Absent
   * or `unknown`: such a removal is not settled here, and the executor is kept.
   */
  readonly runtime?: ExecutorRuntimeState | undefined;
  /**
   * The runtime's bound on a removal request (`RuntimeAdapter.removalFenceMs`): how such a removal
   * whose evidence changed since is given up (review 9 #5). Absent: it never is while the runtime
   * still has the executor.
   */
  readonly removalFenceMs?: number | undefined;
}): Effect.Effect<AuthorizedDeletion> =>
  Effect.gen(function* () {
    const { ledger, runId } = input;
    let record: CaptureDrainRead = { readable: false };
    for (let attempt = 0; attempt < DELETION_AUTHORIZATION_ATTEMPTS; attempt += 1) {
      record = ledger === undefined ? { readable: false } : yield* ledger.read(runId);
      if (ledger !== undefined && record.readable && record.entry?.removalIssued === true) {
        // The runtime was asked to remove it and nobody recorded how that went (review 8 #7):
        // nothing is observed, recovered or decided anew until the runtime says.
        const settled = yield* settleIssuedRemoval(
          ledger,
          runId,
          input.runtime,
          input.removalFenceMs,
        );
        if (settled.kind === "reissue") {
          return {
            decision: { delete: true, basis: "issued-before" },
            record,
            ticket: settled.ticket,
          };
        }
        if (settled.kind === "kept") {
          return {
            decision: { delete: false, reason: settled.reason },
            record,
            heldElsewhere: true,
          };
        }
        // Settled (`deleted`, `released`, nothing left): decided on what is current now.
        record = yield* ledger.read(runId);
      }
      const decision = input.decide(record);
      const inFlight = record.readable && (record.entry?.observationsInFlight ?? 0) > 0;
      if (!decision.delete && inFlight && attempt < DELETION_AUTHORIZATION_ATTEMPTS - 1) {
        // Another path is reading the executor right now (a status poll): what it hears is
        // weighed once it is recorded, not raced and not ignored.
        yield* Effect.sleep(IN_FLIGHT_OBSERVATION_WAIT_MS);
        continue;
      }
      if (!decision.delete || !basisRestsOnEvidence(decision.basis)) {
        return { decision, record };
      }
      const version = record.readable ? (record.entry?.evidenceVersion ?? 0) : undefined;
      const authorization: DeletionAuthorization =
        ledger === undefined || version === undefined
          ? { kind: "changed" }
          : yield* ledger.authorizeDeletion(runId, version);
      switch (authorization.kind) {
        case "authorized":
          return { decision, record, ticket: authorization.ticket };
        case "deleted":
          // Removed already, on evidence nothing could revoke after it was authorized: the
          // runtime call is repeated (idempotent) with nothing held.
          return { decision, record };
        case "held":
          return {
            decision: {
              delete: false,
              reason: "another path holds the removal of this executor right now",
            },
            record,
            heldElsewhere: true,
          };
        case "unresolved":
          // Issued between the read and now: settled on the next attempt.
          continue;
        case "changed":
          yield* Effect.logWarning(
            `Capture drain · run ${runId}: the evidence about its executor changed while its removal was decided; deciding again on what is current.`,
          );
      }
    }
    return {
      decision: {
        delete: false,
        reason:
          "the evidence about the executor kept changing while its removal was decided (an observation in flight or newly recorded)",
      },
      record,
    };
  });

/**
 * Settle a removal the runtime was asked to make and whose outcome nobody recorded (review 8 #7),
 * from what the runtime says of the executor: gone ⇒ `deleted`; still there ⇒ issued again when
 * the evidence it was authorized on still stands (`reissue`); still there with that evidence
 * changed ⇒ kept, the removal still issued, until the runtime's bound on a removal request has
 * passed since it was issued (review 9 #5: presence proves only that the request has not finished)
 * — then given up and decided again on what is current. `kept`: its issuer still holds it, the
 * request may still act, the runtime could not say, or the record could not be settled.
 */
const settleIssuedRemoval = (
  ledger: CaptureDrainLedger,
  runId: string,
  runtime: ExecutorRuntimeState | undefined,
  fenceMs: number | undefined,
): Effect.Effect<
  | { readonly kind: "reissue"; readonly ticket: DeletionTicket }
  | { readonly kind: "kept"; readonly reason: string }
  | { readonly kind: "settled" }
> =>
  Effect.gen(function* () {
    const prefix = `Capture drain · run ${runId}`;
    if (runtime === undefined || runtime === "unknown") {
      return {
        kind: "kept" as const,
        reason:
          "the runtime was asked to remove this executor and nothing recorded how that went; it is kept until the runtime says whether it still has it",
      };
    }
    const settled = yield* ledger.reconcileIssuedDeletion(
      runId,
      runtime === "missing" ? "gone" : "present",
      fenceMs,
    );
    switch (settled.kind) {
      case "deleted":
        yield* Effect.logWarning(
          `${prefix}: the removal of its executor issued earlier was carried out (the runtime no longer has it); recorded deleted.`,
        );
        return { kind: "settled" as const };
      case "reissue":
        yield* Effect.logWarning(
          `${prefix}: the removal of its executor issued earlier has no recorded outcome and the runtime still has it; the evidence it was authorized on still stands, so it is issued again.`,
        );
        return { kind: "reissue" as const, ticket: settled.ticket };
      case "outstanding":
        yield* Effect.logWarning(
          `${prefix}: the removal of its executor issued earlier has no recorded outcome, the runtime still has it, and the evidence it was authorized on changed since; the earlier request may still act, so the removal stays issued and the executor is kept (nothing is observed or recovered) until the runtime no longer has it or the runtime's bound on that request has passed.`,
        );
        return {
          kind: "kept" as const,
          reason:
            "a removal of this executor was issued and may still act on the runtime, and the evidence changed since it was authorized; it is kept until the outcome is known",
        };
      case "released":
        yield* Effect.logWarning(
          `${prefix}: the removal of its executor issued earlier has no recorded outcome, the runtime still has it, and the runtime's bound on that request has passed, so it can no longer act; the evidence changed since it was authorized, so it is given up and decided again on what is current.`,
        );
        return { kind: "settled" as const };
      case "none":
        return { kind: "settled" as const };
      case "held":
        return {
          kind: "kept" as const,
          reason: "the removal of this executor was issued and its issuer is still waiting on it",
        };
      case "unknown":
        return {
          kind: "kept" as const,
          reason:
            "the runtime was asked to remove this executor and its outcome could not be settled; it is kept",
        };
    }
  });

/** A decision `authorizedDeletion` made, with the ticket holding the removal it authorized. */
export interface AuthorizedDeletion {
  readonly decision: ExecutorDeletionDecision;
  readonly record: CaptureDrainRead;
  /** Holds the removal (decision 21); absent when it rests on no evidence, or was done already. */
  readonly ticket?: DeletionTicket | undefined;
  /** Another deleter's removal is live: nothing was decided (not a retention). */
  readonly heldElsewhere?: boolean | undefined;
}

/**
 * Run the runtime call that removes an executor under the ticket that holds its removal
 * (decision 21): re-checked RIGHT BEFORE the call (still held, nothing voided it, the evidence it
 * was authorized on still current), the hold renewed while the call runs, `deleted` recorded
 * after it succeeded, and the hold given up when it failed. `voided`: nothing was called — decide
 * again. No ticket (a removal resting on no recorded evidence, or one done already): just the
 * call.
 */
export const removeUnderDeletion = <A, E, R>(input: {
  readonly ledger: CaptureDrainLedger | undefined;
  readonly runId: string;
  readonly ticket: DeletionTicket | undefined;
  readonly remove: Effect.Effect<A, E, R>;
  /**
   * Run right before the runtime call, once the removal was re-checked and issued: nothing can
   * veto it any more (review 9 #9: the one signal that a removal is under way).
   */
  readonly onIssued?: Effect.Effect<void> | undefined;
}): Effect.Effect<
  { readonly removed: true; readonly value: A } | { readonly removed: false },
  E,
  R
> =>
  Effect.gen(function* () {
    const { ledger, runId, ticket } = input;
    if (ledger === undefined || ticket === undefined) {
      yield* input.onIssued ?? Effect.void;
      const value = yield* input.remove;
      return { removed: true as const, value };
    }
    // Checked and marked issued in one step (review 8 #7): from here on the removal stays
    // exclusionary until its outcome is recorded below, or settled from the runtime by whoever
    // finds it with its hold lapsed — a lease cannot revoke a request the runtime already has.
    if (!(yield* ledger.issueDeletion(runId, ticket))) {
      yield* Effect.logWarning(
        `Capture drain · run ${runId}: the removal of its executor was voided before the runtime was asked to remove it (newer evidence, or its hold lapsed); deciding again on what is current.`,
      );
      return { removed: false as const };
    }
    yield* input.onIssued ?? Effect.void;
    // Renewed for as long as the runtime call runs, through failed renewals (a database that is
    // briefly unreachable): a hold that lapsed meanwhile is live again once a renewal lands.
    const renew = ledger
      .confirmDeletion(runId, ticket)
      .pipe(Effect.delay(DELETION_RENEW_EVERY_MS), Effect.forever);
    const value = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(renew);
        return yield* input.remove;
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? ledger.completeDeletion(runId, ticket)
          : removalFailed(ledger, runId, ticket, exit.cause),
      ),
    );
    return { removed: true as const, value };
  });

/**
 * A removal's runtime call failed (review 9 #5, decision 27). Only the runtime's definitive
 * refusal (`isRemovalRefusal`: it answered and did not act, or nothing was sent) gives the
 * removal up. Anything else — a transport error after the request may have gone out, a timeout,
 * an interruption, a defect — is an outcome nobody knows: the provider may still act on it, so
 * the removal stays issued and exclusionary (no observation, no recovery) and is settled from what
 * the runtime says of the executor.
 */
const removalFailed = <E>(
  ledger: CaptureDrainLedger,
  runId: string,
  ticket: DeletionTicket,
  cause: Cause.Cause<E>,
): Effect.Effect<void> => {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && isRemovalRefusal(error.value)) {
    return ledger.releaseDeletion(runId, ticket);
  }
  return Effect.logError(
    `Capture drain · run ${runId}: the runtime call removing its executor failed with an outcome nobody knows (the request may have reached the runtime); the removal stays issued, nothing is observed or recovered, and it is settled from what the runtime says of the executor.`,
    cause,
  ).pipe(Effect.andThen(ledger.lapseIssuedDeletion(runId, ticket)));
};

/**
 * The whole owned removal of an executor (decision 21): decide and authorize on the evidence as
 * it stands (`authorizedDeletion`), then remove under the ticket (`removeUnderDeletion`); a
 * removal voided before its runtime call is decided again on what is current (at most
 * `DELETION_AUTHORIZATION_ATTEMPTS` times, then kept). `kept`: the last decision, and whether
 * another deleter held it.
 */
export const deleteOnEvidence = <A, E, R>(input: {
  readonly ledger: CaptureDrainLedger | undefined;
  readonly runId: string;
  readonly decide: (record: CaptureDrainRead) => ExecutorDeletionDecision;
  readonly remove: (basis: ExecutorDeletionBasis) => Effect.Effect<A, E, R>;
}): Effect.Effect<
  | { readonly kind: "removed"; readonly basis: ExecutorDeletionBasis; readonly value: A }
  | {
      readonly kind: "kept";
      readonly decision: Extract<ExecutorDeletionDecision, { readonly delete: false }>;
      readonly record: CaptureDrainRead;
      readonly heldElsewhere: boolean;
    },
  E,
  R
> =>
  Effect.gen(function* () {
    let last: AuthorizedDeletion | undefined;
    for (let attempt = 0; attempt < DELETION_AUTHORIZATION_ATTEMPTS; attempt += 1) {
      const authorized = yield* authorizedDeletion(input);
      last = authorized;
      const { decision } = authorized;
      if (!decision.delete) {
        return {
          kind: "kept" as const,
          decision,
          record: authorized.record,
          heldElsewhere: authorized.heldElsewhere === true,
        };
      }
      const removal = yield* removeUnderDeletion({
        ledger: input.ledger,
        runId: input.runId,
        ticket: authorized.ticket,
        remove: input.remove(decision.basis),
      });
      if (removal.removed) {
        return { kind: "removed" as const, basis: decision.basis, value: removal.value };
      }
    }
    return {
      kind: "kept" as const,
      decision: {
        delete: false as const,
        reason: "its removal was voided by newer evidence each time it was about to be made",
      },
      record: last?.record ?? { readable: false },
      heldElsewhere: false,
    };
  });

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
    case "nothing-to-save":
      return "its recovery boot found nothing to save: it never materialized a capture, so no user code ran on it";
    case "issued-before":
      return "its removal was issued earlier on evidence that still stands, and the runtime still had it";
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
  (reportsComplete(next) && !reportsComplete(previous));

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
    reportsComplete(status)
      ? "final flush complete"
      : status.complete !== undefined
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

/** One observation of an executor in flight: the fence its answer resolves. */
export interface CaptureObservationFence {
  readonly token: string;
}

/**
 * Where the answers of an executor's daemon are recorded, and how each is fenced (review 6 #4,
 * #5, decision 18). Every command that can bring back a status — a flush or a status, from a
 * drain, a probe, a sampler or the public routes — is sent only after `open` marked an
 * observation in flight, and its answer is recorded (`record`) before anything else is asked.
 * Nothing received: the fence is resolved (`close`). An answer received but not recorded leaves
 * the fence open, and the executor reads unknown until a later observation is recorded.
 */
export interface CaptureObservationRecorder {
  /** Mark an observation in flight; `undefined` when it cannot be marked (nothing is asked). */
  readonly open: Effect.Effect<CaptureObservationFence | undefined>;
  /** Record an answer received under `fence`; `false` when it could not be recorded durably. */
  readonly record: (
    fence: CaptureObservationFence,
    status: CaptureFlushReport,
    atMs: number,
  ) => Effect.Effect<boolean>;
  /** Resolve a fence under which nothing was received. */
  readonly close: (fence: CaptureObservationFence) => Effect.Effect<void>;
}

/** How long past its own bound an observation's fence stays open before it may lapse. */
export const OBSERVATION_FENCE_MARGIN_MS = 60_000;

/** The recorder over a drain ledger, for one run's executor; fences lapse after `boundMs` + margin. */
export const ledgerObservationRecorder = (
  ledger: CaptureDrainLedger,
  runId: string,
  boundMs: number,
): CaptureObservationRecorder => ({
  open: ledger.openObservation(runId, boundMs + OBSERVATION_FENCE_MARGIN_MS),
  record: (fence, status, atMs) => ledger.recordStatus(runId, status, atMs, fence),
  close: (fence) => ledger.closeObservation(runId, fence),
});

/** No observation could be marked in flight, so nothing was asked of the daemon. */
export class CaptureObservationUnrecordedError extends Error {
  public override readonly name = "CaptureObservationUnrecordedError";
}

/** A round trip bounded by `timeoutMs`; one that runs out is a lost answer (a transport error). */
const boundedRoundTrip = <E, R>(
  roundTrip: Effect.Effect<CaptureFlushReport, E, R>,
  timeoutMs: number | undefined,
  operation: "captureFlush" | "captureStatus",
): Effect.Effect<CaptureFlushReport, E | TransportError, R> =>
  timeoutMs === undefined
    ? roundTrip
    : roundTrip.pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new TransportError({
                operation,
                message: `capture ${operation === "captureFlush" ? "flush" : "status"} got no answer within ${String(timeoutMs)} ms`,
                cause: undefined,
              }),
            ),
        }),
      );

/** An answer, and whether it is recorded (`false`: its fence stays open; nothing more is asked). */
interface ObservedAnswer {
  readonly status: CaptureFlushReport;
  readonly recorded: boolean;
}

/**
 * One round trip that can bring back a status, fenced: the observation is marked in flight before
 * it is sent, the answer recorded as soon as it arrives, and the fence resolved when nothing
 * arrived (a failure, a timeout, an interruption before the answer).
 */
const observedRoundTrip = <E, R>(
  recorder: CaptureObservationRecorder,
  roundTrip: Effect.Effect<CaptureFlushReport, E, R>,
): Effect.Effect<ObservedAnswer, E | CaptureObservationUnrecordedError, R> =>
  Effect.gen(function* () {
    const fence = yield* recorder.open;
    if (fence === undefined) {
      return yield* Effect.fail(
        new CaptureObservationUnrecordedError(
          "no observation of the executor could be marked in flight, so nothing was asked of its daemon",
        ),
      );
    }
    const status = yield* roundTrip.pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : recorder.close(fence))),
    );
    const atMs = yield* Clock.currentTimeMillis;
    const recorded = yield* recorder.record(fence, status, atMs);
    return { status, recorded };
  });

type Sample =
  | {
      readonly kind: "status";
      readonly status: CaptureFlushReport;
      /** `false`: the answer could not be recorded; its observation stays unresolved. */
      readonly recorded: boolean;
    }
  /** The daemon answered but refused the command: it is alive, the queue cannot be read. */
  | { readonly kind: "refused"; readonly detail: string }
  /** No observation could be marked in flight: nothing was asked. */
  | { readonly kind: "unrecorded"; readonly detail: string }
  | { readonly kind: "unreachable"; readonly detail: string };

/**
 * One round trip, recorded: `{ flush }` sends that request (every drain ends the executor, so a
 * drain's is FINAL: quiesce, snapshot both classes, ship, report `complete`); a `status` reads the
 * queue. Every answer is recorded through `recorder` before it is returned.
 */
const sampleCapture = (
  target: SealantTarget,
  command: { readonly flush: CaptureFlushRequest } | "status",
  timeoutMs: number,
  recorder: CaptureObservationRecorder,
): Effect.Effect<Sample, never, SealantRuntime> =>
  (command === "status"
    ? observedRoundTrip(
        recorder,
        boundedRoundTrip(
          Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* SealantRuntime;
              const daemon = yield* runtime.connect(target);
              return yield* daemon.captureStatus();
            }),
          ),
          timeoutMs,
          "captureStatus",
        ),
      )
    : // A FINAL's sweep closes the connection that carried it: its answer is read again.
      observedFlushAnswer(target, command.flush, { recorder, roundTripTimeoutMs: timeoutMs })
  ).pipe(
    Effect.timeout(timeoutMs),
    Effect.map((answer): Sample => ({ kind: "status", ...answer })),
    Effect.catch((error) =>
      Effect.succeed<Sample>(
        error instanceof CaptureObservationUnrecordedError
          ? { kind: "unrecorded", detail: error.message }
          : error instanceof SealantControlError
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
 * One `capture.status` round trip, recorded, as it went: the status read, a refusal (the daemon
 * answers), unreachable, or unrecorded (no observation could be marked in flight, so nothing was
 * asked — nothing is concluded from it). The exit reconciler's probe: any answer means a live
 * daemon.
 */
export const probeCaptureDaemon = (
  target: SealantTarget,
  timeoutMs: number,
  recorder: CaptureObservationRecorder,
): Effect.Effect<
  | { readonly kind: "status"; readonly status: CaptureFlushReport; readonly recorded: boolean }
  | { readonly kind: "refused" | "unreachable" | "unrecorded"; readonly detail: string },
  never,
  SealantRuntime
> => sampleCapture(target, "status", timeoutMs, recorder);

/** One recorded `capture.status` round trip, for callers that only watch (the deadline sweep). */
export const readCaptureStatus = (
  target: SealantTarget,
  timeoutMs: number,
  recorder: CaptureObservationRecorder,
): Effect.Effect<CaptureFlushReport | undefined, never, SealantRuntime> =>
  sampleCapture(target, "status", timeoutMs, recorder).pipe(
    Effect.map((sample) => (sample.kind === "status" ? sample.status : undefined)),
  );

/**
 * Whether a status says a FINAL is still at work (sealantd `in-progress`): wait for it, do not ask
 * again.
 */
const finalInProgress = (status: CaptureFlushReport): boolean =>
  status.incompleteReason === "in-progress";

/** How often, and how far apart, a FINAL whose answer was lost is re-read. */
const LOST_FINAL_REREADS = 5;
const LOST_FINAL_REREAD_DELAY_MS = 500;

/**
 * One `capture.flush`, as its answer should be read, every answer recorded. A FINAL's own sweep
 * stops every writer on the executor — the relay that carried the request included (Docker reaches
 * the daemon through a `docker exec … socat` bridge, which the sweep kills) — so its connection
 * often closes before the answer arrives (e2e 6: every stop logged `refused: connection closed`).
 * A closed connection is a LOST answer, never the outcome: the status is read again over a new
 * connection at once, and the FINAL asked again when the daemon is not already at one (a repeated
 * FINAL answers what the first concluded; it stops nothing twice).
 *
 * Every answer — the FINAL's, a status read again, a repeated FINAL's — is recorded through
 * `recorder` before the next command is sent (review 6 #4): an answer received is evidence about
 * the executor whatever happens after it. One that cannot be recorded ends the exchange (nothing
 * more is asked; its fence stays open and the executor reads unknown). When a later answer is lost
 * and nothing more can be read, the LAST ANSWER RECEIVED is returned — never the transport error
 * that followed it, which would turn a received "not saved" into a lost one. Only when no answer
 * was received at all does the original error stand. A daemon's refusal (`SealantControlError`) is
 * an answer and is returned as it is; a SUSPEND flush sweeps nothing and is asked once.
 */
const observedFlushAnswer = (
  target: SealantTarget,
  request: CaptureFlushRequest,
  options: {
    readonly recorder: CaptureObservationRecorder;
    readonly rereads?: number;
    readonly rereadDelayMs?: number;
    /** Bound on each round trip (the whole exchange is the caller's to bound). */
    readonly roundTripTimeoutMs?: number;
  },
): Effect.Effect<
  ObservedAnswer,
  SealantError | CaptureObservationUnrecordedError,
  SealantRuntime
> =>
  Effect.gen(function* () {
    const runtime = yield* SealantRuntime;
    // Whether the last round trip reached the daemon at all: a connection that never opened says
    // the daemon is not there (nothing is re-read); one that closed under the request says only
    // that its answer was lost.
    let reached = false;
    const over = (
      operation: "captureFlush" | "captureStatus",
      use: (daemon: SealantSession) => Effect.Effect<CaptureFlushReport, SealantError>,
    ) =>
      observedRoundTrip(
        options.recorder,
        boundedRoundTrip(
          Effect.scoped(
            Effect.gen(function* () {
              reached = false;
              const daemon = yield* runtime.connect(target);
              reached = true;
              return yield* use(daemon);
            }),
          ),
          options.roundTripTimeoutMs,
          operation,
        ),
      );
    const first = yield* Effect.result(
      over("captureFlush", (daemon) => daemon.captureFlush(request)),
    );
    if (Result.isSuccess(first)) {
      return first.success;
    }
    if (
      request.kind !== "final" ||
      !reached ||
      first.failure instanceof SealantControlError ||
      first.failure instanceof CaptureObservationUnrecordedError
    ) {
      return yield* Effect.fail(first.failure);
    }
    const rereads = options.rereads ?? LOST_FINAL_REREADS;
    const delayMs = options.rereadDelayMs ?? LOST_FINAL_REREAD_DELAY_MS;
    // The last answer the daemon gave in this exchange: returned rather than a later lost one.
    let last: ObservedAnswer | undefined;
    for (let attempt = 0; attempt < rereads; attempt += 1) {
      const status = yield* Effect.result(
        over("captureStatus", (daemon) => daemon.captureStatus()),
      );
      if (Result.isSuccess(status)) {
        last = status.success;
        if (
          !status.success.recorded ||
          reportsComplete(status.success.status) ||
          finalInProgress(status.success.status)
        ) {
          return status.success;
        }
        const again = yield* Effect.result(
          over("captureFlush", (daemon) => daemon.captureFlush(request)),
        );
        if (Result.isSuccess(again)) {
          return again.success;
        }
        if (
          again.failure instanceof SealantControlError ||
          again.failure instanceof CaptureObservationUnrecordedError
        ) {
          return yield* Effect.fail(again.failure);
        }
      } else if (
        status.failure instanceof SealantControlError ||
        status.failure instanceof CaptureObservationUnrecordedError
      ) {
        return yield* Effect.fail(status.failure);
      } else if (!reached) {
        // The daemon is not answering any more: nothing more to read.
        break;
      }
      yield* Effect.sleep(delayMs);
    }
    if (last !== undefined) {
      yield* Effect.logWarning(
        `Capture flush: the FINAL's answer was lost and could not be read again; returning the last status the daemon gave (${describeCaptureStatus(last.status)}), not the lost answer (${first.failure instanceof Error ? first.failure.message : String(first.failure)}).`,
      );
      return last;
    }
    return yield* Effect.fail(first.failure);
  });

/**
 * One `capture.flush` relayed for a caller (the public flush route), every answer recorded
 * through `recorder` (`observedFlushAnswer`): the answer the daemon gave — a lost FINAL answer is
 * read again, and when a later one is lost the last received is returned.
 */
export const captureFlushAnswer = (
  target: SealantTarget,
  request: CaptureFlushRequest,
  options: {
    readonly recorder: CaptureObservationRecorder;
    readonly rereads?: number;
    readonly rereadDelayMs?: number;
    readonly roundTripTimeoutMs?: number;
  },
): Effect.Effect<
  CaptureFlushReport,
  SealantError | CaptureObservationUnrecordedError,
  SealantRuntime
> => observedFlushAnswer(target, request, options).pipe(Effect.map((answer) => answer.status));

/**
 * One `capture.status` relayed for a caller (the public status route), recorded through
 * `recorder` before it is returned.
 */
export const captureStatusAnswer = (
  target: SealantTarget,
  recorder: CaptureObservationRecorder,
  roundTripTimeoutMs?: number,
): Effect.Effect<
  CaptureFlushReport,
  SealantError | CaptureObservationUnrecordedError,
  SealantRuntime
> =>
  Effect.gen(function* () {
    const runtime = yield* SealantRuntime;
    const roundTrip = Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* runtime.connect(target);
        return yield* daemon.captureStatus();
      }),
    );
    const answer = yield* observedRoundTrip(
      recorder,
      boundedRoundTrip(roundTrip, roundTripTimeoutMs, "captureStatus"),
    );
    return answer.status;
  });

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
  /**
   * A claim on the run's drain the caller already holds (`ledger.claim`): the drain works under
   * it and leaves it held, so the caller keeps the run through what follows (the removal of the
   * runtime) and releases it itself. Absent: the drain claims the run and releases it on return.
   */
  readonly claim?: CaptureDrainClaim;
  /**
   * The executor already answered a FINAL (an earlier call of this drain): this call polls its
   * status first instead of asking for another FINAL (review 7 #6). A FINAL is still asked when
   * the queue empties without the daemon confirming.
   */
  readonly opensWithStatus?: boolean;
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
  const claimed = input.claim ?? (yield* ledger.claim(runId));
  if (claimed === undefined) {
    return { kind: "busy" } satisfies CaptureDrainOutcome;
  }
  const { token } = claimed;
  const prefix = `Capture drain (${label}) · run ${runId}`;
  // Every answer this drain receives is recorded as it arrives, under a fence opened before its
  // request was sent (review 6 #4, #5).
  const recorder = ledgerObservationRecorder(ledger, runId, settings.requestTimeoutMs);
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
      if (lost) {
        return { kind: "busy" } satisfies CaptureDrainOutcome;
      }
      if (outcome.kind !== "drained") {
        return outcome;
      }
      // Saved by this drain's reading — unless Core received a newer one from the same executor
      // meanwhile (the public status or flush route, another path) that says its work is not
      // saved: every observation of the executor counts, whoever asked (review 5 #3). The record
      // keeps the newest reading, so it is read back before anything is removed on this one.
      const recorded = yield* ledger.read(runId);
      const newest = recorded.readable ? recorded.entry : undefined;
      const contradiction = !recorded.readable
        ? "its drain record could not be read back to confirm no newer observation contradicts it"
        : (newest?.observationsInFlight ?? 0) > 0
          ? "another observation of the executor is in flight or could not be recorded, so what it said is not known"
          : newest?.lastUnreadable === true
            ? "a newer observation of the executor is on record that cannot be read"
            : newest?.last !== undefined && !reportsComplete(newest.last)
              ? `a newer observation of the executor says its work is not saved (${describeCaptureStatus(newest.last)})`
              : unsavedOnRecord(newest);
      if (contradiction === undefined) {
        return outcome;
      }
      yield* Effect.logError(
        `${prefix}: not saved · not confirmed · kept · this drain read the final flush complete, but ${contradiction}.`,
      );
      const kept: CaptureDrainOutcome = {
        kind: "unconfirmed",
        status: newest?.last ?? outcome.status,
        detail: contradiction,
      };
      yield* persist(kept);
      return lost ? ({ kind: "busy" } satisfies CaptureDrainOutcome) : kept;
    });

  return yield* Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    let command: "flush" | "status" = input.opensWithStatus === true ? "status" : "flush";
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
        recorder,
      );
      const now = yield* Clock.currentTimeMillis;
      let refusedDetail: string | undefined;

      if (sample.kind === "unrecorded" || (sample.kind === "status" && !sample.recorded)) {
        // What the daemon says cannot be recorded (or could not be marked in flight, and nothing
        // was asked): nothing more is asked this call, and nothing concludes on it. An answer
        // that was received stays unresolved on record, so the executor reads unknown.
        const detail =
          sample.kind === "unrecorded"
            ? sample.detail
            : `the daemon's answer could not be recorded (${describeCaptureStatus(sample.status)})`;
        yield* Effect.logWarning(
          `${prefix}: not saved · not recorded · ${detail}; the drain stops here and every sweep asks again.`,
        );
        return yield* finish({
          kind: "pending",
          status: sample.kind === "status" ? sample.status : entry.last,
        });
      }

      if (sample.kind === "unreachable") {
        const unreachableSince = entry.unreachableSince ?? now;
        entry = { ...entry, unreachableSince };
        const unreachableForMs = now - unreachableSince;
        // A silent daemon on an executor that already ENDED will not answer again: nothing is
        // gained by waiting out the silent window, and every retry is a spurious drain of a
        // runtime that is gone. Asked at once, not only when the window closes.
        const endedNow = yield* input.runtimeState;
        const last = entry.last;
        if (endedNow !== "running" && last !== undefined && reportsComplete(last)) {
          // Its daemon reported the final flush complete, then the executor ended (the stop that
          // followed it, or the daemon's own exit after the FINAL): that completion is the
          // evidence, and nothing of the executor can add to it. The stop proceeds.
          yield* Effect.logInfo(
            `${prefix}: saved · the executor ${endedNow === "missing" ? "is gone" : "ended"} after its daemon reported the final flush complete · ${describeCaptureStatus(last)}`,
          );
          return yield* finish({ kind: "drained", status: last });
        }
        if (endedNow === "exited") {
          // Ended without a final flush confirmed complete: its disk keeps the staged captures.
          // Kept now (the caller records it retained, and recovery starts), not after the window.
          const detail = `the executor ended without a final flush confirmed complete; its disk keeps the staged captures (${sample.detail})`;
          if (!entry.silentLogged) {
            entry = { ...entry, silentLogged: true };
            yield* Effect.logError(
              `${prefix}: not saved · executor exited · kept · ${detail}. The runtime is left in place; remove it only once its captures are recovered.${
                last === undefined ? "" : ` Last status: ${describeCaptureStatus(last)}.`
              }`,
            );
          }
          return yield* finish({ kind: "silent", silentForMs: unreachableForMs, detail });
        }
        if (unreachableForMs >= settings.unreachableWindowMs) {
          const seconds = String(Math.round(unreachableForMs / 1000));
          const lastLine =
            entry.last === undefined ? "" : ` Last status: ${describeCaptureStatus(entry.last)}.`;
          if (endedNow === "missing") {
            yield* Effect.logWarning(
              `${prefix}: sealantd silent for ${seconds} s (${sample.detail}) and the runtime reports nothing of the executor left; there is no disk to keep, the stop proceeds.${lastLine}`,
            );
            return yield* finish({
              kind: "gone",
              silentForMs: unreachableForMs,
              detail: sample.detail,
            });
          }
          if (!entry.silentLogged) {
            entry = { ...entry, silentLogged: true };
            yield* Effect.logError(
              `${prefix}: not saved · daemon silent · kept · sealantd has not answered for ${seconds} s (${sample.detail}) while the runtime reports the executor running. The workspace is left running; every sweep asks again.${lastLine}`,
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
            entry = { ...entry, last: status, lastAtMs: now, keptLogged: true };
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
          if (reportsComplete(status)) {
            yield* Effect.logInfo(`${prefix}: saved · ${describeCaptureStatus(status)}`);
            entry = { ...entry, last: status, lastAtMs: now, keptLogged: false };
            return yield* finish({ kind: "drained", status });
          }
          if (status.pending === 0) {
            entry = { ...entry, last: status, lastAtMs: now };
            if (flushesLeft > 0) {
              // Empty but unconfirmed: one more FINAL flush in this call.
              command = "flush";
              continue;
            }
            const detail = [
              status.complete !== undefined
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
          entry = { ...entry, last: status, lastAtMs: now };
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
  }).pipe(Effect.ensuring(input.claim === undefined ? ledger.release(runId, token) : Effect.void));
});
