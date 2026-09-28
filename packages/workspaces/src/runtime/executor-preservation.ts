/**
 * The ONE preservation policy for deleting an executor (sealantd ADR-0015: a capture-sourced
 * executor's disk holds work that exists nowhere else until its daemon has saved it). Every path
 * that can remove an executor or its disk asks `decideExecutorDeletion` first: the planned stop,
 * the exit reconciler, the Kubernetes orphan sweep, launch adoption / redelivery / readiness
 * cleanup in every adapter, the retained-launch and deadline sweeps, and recovery.
 *
 * It fails closed. An executor that is capture-sourced — or whose source nothing records, which
 * the callers resolve to capture-sourced — may be deleted only on one of:
 *
 *  - **observed complete**: Core itself read `complete: true` from THIS executor's daemon (the
 *    drain ledger's last status: the daemon quiesced every writer, snapshotted both classes and
 *    registered everything);
 *  - **attested complete**: the control plane that owns the store attested, on the stop request,
 *    a sealed FINAL of THIS executor (`completion: { executorId, epoch, captureN, sealedAt }`,
 *    the id matching the run's executor, and nothing Core observed from it since contradicting
 *    it: `attestationCoversExecutor`). Evidence for an executor that ENDED: a running one is
 *    drained first, whatever is on record;
 *  - **discarded**: the owner's explicit, audited discard (`stop({ discardUnsaved: true })`);
 *  - **missing**: the runtime positively reports nothing of the executor is left (there is no
 *    disk to keep; removing the siblings loses nothing).
 *
 * A RUNNING executor (or one whose state is unknown) goes only on a discard or on a drain the
 * caller just ran that read its final flush complete (`drainedNow`): recorded evidence is about
 * the executor as it was, and it may have written since.
 *
 * Everything else is retained: a running executor (drain it first), an exited one with its disk
 * (sealantd exits 75 after an incomplete final flush; a plain `docker stop`, a lost FINAL reply,
 * a worker that died before recording what it saw — none of them is evidence), an executor whose
 * state is unknown, and one whose drain ledger could not be read.
 */

/** What the runtime positively reports of the executor; `unknown` when it cannot say. */
export type ExecutorRuntimeState = "running" | "exited" | "missing" | "unknown";

export interface ExecutorDeletionEvidence {
  /** Whether the executor boots from a capture source (unknown resolves to `true` upstream). */
  readonly captureSourced: boolean;
  readonly runtime: ExecutorRuntimeState;
  /**
   * Core read `complete: true` from this executor's daemon (the drain record). Counts only for
   * an executor that ENDED: a running one may have written since.
   */
  readonly observedComplete?: boolean;
  /**
   * The control plane attested a sealed FINAL of this executor (already matched to it and
   * weighed against Core's own observations). Counts only for an executor that ENDED.
   */
  readonly attestedComplete?: boolean;
  /**
   * A drain the caller has just run reached this executor's daemon and read its final flush
   * `complete` (it stopped every writer, snapshotted both classes and registered everything).
   * The one evidence that lets a RUNNING executor go.
   */
  readonly drainedNow?: boolean;
  /** The owner discarded this run's unsaved captures (audited). */
  readonly discarded?: boolean;
  /** The drain ledger could not be read: nothing above is known. */
  readonly ledgerUnreadable?: boolean;
}

export type ExecutorDeletionBasis =
  | "not-capture"
  | "missing"
  | "observed-complete"
  | "attested-complete"
  | "discarded";

export type ExecutorDeletionDecision =
  | { readonly delete: true; readonly basis: ExecutorDeletionBasis }
  | { readonly delete: false; readonly reason: string };

