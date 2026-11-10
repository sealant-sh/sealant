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
import { Clock, Context, Effect, Layer, Redacted, Ref } from "effect";

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
import type { BoatApi, BoatDeletion } from "./api.js";
import { boatSandboxIdSchema, boatDeletionIdSchema, type BoatResult } from "./config.js";
import { BoatDischarge, boatDischargeLayer } from "./discharge.js";
import { BoatExecution, BoatExecutionError } from "./execution.js";
import { BoatObserver, boatObserverLayer } from "./observation.js";
import { BoatAllocationProvider } from "./provider.js";

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
/** The root supplies the allocation account; this service never discovers credentials. */
export class BoatFinalCloseProvider extends Context.Service<
  BoatFinalCloseProvider,
  {
    readonly api: Pick<BoatApi, "get" | "deleteSandbox" | "getDeletion">;
    /**
     * How long one close waits for Boat's deletion operation to complete, so the removal is
     * recorded by the close that issued it rather than a later sweep. Default 20 s.
     */
    readonly deletionWaitMs?: number;
  }
>()("@sealant/workspaces/boat/BoatFinalCloseProvider") {}

const DELETION_WAIT_MS = 20_000;
const DELETION_POLL_MS = 1_000;

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
  | BoatFinalCloseProvider
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
  const provider = yield* BoatFinalCloseProvider;
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
  const call = <A>(request: () => Promise<BoatResult<A>>) =>
    Effect.tryPromise({
      try: request,
      catch: () => new BoatFinalCloseError("unavailable"),
    }).pipe(
      Effect.flatMap((result) =>
        result.ok
          ? Effect.succeed(result.value)
          : Effect.fail(new BoatFinalCloseError("unavailable")),
      ),
    );
  const current = (target: BoatExecutionTarget) =>
    Effect.gen(function* () {
      const allocation = yield* allocations.get(target.runtimeInstanceId);
      const instance = yield* runtimes.getRuntimeInstanceByRunId(target.runId);
      if (
        allocation?.phase !== "bound" ||
        !isDeepStrictEqual(allocation.target, target) ||
        target.deploymentId !== host.deploymentId ||
        instance?.adapter !== "boat" ||
        instance.resourceId !== target.sandboxId ||
        instance.stopReason === null
      )
        return yield* Effect.fail(new BoatFinalCloseError("held"));
      const reservation = yield* tunnels.get(target.runtimeInstanceId);
      if (
        reservation === undefined ||
        !isDeepStrictEqual(reservation.binding, { target, gatewayHostId: host.gatewayHostId })
      )
        return yield* Effect.fail(new BoatFinalCloseError("held"));
      return { reservation, stopReason: instance.stopReason };
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
  /**
   * Polls Boat's own deletion operation until it completes or the wait is spent. The wait bounds
   * the whole loop, including a read still in flight, so a slow provider cannot stretch one close.
   */
  const awaitDeletion = (operation: BoatDeletion) =>
    Effect.gen(function* () {
      const latest = yield* Ref.make(operation);
      const poll = Effect.gen(function* () {
        while ((yield* Ref.get(latest)).status !== "completed") {
          yield* Effect.sleep(DELETION_POLL_MS);
          const next = yield* call(() => provider.api.getDeletion(operation.id));
          if (
            next.id !== operation.id ||
            next.kind !== "sandbox" ||
            next.targetId !== operation.targetId
          )
            return yield* Effect.fail(new BoatFinalCloseError("held"));
          yield* Ref.set(latest, next);
        }
      });
      yield* poll.pipe(Effect.timeoutOption(provider.deletionWaitMs ?? DELETION_WAIT_MS));
      return yield* Ref.get(latest);
    });
  const record = (reservation: BoatTunnelReservation, operation: BoatDeletion) =>
    Effect.gen(function* () {
      if (
        operation.kind !== "sandbox" ||
        operation.targetId !== reservation.binding.target.sandboxId
      )
        return yield* Effect.fail(new BoatFinalCloseError("held"));
      return yield* tunnels.recordRemoval(reservation, {
        id: operation.id,
        targetId: operation.targetId,
        completed: operation.status === "completed",
      });
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
    const { reservation } = yield* current(target);
    if (reservation.removal?.completed !== true)
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    const allocation = yield* allocations.get(target.runtimeInstanceId);
    if (allocation === undefined) return yield* Effect.fail(new BoatFinalCloseError("held"));
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
    if (preIssue) return yield* closeUnused(target.runId, target.sandboxId, target);
    let { reservation } = yield* current(target);
    const root = yield* canonical.getByRunId(target.runId);
    if (root?.deletionState === "deleted") return yield* finish(target);
    if (reservation.removal !== undefined) {
      const id = yield* parse(() => boatDeletionIdSchema.parse(reservation.removal?.id));
      const operation = yield* call(() => provider.api.getDeletion(id));
      reservation = yield* record(reservation, operation);
      if (reservation.removal?.completed !== true)
        reservation = yield* record(reservation, yield* awaitDeletion(operation));
      if (reservation.removal?.completed !== true) return "pending" as const;
      if (root?.deletionState === "deleting-issued" && root.deletionToken !== null)
        yield* canonical.completeDeletion({ runId: target.runId, token: root.deletionToken });
      return yield* finish(target);
    }
    // A positively running invocation already has an immutable guest record. Delayed start replays
    // only adopt it; they cannot create another invocation after this FINAL.
    yield* execution.hold(target);
    reservation = yield* tunnels.freeze(
      (yield* current(target)).reservation,
      reservation.closeId ?? randomUUID(),
    );
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
        yield* current(target);
        const id = yield* present(target);
        const operation = yield* call(() => provider.api.deleteSandbox(id));
        // The operation id is recorded before waiting, so a crash mid-wait polls it later.
        reservation = yield* record(reservation, operation);
        if (reservation.removal?.completed !== true)
          reservation = yield* record(reservation, yield* awaitDeletion(operation));
        if (reservation.removal?.completed !== true)
          return yield* Effect.fail(new BoatFinalCloseError("pending"));
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
        !isDeepStrictEqual(reservation.binding, { target, gatewayHostId: host.gatewayHostId })
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
    const id = yield* parse(() => boatSandboxIdSchema.parse(sandboxId));
    // A recorded deletion operation is Boat's own account of this removal: it decides first. A VM
    // never seen created reads 404 as `creating`, so presence alone could hold it forever.
    if (allocation.removal?.kind === "operation") {
      const operationId = yield* parse(() =>
        boatDeletionIdSchema.parse(
          allocation?.removal?.kind === "operation" ? allocation.removal.id : undefined,
        ),
      );
      const recorded = yield* call(() => provider.api.getDeletion(operationId));
      if (
        recorded.kind !== "sandbox" ||
        recorded.targetId !== id ||
        recorded.id !== allocation.removal.id
      )
        return yield* Effect.fail(new BoatFinalCloseError("held"));
      const settled = yield* awaitDeletion(recorded);
      if (settled.status !== "completed") return "pending" as const;
      allocation = yield* allocations.advance(allocation, {
        ...allocation,
        phase: "deleted",
        removal: { kind: "operation", id: settled.id, targetId: id, completed: true },
      });
      yield* observer.deletionCompleted(allocation, id).pipe(Effect.mapError(observeError));
      return yield* finishUnused(allocation);
    }
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
    const operation = yield* call(() => provider.api.deleteSandbox(id));
    if (operation.kind !== "sandbox" || operation.targetId !== id)
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    allocation = yield* allocations.advance(allocation, {
      ...allocation,
      phase: operation.status === "completed" ? "deleted" : "deleting",
      removal: {
        kind: "operation",
        id: operation.id,
        targetId: id,
        completed: operation.status === "completed",
      },
    });
    if (allocation.phase !== "deleted") {
      // The operation is recorded; wait for Boat to finish it so this close records the removal.
      const settled = yield* awaitDeletion(operation);
      if (settled.status !== "completed") return "pending" as const;
      allocation = yield* allocations.advance(allocation, {
        ...allocation,
        phase: "deleted",
        removal: { kind: "operation", id: settled.id, targetId: id, completed: true },
      });
    }
    yield* observer.deletionCompleted(allocation, id).pipe(Effect.mapError(observeError));
    return yield* finishUnused(allocation);
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
  | BoatFinalCloseProvider
  | BoatObserver
  | SealantRuntime
> = Layer.effect(BoatFinalClose, make);
/** Reuses the canonical capture owner and the existing sealed execution. */
export const boatFinalCloseLayer: Layer.Layer<
  BoatFinalClose,
  never,
  SealantDB | BoatExecution | BoatResourcesHost | BoatFinalCloseProvider | BoatAllocationProvider
> = boatFinalCloseLayerNoDeps.pipe(
  Layer.provide(
    Layer.mergeAll(
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
