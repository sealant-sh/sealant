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
 *    a sealed FINAL of THIS executor (`completion: { executorId, epoch, captureN }`, the id
 *    matching the run's executor, the epoch not older than any Core observed from it);
 *  - **discarded**: the owner's explicit, audited discard (`stop({ discardUnsaved: true })`);
 *  - **missing**: the runtime positively reports nothing of the executor is left (there is no
 *    disk to keep; removing the siblings loses nothing).
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
  /** Core read `complete: true` from this executor's daemon. */
  readonly observedComplete?: boolean;
  /** The control plane attested a sealed FINAL of this executor (already matched to it). */
  readonly attestedComplete?: boolean;
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
  if (evidence.observedComplete === true) {
    return { delete: true, basis: "observed-complete" };
  }
  if (evidence.attestedComplete === true) {
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
        reason: `the executor is running and its work is not confirmed saved${unknownLedger}`,
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
 * executor it names, the lease epoch the seal was made under, and the chain position of the
 * sealed capture. Carried on the stop request (`completion`).
 */
export interface CompletionAttestation {
  readonly executorId: string;
  readonly epoch: number;
  readonly captureN: number;
}

/** What names one executor: the run that launched it and the runtime's own identifiers. */
export interface ExecutorIdentity {
  readonly runId: string;
  readonly resourceId: string | null;
  readonly reference: string | null;
}

/**
 * Whether an attestation is about THIS executor: its `executorId` is the run id, the runtime
 * resource id or the runtime reference of the executor (`workspace.details().runtime.resourceId`
 * is the one a client sees), and its epoch is not older than the last epoch Core observed from
 * the executor's daemon (a seal from an earlier lease does not cover later work).
 */
export const attestationCoversExecutor = (
  attestation: CompletionAttestation,
  executor: ExecutorIdentity,
  observedEpoch: number | undefined,
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
  if (observedEpoch !== undefined && attestation.epoch < observedEpoch) {
    return {
      covers: false,
      reason: `the attestation is for epoch ${String(attestation.epoch)}, older than epoch ${String(observedEpoch)} the executor last reported`,
    };
  }
  return { covers: true };
};

/**
 * Whether a runtime can bring a retained, ENDED executor back on its own disk
 * (`RuntimeAdapter.recover` restarting it). Docker can (`docker start` of the kept container).
 * Kubernetes cannot restart an ended Pod, and a terminated MicroVM's disk is gone.
 */
export const runtimeRestartsRetainedExecutors = (adapterId: string | null | undefined): boolean =>
  adapterId === "docker";