/** Whether the executor (and its disk) may be deleted now, and why. Pure; never throws. */
export const decideExecutorDeletion = (
  evidence: ExecutorDeletionEvidence,
): ExecutorDeletionDecision => {
  if (!evidence.captureSourced) {
    return { delete: true, basis: "not-capture" };
  }
  if (evidence.discarded === true) {
    return { delete: true, basis: "discarded" };
  }
  if (evidence.drainedNow === true) {
    return { delete: true, basis: "observed-complete" };
  }
  // Recorded evidence (an earlier complete flush, an attestation) is about the executor as it
  // was: it lets go only one that has ENDED since. A running (or unknown) executor may have
  // written after it, so only a drain now lets it go, whatever is on record (review 4 #1).
  const ended = evidence.runtime === "exited" || evidence.runtime === "missing";
  if (ended && evidence.observedComplete === true) {
    return { delete: true, basis: "observed-complete" };
  }
  if (ended && evidence.attestedComplete === true) {
    return { delete: true, basis: "attested-complete" };
  }
  if (evidence.runtime === "missing") {
    return { delete: true, basis: "missing" };
  }
  const unknownLedger =
    evidence.ledgerUnreadable === true ? "; its drain record could not be read" : "";
  switch (evidence.runtime) {
    case "running":
      return {
        delete: false,
        reason: `the executor is running and its work is not confirmed saved by a drain of it${unknownLedger}`,
      };
    case "exited":
      return {
        delete: false,
        reason: `the executor ended and its disk holds work not confirmed saved (no complete final flush observed, attested or discarded)${unknownLedger}`,
      };
    case "unknown":
      return {
        delete: false,
        reason: `the runtime cannot say whether the executor or its disk remains${unknownLedger}`,
      };
  }
};

/**
 * The control plane's attestation that a sealed FINAL of an executor is in its store: the
 * executor it names, the lease epoch the seal was made under, the chain position of the sealed
 * capture, and when the store recorded the seal. Carried on the stop request (`completion`).
 */
export interface CompletionAttestation {
  readonly executorId: string;
  readonly epoch: number;
  readonly captureN: number;
  /** When the store recorded the seal (Unix ms); absent from a control plane that predates it. */
  readonly sealedAtMs?: number | undefined;
}

/** What names one executor: the run that launched it and the runtime's own identifiers. */
export interface ExecutorIdentity {
  readonly runId: string;
  readonly resourceId: string | null;
  readonly reference: string | null;
}

/**
 * Core's own latest observation of the executor's daemon (the drain ledger's last status): its
 * lease epoch, the chain position of its newest capture, whether it was a complete final flush,
 * and when Core read it (Core's clock). `unreadable`: a status is stored but cannot be read.
 */
export type ObservedCapture =
  | {
      readonly readable: true;
      readonly epoch: number;
      readonly headN?: number | undefined;
      /** `complete: true` and no reason it is not (the one saved answer). */
      readonly complete: boolean;
      /** Why it is not complete, as the daemon said (for the reason a stale attestation gets). */
      readonly incompleteReason?: string | undefined;
      /** When Core read it (Unix ms, Core's clock); absent on a status stored before it was kept. */
      readonly atMs?: number | undefined;
    }
  | { readonly readable: false };

/**
 * How far apart the store's clock (a seal's time) and Core's (an observation's time) are assumed
 * to be at most. An observation is taken as older than a seal only when it was made more than this
 * before the seal's time: an observation that may have followed the seal counts against it.
 */
export const ATTESTATION_CLOCK_SKEW_MS = 60_000;

/**
 * Core's observation from a stored drain status (`workspace_capture_drains.last_status`) and when
 * it was read. `undefined` when none is stored; `{ readable: false }` when one is stored but has
 * no numeric epoch (it cannot be compared with anything, so nothing may override it).
 */
export const observedCaptureFromStored = (
  stored: Readonly<Record<string, unknown>> | null | undefined,
  atMs: number | undefined,
): ObservedCapture | undefined => {
  if (stored === null || stored === undefined) {
    return undefined;
  }
  const epoch = stored["epoch"];
  if (typeof epoch !== "number") {
    return { readable: false };
  }
  const headN = stored["headN"];
  const incompleteReason = stored["incompleteReason"];
  return {
    readable: true,
    epoch,
    ...(typeof headN === "number" ? { headN } : {}),
    complete: stored["complete"] === true && incompleteReason === undefined,
    ...(typeof incompleteReason === "string" ? { incompleteReason } : {}),
    ...(atMs === undefined ? {} : { atMs }),
  };
};

