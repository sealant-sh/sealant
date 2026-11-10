import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  BoatObservationRepo,
  BoatObservationRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  DEFAULT_UNOWNED_LAUNCH_GRACE_MS,
  SealantDB,
} from "@sealant/db";
import {
  type BoatExecutionTarget,
  type BoatTunnelReservation,
  type BoatAllocationRecord,
} from "@sealant/validators";
import { Clock, Context, Effect, Layer, Redacted, Result } from "effect";

import { SealantRuntime, SealantRuntimeControlLive } from "../../sealantd/runtime.js";
import { BoatResourcesHost } from "../../worker/boat-resources.js";
import { databaseCaptureDrainLedger } from "../../worker/capture-drain-ledger.js";
import {
  authorizedDeletion,
  DEFAULT_CAPTURE_DRAIN_SETTINGS,
  describeDeletionBasis,
  drainCaptureBeforeStop,
  observedComplete,
  recordedDeletionEvidence,
  removeUnderDeletion,
  type CaptureDrainRead,
} from "../../worker/capture-drain.js";
import { boatSandboxIdSchema } from "./config.js";
import { BoatDischarge, boatDischargeLayer } from "./discharge.js";
import { BoatExecution, BoatExecutionError } from "./execution.js";
import { BoatObserver, boatObserverLayer, type BoatPresence } from "./observation.js";
import { BoatAllocationProvider } from "./provider.js";
import {
  BoatRemoval,
  boatRemovalLayer,
  type BoatRemovalError,
  type BoatRemovalProvider,
} from "./removal.js";

/** How often a ready VM's presence is read. */
const READY_OBSERVATION_MS = 60_000;

/** Unknown effects retain the exact VM, keys and port in custody. */
export class BoatFinalCloseError extends Error {
  readonly _tag = "BoatFinalCloseError";
  constructor(readonly code: "held" | "pending" | "unavailable") {
    super(`Boat FINAL close: ${code}`);
  }
}
/** One bounded page; the worker carries its cursor independently of allocation and resources. */
export interface BoatCloseSweep {
  readonly entries: readonly {
    readonly runId: string;
    readonly outcome: "closed" | "retained" | "pending" | "skipped" | "held" | "unavailable";
  }[];
  readonly next?: string;
}
/** FINAL close and original-boot capture recovery. */
export class BoatFinalClose extends Context.Service<
  BoatFinalClose,
  {
    readonly close: (
      target: BoatExecutionTarget,
    ) => Effect.Effect<"closed" | "retained" | "pending", BoatFinalCloseError>;
    /** Only a never-bound guest can be deleted without FINAL. CAS fences any concurrent binder. */
    readonly closeUnbound: (
      runId: string,
      sandboxId: string,
    ) => Effect.Effect<"closed" | "pending", BoatFinalCloseError>;
    readonly reconcile: (input: {
      readonly limit: number;
      readonly after?: string;
    }) => Effect.Effect<BoatCloseSweep, BoatFinalCloseError>;
  }
>()("@sealant/workspaces/boat/BoatFinalClose") {}
/**
 * How long a close waits to freeze its run's tunnel while a configuration of the same run is at
 * the gateway host, and how often it tries. The host lock is tried, never queued for, and it is
 * held across one gateway mutation (a few seconds of Docker calls, by a link job, the sweep or a
 * launch). Without the wait a close that met one failed at once and FINAL waited for the next
 * close pass. Well inside a close's own 120 s bound, beside its 60 s drain and 20 s deletion wait.
 */
export const BOAT_CLOSE_FREEZE = { waitMs: 15_000, pollMs: 500 } as const;

/**
 * The deletion operation a run has on record, if any: on its allocation, where every removal
 * writes it, or on its tunnel reservation, where a close before that wrote it for a run with a
 * tunnel. The tunnel's is read and never written.
 */
const recordedOf = (run: {
  readonly allocation: BoatAllocationRecord;
  readonly reservation: BoatTunnelReservation | undefined;
}) =>
  run.allocation.removal?.kind === "operation"
    ? { id: run.allocation.removal.id, completed: run.allocation.removal.completed }
    : run.reservation?.removal;

const complete = (record: CaptureDrainRead) =>
  record.readable &&
  record.entry?.lastUnreadable !== true &&
  (record.entry?.observationsInFlight ?? 0) === 0 &&
  observedComplete(record.entry);

const make: Effect.Effect<
  BoatFinalClose["Service"],
  never,
  | SealantDB
  | BoatObservationRepo
  | BoatDischarge
  | WorkspaceAttemptRepo
  | BoatAllocationRepo
  | BoatExecutionRepo
  | BoatTunnelRepo
  | WorkspaceCaptureDrainRepo
  | WorkspaceRuntimeInstanceRepo
  | BoatExecution
  | BoatResourcesHost
  | BoatRemoval
  | BoatObserver
  | SealantRuntime
> = Effect.gen(function* () {
  const db = yield* SealantDB;
  const allocations = yield* BoatAllocationRepo;
  const exchanges = yield* BoatExecutionRepo;
  const tunnels = yield* BoatTunnelRepo;
  const canonical = yield* WorkspaceCaptureDrainRepo;
  const runtimes = yield* WorkspaceRuntimeInstanceRepo;
  const execution = yield* BoatExecution;
  const host = yield* BoatResourcesHost;
  const removal = yield* BoatRemoval;
  const runtime = yield* SealantRuntime;
  const observer = yield* BoatObserver;
  const observations = yield* BoatObservationRepo;
  const attempts = yield* WorkspaceAttemptRepo;
  const discharger = yield* BoatDischarge;
  const observeError = () => new BoatFinalCloseError("unavailable");
  const ledger = databaseCaptureDrainLedger({
    db,
    owner: `boat-final-${randomUUID()}`,
    leaseMs: 180_000,
  });
  const parse = <A>(read: () => A) =>
    Effect.try({ try: read, catch: () => new BoatFinalCloseError("held") });
  /** A removal's failure, as this close reports one. */
  const removalError = (error: BoatRemovalError) => new BoatFinalCloseError(error.code);
  const current = (target: BoatExecutionTarget) =>
    Effect.gen(function* () {
      const allocation = yield* allocations.get(target.runtimeInstanceId);
      const instance = yield* runtimes.getRuntimeInstanceByRunId(target.runId);
      if (
        allocation === undefined ||
        !(
          allocation.phase === "bound" ||
          // Its deletion operation is recorded on the allocation, which is `deleting` from then on.
          (allocation.phase === "deleting" && allocation.removal?.kind === "operation")
        ) ||
        !isDeepStrictEqual(allocation.target, target) ||
        target.deploymentId !== host.deploymentId ||
        instance?.adapter !== "boat" ||
        instance.resourceId !== target.sandboxId ||
        instance.stopReason === null
      )
        return yield* Effect.fail(new BoatFinalCloseError("held"));
      const reservation = yield* tunnels.get(target.runtimeInstanceId);
      // Launched without resources: read from the allocation, where the launch froze it.
      if (allocation.input.resources === "none") {
        // It was never given a tunnel. A reservation recorded for it is not this close's to settle.
        if (reservation !== undefined) return yield* Effect.fail(new BoatFinalCloseError("held"));
        return { allocation, reservation: undefined, stopReason: instance.stopReason };
      }
      if (
        reservation === undefined ||
        // A deployment with no resource gateway cannot settle a tunnel: the run is held.
        host.gateway === undefined ||
        !isDeepStrictEqual(reservation.binding, { target, gatewayHostId: host.gateway.hostId })
      )
        return yield* Effect.fail(new BoatFinalCloseError("held"));
      return { allocation, reservation, stopReason: instance.stopReason };
    });
  /** The exact owned VM, read through the observer: the one source of presence. */
  const present = (target: BoatExecutionTarget) =>
    Effect.gen(function* () {
      const allocation = yield* allocations.get(target.runtimeInstanceId);
      if (allocation === undefined || !isDeepStrictEqual(allocation.target, target))
        return yield* Effect.fail(new BoatFinalCloseError("held"));
      const presence = yield* observer.observe(allocation).pipe(Effect.mapError(observeError));
      if (presence.kind === "present")
        return yield* parse(() => boatSandboxIdSchema.parse(presence.sandbox.id));
      // Absent: the next pass discharges it. Foreign labels: never touched. Otherwise unknown.
      return yield* Effect.fail(
        new BoatFinalCloseError(
          presence.kind === "unknown" && presence.reason === "foreign" ? "held" : "unavailable",
        ),
      );
    });
  /** Boat no longer has the VM: every obligation is discharged against that observation alone. */
  const dischargeAbsent = (allocation: BoatAllocationRecord) =>
    discharger
      .discharge(allocation)
      .pipe(
        Effect.flatMap((outcome) =>
          outcome.kind === "discharged"
            ? Effect.succeed("closed" as const)
            : outcome.kind === "pending"
              ? Effect.succeed("pending" as const)
              : Effect.fail(new BoatFinalCloseError("held")),
        ),
      );
  /** Boat's own deletion operation for this VM completed. */
  const finish = Effect.fn("BoatFinalClose.finish")(function* (target: BoatExecutionTarget) {
    const run = yield* current(target);
    if (recordedOf(run)?.completed !== true)
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    const { allocation } = run;
    yield* observer
      .deletionCompleted(allocation, target.sandboxId)
      .pipe(Effect.mapError(observeError));
    return yield* dischargeAbsent(allocation);
  });
  const close = Effect.fn("BoatFinalClose.close")(function* (target: BoatExecutionTarget) {
    const stored = yield* allocations.get(target.runtimeInstanceId);
    if (stored === undefined || !isDeepStrictEqual(stored.target, target))
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    // Observe first: a VM Boat no longer has needs no guest, no FINAL and no DELETE to end.
    const presence = yield* observer.observe(stored).pipe(Effect.mapError(observeError));
    const state = yield* exchanges.get(target.runtimeInstanceId);
    const preIssue =
      state === undefined || ["exchange", "control", "installed", "aborted"].includes(state.phase);
    if (presence.kind === "absent") {
      // Fence any launch still racing toward start, then settle on absence alone.
      if (preIssue) yield* exchanges.abort(target);
      return yield* dischargeAbsent(stored);
    }
    if (preIssue) return yield* closeUnused(target.runId, target.sandboxId, target, presence);
    const run = yield* current(target);
    const root = yield* canonical.getByRunId(target.runId);
    if (root?.deletionState === "deleted") return yield* finish(target);
    if (recordedOf(run) !== undefined) {
      // DELETE was accepted earlier, by this worker or one before it: the removal polls its
      // operation and sends nothing. The observation above is the one it decides on.
      const outcome = yield* removal
        .deletion(run.allocation, { fence: false, presence })
        .pipe(Effect.mapError(removalError));
      if (outcome === "deleting") return "pending" as const;
      if (root?.deletionState === "deleting-issued" && root.deletionToken !== null)
        yield* canonical.completeDeletion({ runId: target.runId, token: root.deletionToken });
      return yield* finish(target);
    }
    // A positively running invocation already has an immutable guest record. Delayed start replays
    // only adopt it; they cannot create another invocation after this FINAL.
    yield* execution.hold(target);
    const closeId = run.reservation?.closeId ?? randomUUID();
    const freezeBy = (yield* Clock.currentTimeMillis) + BOAT_CLOSE_FREEZE.waitMs;
    for (;;) {
      const held = (yield* current(target)).reservation;
      // A run without resources has no gateway to fence: the held execution is its fence.
      if (held === undefined) break;
      const frozen = yield* Effect.result(tunnels.freeze(held, closeId));
      if (Result.isSuccess(frozen)) break;
      // `operation-held` is the host lock, taken by a configuration at its gateway mutation. Only
      // this close waits, and it lets nothing through meanwhile: the execution is held and the
      // stop recorded, and a configuration reads both before it dispatches, again under the lock.
      // The reservation is read again each try, since the mutation that held the lock settled its
      // update on it. Every other failure, and the lock still held at the bound, fails as before.
      if (frozen.failure.code !== "operation-held" || (yield* Clock.currentTimeMillis) >= freezeBy)
        return yield* Effect.fail(frozen.failure);
      yield* Effect.sleep(BOAT_CLOSE_FREEZE.pollMs);
    }
    // The owner discarded the unsaved work, or Mend attested a sealed FINAL of this executor: no
    // guest needs to answer before its VM is removed (audit S8).
    const instance = yield* runtimes.getRuntimeInstanceByRunId(target.runId);
    const executor = {
      runId: target.runId,
      resourceId: instance?.resourceId ?? target.sandboxId,
      reference: instance?.reference ?? null,
    };
    const evidence = recordedDeletionEvidence(yield* ledger.read(target.runId), executor);
    const decided = evidence.discarded || evidence.attestedComplete;
    // The agent's word that nothing ran on the VM, so nothing is lost by removing it: the daemon
    // never materialized a capture (sealantd exit 76, `daemon`) or never started on this boot
    // (`no-launch`). Typed by the agent, never inferred; the basis names which.
    let nothingToSave: "nothing-to-save" | "never-launched" | null = null;
    if (root?.deletionState !== "deleting-issued" && !decided) {
      // The agent's typed refusals (another boot, a parked disk, an agent that did not launch
      // this boot) are definite answers: the capture cannot be recovered here, the VM is kept.
      const available = yield* execution
        .recover(target)
        .pipe(
          Effect.catch((error) =>
            error instanceof BoatExecutionError && error.code === "agent-refused"
              ? Effect.logWarning(
                  `Boat FINAL close · run ${target.runId}: the agent refused the recovery (${error.diagnostic?.agent?.reason ?? "unknown"}); the VM is retained.`,
                ).pipe(Effect.as("held" as const))
              : Effect.fail(error),
          ),
        );
      if (typeof available === "object") {
        nothingToSave = available.basis === "no-launch" ? "never-launched" : "nothing-to-save";
        yield* Effect.logInfo(
          `Boat FINAL close · run ${target.runId}: ${describeDeletionBasis(nothingToSave)}${available.detail === undefined ? "" : ` (${available.detail})`}.`,
        );
      } else if (available !== "running") return "retained" as const;
    }
    if (root?.deletionState !== "deleting-issued" && !decided && nothingToSave === null) {
      const control = yield* execution.control(target);
      const outcome = yield* drainCaptureBeforeStop({
        runId: target.runId,
        target: Redacted.value(control),
        ledger,
        settings: DEFAULT_CAPTURE_DRAIN_SETTINGS,
        budgetMs: 60_000,
        label: "Boat FINAL close",
        runtimeState: Effect.succeed("running"),
      }).pipe(Effect.provideService(SealantRuntime, runtime));
      if (outcome.kind !== "drained") return "retained" as const;
    }
    // Absence and a timeout are never completion. A previous unknown DELETE may be retried only
    // after a fresh positive observation of this exact owned sandbox and unchanged FINAL evidence.
    yield* present(target);
    const deletion = yield* authorizedDeletion({
      ledger,
      runId: target.runId,
      runtime: "running",
      decide: (entry) => {
        const now = recordedDeletionEvidence(entry, executor);
        return now.discarded
          ? { delete: true, basis: "discarded" }
          : now.attestedComplete
            ? { delete: true, basis: "attested-complete" }
            : nothingToSave !== null
              ? { delete: true, basis: nothingToSave }
              : complete(entry)
                ? { delete: true, basis: "observed-complete" }
                : { delete: false, reason: "FINAL evidence changed" };
      },
    });
    // Evidence-based removals hold a ticket; the owner's discard and the daemon's nothing-to-save
    // rest on no recorded evidence a later observation could revoke.
    if (
      !deletion.decision.delete ||
      (deletion.ticket === undefined &&
        deletion.decision.basis !== "discarded" &&
        deletion.decision.basis !== "nothing-to-save" &&
        deletion.decision.basis !== "never-launched")
    )
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    const removed = yield* removeUnderDeletion({
      ledger,
      runId: target.runId,
      ticket: deletion.ticket,
      remove: Effect.gen(function* () {
        // The run was held and its tunnel frozen above, before its drain: the removal verifies
        // that, reads the exact owned VM once more, sends DELETE and records the operation on the
        // allocation before it waits.
        const { allocation } = yield* current(target);
        const outcome = yield* removal
          .deletion(allocation, { fence: false })
          .pipe(Effect.mapError(removalError));
        // Absent here is a VM that vanished since the read above: the next pass discharges it.
        if (outcome !== "completed")
          return yield* Effect.fail(
            new BoatFinalCloseError(outcome === "deleting" ? "pending" : "unavailable"),
          );
      }),
    });
    if (!removed.removed) return yield* Effect.fail(new BoatFinalCloseError("held"));
    return yield* finish(target);
  });
  const boundedClose = (target: BoatExecutionTarget) =>
    close(target).pipe(
      Effect.timeout(120_000),
      Effect.mapError((error) =>
        error instanceof BoatFinalCloseError ? error : new BoatFinalCloseError("unavailable"),
      ),
    );
  const closeUnused = Effect.fn("BoatFinalClose.closeUnused")(function* (
    runId: string,
    sandboxId: string,
    target: BoatExecutionTarget | null = null,
    /** What the close that came here just read of the VM, so a recorded operation's poll reads no more. */
    observed?: BoatPresence,
  ) {
    let allocation = yield* allocations.get(runId);
    const instance = yield* runtimes.getRuntimeInstanceByRunId(runId);
    if (
      allocation === undefined ||
      !isDeepStrictEqual(allocation.target, target) ||
      !(
        target === null
          ? ["allocated", "held", "deleting", "deleted"]
          : ["bound", "deleting", "deleted"]
      ).includes(allocation.phase) ||
      allocation.input.deploymentId !== host.deploymentId ||
      allocation.sandboxId !== sandboxId ||
      instance?.adapter !== "boat" ||
      instance.resourceId !== sandboxId ||
      instance.publicationId !== allocation.input.publication.publicationId ||
      (instance.stopReason === null && instance.status !== "failed")
    )
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    // A pre-launch capture-token row is normal. Unbound guests cannot own an exchange or tunnel.
    if (
      target === null &&
      ((yield* exchanges.get(runId)) !== undefined || (yield* tunnels.get(runId)) !== undefined)
    )
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    // The aborted row is a durable fence against reserve, exchange, stage and installed -> issued.
    // Issued/running/held executions refuse this path, even if readiness never succeeded.
    if (target !== null) yield* exchanges.abort(target);
    let reservation = yield* tunnels.get(runId);
    if (reservation !== undefined) {
      if (
        target === null ||
        host.gateway === undefined ||
        !isDeepStrictEqual(reservation.binding, { target, gatewayHostId: host.gateway.hostId })
      )
        return yield* Effect.fail(new BoatFinalCloseError("held"));
      reservation = yield* tunnels.freeze(reservation, reservation.closeId ?? randomUUID());
    }
    // A failed launch may predate the stop worker. Recording stop also prevents future issuance.
    if (instance.stopReason === null)
      yield* runtimes.markStopRequested({ runId, stopReason: "user" });
    const stopped = yield* runtimes.getRuntimeInstanceByRunId(runId);
    if (stopped?.stopReason == null) return yield* Effect.fail(new BoatFinalCloseError("held"));
    const finishUnused = (terminal: BoatAllocationRecord) =>
      Effect.gen(function* () {
        if (terminal.phase !== "deleted" || terminal.removal?.kind === "issued")
          return yield* Effect.fail(new BoatFinalCloseError("held"));
        // A deletion finished before observations existed carries its own completed receipt.
        if (
          (yield* observer.observe(terminal).pipe(Effect.mapError(observeError))).kind !== "absent"
        )
          yield* observer
            .deletionCompleted(terminal, sandboxId)
            .pipe(Effect.mapError(observeError));
        return yield* dischargeAbsent(terminal);
      });
    if (allocation.phase === "deleted") return yield* finishUnused(allocation);
    const now = yield* Clock.currentTimeMillis;
    let claimed = false;
    if (allocation.phase !== "deleting") {
      allocation = yield* allocations.advance(allocation, {
        ...allocation,
        phase: "deleting",
        reason: null,
        removal: { kind: "issued", token: randomUUID(), at: new Date(now).toISOString() },
      });
      claimed = true;
    }
    // This close fenced the VM above (its exchange aborted, its tunnel frozen, its allocation
    // claimed) and holds what lets a never-launched VM go: the removal sends DELETE, or polls the
    // operation an earlier DELETE was answered with, records it, and discharges on `completed`.
    const remove = (fenced: BoatAllocationRecord, presence: BoatPresence | undefined) =>
      removal
        .remove(fenced, { fence: false, ...(presence === undefined ? {} : { presence }) })
        .pipe(
          Effect.mapError(removalError),
          Effect.map((outcome) =>
            outcome === "removed" ? ("closed" as const) : ("pending" as const),
          ),
        );
    // A recorded deletion operation is Boat's own account of this removal: it decides first. A VM
    // never seen created reads 404 as `creating`, so presence alone could hold it forever.
    if (allocation.removal?.kind === "operation") return yield* remove(allocation, observed);
    const id = yield* parse(() => boatSandboxIdSchema.parse(sandboxId));
    // Absence is what Boat says, never what a timeout or a fresh create's 404 suggests.
    const presence = yield* observer.observe(allocation).pipe(Effect.mapError(observeError));
    if (presence.kind === "absent") {
      allocation = yield* allocations.advance(allocation, {
        ...allocation,
        phase: "deleted",
        removal: { kind: "absent", targetId: id, completed: true },
      });
      return yield* finishUnused(allocation);
    }
    if (presence.kind === "unknown")
      return presence.reason === "foreign"
        ? yield* Effect.fail(new BoatFinalCloseError("held"))
        : presence.reason === "creating"
          ? ("pending" as const)
          : yield* Effect.fail(new BoatFinalCloseError("unavailable"));
    if (allocation.removal?.kind !== "issued")
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    // Unknown DELETE retains a bounded lease. Accepted operations are polled, never reissued.
    if (!claimed && now - Date.parse(allocation.removal.at) < 180_000) return "pending" as const;
    if (!claimed)
      allocation = yield* allocations.advance(allocation, {
        ...allocation,
        removal: { kind: "issued", token: randomUUID(), at: new Date(now).toISOString() },
      });
    return yield* remove(allocation, presence);
  });
  const boundedUnbound = (runId: string, sandboxId: string) =>
    closeUnused(runId, sandboxId).pipe(
      Effect.timeout(120_000),
      Effect.mapError((error) =>
        error instanceof BoatFinalCloseError ? error : new BoatFinalCloseError("unavailable"),
      ),
    );
  /**
   * The one owner of a launch's VM from creation through cleanup. Each pass looks at desired state
   * and at what Boat last said, never at the launch's error history: an absent VM is discharged; a
   * VM whose run should stop (a stop, or a launch that failed and so will never be ready) is
   * closed; a ready VM is observed, so a VM deleted or lost outside Core ends its execution.
   */
  const step = Effect.fn("BoatFinalClose.step")(function* (id: string) {
    const allocation = yield* allocations.get(id);
    if (allocation === undefined || allocation.input.deploymentId !== host.deploymentId)
      return "skipped" as const;
    const runId = allocation.input.consumer.runId;
    const observed = yield* observations.get(id).pipe(Effect.mapError(observeError));
    if (observed?.presence === "absent") return yield* dischargeAbsent(allocation);
    if (allocation.sandboxId === null) {
      if (allocation.phase === "held" && allocation.reason === "create-unresolved") {
        // Nobody can say whether Boat holds a VM for this launch; discovery keeps looking and
        // adopts one if it appears. The owner's discard is the person's exit: the session ends
        // with its work reported discarded, while the allocation and its pin stay held.
        const root = yield* canonical.getByRunId(runId);
        if (root?.discardRequestedAt != null) {
          yield* runtimes.markStopped({ runId, stopReason: "user" });
          if (root.state !== "discarded")
            yield* canonical.recordObservation({
              runId,
              state: "discarded",
              detail:
                "The owner discarded this launch while Boat could not say whether its create made a VM.",
            });
        }
        yield* Effect.logWarning(
          `Boat lifecycle · run ${runId}: create was issued more than Boat's key retention ago and no VM carries its labels; it is held for an operator until a VM is found or the owner discards it.`,
        );
        return "held" as const;
      }
      // Stopped before create was ever issued: Boat was never asked for a VM.
      if (allocation.phase !== "held" || allocation.reason !== "run-stopped")
        return "skipped" as const;
      yield* observer.neverCreated(allocation).pipe(Effect.mapError(observeError));
      const terminal = yield* allocations.advance(allocation, {
        ...allocation,
        phase: "deleted",
        reason: null,
        removal: { kind: "never-created", completed: true },
      });
      return yield* dischargeAbsent(terminal);
    }
    if (allocation.phase === "deleted") return "skipped" as const;
    let instance = yield* runtimes.getRuntimeInstanceByRunId(runId);
    if (instance?.adapter !== "boat") return "skipped" as const;
    // A live launch owns its allocation and VM until it finishes or its lease lapses. An explicit
    // stop reaches it through the stop worker; this sweep adopts only what no launch owns.
    if (yield* allocations.launchInFlight(id)) return "skipped" as const;
    if (instance.status === "pending" && instance.stopReason === null) {
      // The launch's worker is gone (its ownership lapsed): nothing will finish it, so the launch
      // failed. Adoption is atomic with the lapse check; a live launch keeps its row. A pending
      // launch whose stop was requested is closed below whatever became of its worker.
      if (instance.resourceId === null)
        yield* runtimes.identifyStrandedLaunch({
          runId,
          adapter: "boat",
          resourceId: allocation.sandboxId,
          reference: runId,
          unownedGraceMs: DEFAULT_UNOWNED_LAUNCH_GRACE_MS,
        });
      const adopted = yield* runtimes.adoptStrandedLaunch({
        runId,
        unownedGraceMs: DEFAULT_UNOWNED_LAUNCH_GRACE_MS,
        errorMessage: `The Boat VM ${allocation.sandboxId} was created and the worker launching it was lost before the launch finished.`,
      });
      if (adopted === undefined) return "skipped" as const;
      yield* attempts.markAttemptFailed({ id: runId });
      instance = adopted;
    }
    if (instance.stopReason === null && instance.status !== "failed") {
      if (instance.status !== "ready") return "skipped" as const;
      const now = yield* Clock.currentTimeMillis;
      if (observed !== undefined && now - observed.observedAt.getTime() < READY_OBSERVATION_MS)
        return "skipped" as const;
      const presence = yield* observer.observe(allocation).pipe(Effect.mapError(observeError));
      return presence.kind === "absent" ? yield* dischargeAbsent(allocation) : ("skipped" as const);
    }
    // A failed launch will never become ready: its desired state is stopped.
    if (instance.stopReason === null)
      yield* runtimes.markStopRequested({ runId, stopReason: "failed" });
    return allocation.target === null
      ? yield* boundedUnbound(id, allocation.sandboxId)
      : yield* boundedClose(allocation.target);
  });
  const reconcile = Effect.fn("BoatFinalClose.reconcile")(function* (
    input: Parameters<BoatFinalClose["Service"]["reconcile"]>[0],
  ) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    // Pins with no allocation are no VM's to discharge; release the ones whose run is over.
    yield* discharger.releaseEndedPins({ limit: 20 });
    const ids = yield* allocations.list({ deploymentId: host.deploymentId, ...input });
    const entries = yield* Effect.forEach(
      ids,
      (id) =>
        Effect.gen(function* () {
          const outcome = yield* step(id);
          return { runId: id, outcome };
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              runId: id,
              outcome:
                error instanceof BoatFinalCloseError && error.code === "held"
                  ? ("held" as const)
                  : ("unavailable" as const),
            }),
          ),
        ),
      { concurrency: 4 },
    );
    const last = ids.at(-1);
    return { entries, ...(ids.length === input.limit && last !== undefined ? { next: last } : {}) };
  });
  return BoatFinalClose.of({
    close: boundedClose,
    closeUnbound: boundedUnbound,
    reconcile: (input) =>
      reconcile(input).pipe(
        Effect.mapError((error) =>
          error instanceof BoatFinalCloseError ? error : new BoatFinalCloseError("unavailable"),
        ),
      ),
  });
});
/** Open assembly for tests with faithful capture control and provider transports. */
export const boatFinalCloseLayerNoDeps: Layer.Layer<
  BoatFinalClose,
  never,
  | SealantDB
  | BoatObservationRepo
  | BoatDischarge
  | WorkspaceAttemptRepo
  | BoatAllocationRepo
  | BoatExecutionRepo
  | BoatTunnelRepo
  | WorkspaceCaptureDrainRepo
  | WorkspaceRuntimeInstanceRepo
  | BoatExecution
  | BoatResourcesHost
  | BoatRemoval
  | BoatObserver
  | SealantRuntime
> = Layer.effect(BoatFinalClose, make);
/** Reuses the canonical capture owner and the existing sealed execution. */
export const boatFinalCloseLayer: Layer.Layer<
  BoatFinalClose,
  never,
  SealantDB | BoatExecution | BoatResourcesHost | BoatRemovalProvider | BoatAllocationProvider
> = boatFinalCloseLayerNoDeps.pipe(
  Layer.provide(
    Layer.mergeAll(
      boatRemovalLayer,
      boatObserverLayer,
      boatDischargeLayer,
      BoatObservationRepoLive,
      WorkspaceAttemptRepoLive,
      BoatAllocationRepoLive,
      BoatExecutionRepoLive,
      boatTunnelRepoLayer,
      WorkspaceCaptureDrainRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
      SealantRuntimeControlLive,
    ),
  ),
);