/**
 * Whether an attestation is about THIS executor AND is not older than what Core itself last
 * observed of it (review 4 #1: received evidence beats stored evidence).
 *
 *  - Identity: its `executorId` is the run id, the runtime resource id or the runtime reference
 *    of the executor (`workspace.details().runtime.resourceId` is the one a client sees).
 *  - Epoch: not older than the last epoch Core observed from the executor's daemon (a seal from
 *    an earlier lease does not cover later work).
 *  - Freshness, in the same epoch: Core's latest observation that is NOT a complete final flush
 *    (pending work, `changed`, `unreadable`, `snapshot-failed`, anything but `complete`) revokes
 *    the seal unless it provably came before it: its head was still short of the sealed capture
 *    (`headN < captureN`), or Core read it more than `ATTESTATION_CLOCK_SKEW_MS` before the seal's
 *    time. An observation whose head is past the sealed capture revokes it whatever it says (a
 *    later capture exists that the seal does not cover). An attestation that carries no seal time
 *    cannot be ordered against an observation, so any incomplete one at or past its capture
 *    revokes it. A stored observation Core cannot read revokes it too (fail closed).
 *
 * A seal stands in for a LOST answer, never for a received one that said the work is not saved.
 */
export const attestationCoversExecutor = (
  attestation: CompletionAttestation,
  executor: ExecutorIdentity,
  observed: ObservedCapture | undefined,
): { readonly covers: true } | { readonly covers: false; readonly reason: string } => {
  const ids = [executor.runId, executor.resourceId, executor.reference].filter(
    (id): id is string => id !== null && id.length > 0,
  );
  if (!ids.includes(attestation.executorId)) {
    return {
      covers: false,
      reason: `the attestation names executor ${attestation.executorId}, not this run's executor (${ids.join(", ")})`,
    };
  }
  if (observed === undefined) {
    return { covers: true };
  }
  if (!observed.readable) {
    return {
      covers: false,
      reason:
        "Core's last observation of the executor's daemon cannot be read, so the attestation cannot be shown to follow it",
    };
  }
  if (attestation.epoch < observed.epoch) {
    return {
      covers: false,
      reason: `the attestation is for epoch ${String(attestation.epoch)}, older than epoch ${String(observed.epoch)} the executor last reported`,
    };
  }
  if (attestation.epoch > observed.epoch) {
    return { covers: true };
  }
  const n = String(attestation.captureN);
  if (observed.headN !== undefined && observed.headN > attestation.captureN) {
    return {
      covers: false,
      reason: `the executor last reported capture ${String(observed.headN)}, past the attested capture ${n}: the seal does not cover what came after it`,
    };
  }
  if (observed.complete) {
    return { covers: true };
  }
  if (observed.headN !== undefined && observed.headN < attestation.captureN) {
    // Core's incomplete observation was made while the head was still short of the sealed
    // capture: the seal came after it.
    return { covers: true };
  }
  const said = `not saved${
    observed.incompleteReason === undefined ? "" : ` (${observed.incompleteReason})`
  }`;
  if (attestation.sealedAtMs === undefined) {
    return {
      covers: false,
      reason: `the executor last reported its work ${said} at capture ${String(observed.headN ?? "unknown")}, and the attestation for capture ${n} carries no seal time to show it came after that`,
    };
  }
  if (
    observed.atMs !== undefined &&
    observed.atMs < attestation.sealedAtMs - ATTESTATION_CLOCK_SKEW_MS
  ) {
    return { covers: true };
  }
  return {
    covers: false,
    reason: `the executor reported its work ${said}${
      observed.atMs === undefined ? "" : ` at ${new Date(observed.atMs).toISOString()}`
    }, not before the seal of capture ${n} (${new Date(attestation.sealedAtMs).toISOString()}): a newer observation revokes an older seal`,
  };
};

/**
 * Whether a runtime can bring a retained, ENDED executor back on its own disk
 * (`RuntimeAdapter.recover` restarting it). Docker can (`docker start` of the kept container).
 * MicroVM can while the VM runs on after its daemon ended (the agent starts sealantd again in
 * recovery mode on the VM's disk); a TERMINATED VM's disk is gone, which `recover` reports as
 * `missing`. Kubernetes cannot restart an ended Pod.
 */
export const runtimeRestartsRetainedExecutors = (adapterId: string | null | undefined): boolean =>
  adapterId === "docker" || adapterId === "microvm";

/**
 * Whether the runtime hands the recovery boot its capture token itself (`recover({ secretEnv })`:
 * the MicroVM agent writes it on the VM) rather than reading a secret env file the worker stages
 * on its host again (Docker).
 */
export const runtimeRecoveryTakesSecretEnv = (adapterId: string | null | undefined): boolean =>
  adapterId === "microvm";
