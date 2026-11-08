import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  NativePublicationRepo,
  NativePublicationRepoLive,
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  SealantDB,
} from "@sealant/db";
import {
  nativeArtifactConsumerSchema,
  type BoatExecutionTarget,
  type BoatTunnelReservation,
  type BoatAllocationRecord,
} from "@sealant/validators";
import { Clock, Context, Effect, Layer, Redacted } from "effect";

import { SealantRuntime, SealantRuntimeControlLive } from "../../sealantd/runtime.js";
import { BoatResourcesHost } from "../../worker/boat-resources.js";
import { databaseCaptureDrainLedger } from "../../worker/capture-drain-ledger.js";
import {
  authorizedDeletion,
  DEFAULT_CAPTURE_DRAIN_SETTINGS,
  drainCaptureBeforeStop,
  observedComplete,
  removeUnderDeletion,
  type CaptureDrainRead,
} from "../../worker/capture-drain.js";
import type { BoatApi, BoatDeletion } from "./api.js";
import { boatSandboxIdSchema, boatDeletionIdSchema, type BoatResult } from "./config.js";
import { BoatExecution } from "./execution.js";

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
/** FINAL close and original-boot capture recovery. Enrolled parking uses its incarnation owner. */
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
  }
>()("@sealant/workspaces/boat/BoatFinalCloseProvider") {}

const complete = (record: CaptureDrainRead) =>
  record.readable &&
  record.entry?.preservationManaged !== true &&
  record.entry?.lastUnreadable !== true &&
  (record.entry?.observationsInFlight ?? 0) === 0 &&
  observedComplete(record.entry);

const make: Effect.Effect<
  BoatFinalClose["Service"],
  never,
  | SealantDB
  | NativePublicationRepo
  | BoatAllocationRepo
  | BoatExecutionRepo
  | BoatTunnelRepo
  | WorkspaceCaptureDrainRepo
  | WorkspaceRuntimeInstanceRepo
  | BoatExecution
  | BoatResourcesHost
  | BoatFinalCloseProvider
  | SealantRuntime
> = Effect.gen(function* () {
  const db = yield* SealantDB;
  const allocations = yield* BoatAllocationRepo;
  const exchanges = yield* BoatExecutionRepo;
  const catalog = yield* NativePublicationRepo;
  const tunnels = yield* BoatTunnelRepo;
  const canonical = yield* WorkspaceCaptureDrainRepo;
  const runtimes = yield* WorkspaceRuntimeInstanceRepo;
  const execution = yield* BoatExecution;
  const host = yield* BoatResourcesHost;
  const provider = yield* BoatFinalCloseProvider;
  const runtime = yield* SealantRuntime;
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
  const present = (target: BoatExecutionTarget) =>
    Effect.gen(function* () {
      const id = yield* parse(() => boatSandboxIdSchema.parse(target.sandboxId));
      const sandbox = yield* call(() => provider.api.get(id));
      const labels = {
        "sealant-runtime": "boat",
        "sealant-deployment": target.deploymentId,
        "sealant-workspace": target.workspaceId,
        "sealant-run": target.runId,
        "sealant-instance": target.runtimeInstanceId,
        "sealant-attempt": target.launchAttemptId,
        "sealant-source": target.sourceId,
      };
      if (
        sandbox.id !== id ||
        !Object.entries(labels).every(([key, value]) => sandbox.labels?.[key] === value)
      )
        return yield* Effect.fail(new BoatFinalCloseError("held"));
      return id;
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
  const finish = Effect.fn("BoatFinalClose.finish")(function* (target: BoatExecutionTarget) {
    const { reservation, stopReason } = yield* current(target);
    const root = yield* canonical.getByRunId(target.runId);
    if (root?.deletionState !== "deleted" || reservation.removal?.completed !== true)
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    yield* execution.hold(target);
    if (reservation.released !== true) {
      yield* host.tunnel.remove(target);
      yield* tunnels.release((yield* current(target)).reservation);
    }
    yield* runtimes.markStopped({ runId: target.runId, stopReason });
    yield* runtimes.markRemoved({ runId: target.runId, resourceId: target.sandboxId });
    yield* catalog.release(
      nativeArtifactConsumerSchema.parse({
        runId: target.runId,
        runtimeInstanceId: target.runtimeInstanceId,
      }),
      target.sourceId,
    );
    return "closed" as const;
  });
  const close = Effect.fn("BoatFinalClose.close")(function* (target: BoatExecutionTarget) {
    const stored = yield* allocations.get(target.runtimeInstanceId);
    const state = yield* exchanges.get(target.runtimeInstanceId);
    if (
      stored !== undefined &&
      isDeepStrictEqual(stored.target, target) &&
      (state === undefined ||
        ["exchange", "control", "prepared", "installed", "aborted"].includes(state.phase))
    )
      return yield* closeUnused(target.runId, target.sandboxId, target);
    let { reservation } = yield* current(target);
    const root = yield* canonical.getByRunId(target.runId);
    if (root?.custodyContract === 3) return yield* Effect.fail(new BoatFinalCloseError("held"));
    if (root?.deletionState === "deleted") return yield* finish(target);
    if (reservation.removal !== undefined) {
      const id = yield* parse(() => boatDeletionIdSchema.parse(reservation.removal?.id));
      reservation = yield* record(reservation, yield* call(() => provider.api.getDeletion(id)));
      if (reservation.removal?.completed !== true) return "pending" as const;
      if (root?.deletionState !== "deleting-issued" || root.deletionToken === null)
        return yield* Effect.fail(new BoatFinalCloseError("held"));
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
    if (root?.deletionState !== "deleting-issued") {
      const available = yield* execution.recover(target);
      if (available !== "running") return "retained" as const;
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
      decide: (entry) =>
        complete(entry)
          ? { delete: true, basis: "observed-complete" }
          : { delete: false, reason: "FINAL evidence changed" },
    });
    if (deletion.ticket === undefined) return yield* Effect.fail(new BoatFinalCloseError("held"));
    const removed = yield* removeUnderDeletion({
      ledger,
      runId: target.runId,
      ticket: deletion.ticket,
      remove: Effect.gen(function* () {
        yield* current(target);
        const id = yield* present(target);
        reservation = yield* record(reservation, yield* call(() => provider.api.deleteSandbox(id)));
        if (reservation.removal?.completed !== true) {
          const operationId = yield* parse(() =>
            boatDeletionIdSchema.parse(reservation.removal?.id),
          );
          reservation = yield* record(
            reservation,
            yield* call(() => provider.api.getDeletion(operationId)),
          );
        }
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
    // Snapshot parking always retains its independent custody contract.
    const root = yield* canonical.getByRunId(runId);
    if (
      (target === null &&
        ((yield* exchanges.get(runId)) !== undefined ||
          (yield* tunnels.get(runId)) !== undefined)) ||
      root?.custodyContract === 3
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
    const stopReason = stopped.stopReason;
    const finishUnused = (terminal: BoatAllocationRecord) =>
      Effect.gen(function* () {
        if (terminal.phase !== "deleted")
          return yield* Effect.fail(new BoatFinalCloseError("held"));
        if (reservation !== undefined && reservation.released !== true) {
          if (target === null) return yield* Effect.fail(new BoatFinalCloseError("held"));
          yield* host.tunnel.remove(target);
          yield* tunnels.releaseAborted(reservation);
        }
        yield* runtimes.markStopped({ runId, stopReason });
        yield* runtimes.markRemoved({ runId, resourceId: sandboxId });
        yield* catalog.release(terminal.input.consumer, terminal.input.publication.publicationId);
        return "closed" as const;
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
    const observation = yield* Effect.tryPromise({
      try: () => provider.api.get(id),
      catch: () => new BoatFinalCloseError("unavailable"),
    });
    if (
      !observation.ok &&
      observation.error.status === 404 &&
      ["not_found", "sandbox_not_found"].includes(observation.error.code)
    ) {
      // Issuance is durably fenced. Exact authenticated absence proves this unused guest gone.
      allocation = yield* allocations.advance(allocation, {
        ...allocation,
        phase: "deleted",
        removal: { kind: "absent", targetId: id, completed: true },
      });
      return yield* finishUnused(allocation);
    }
    if (!observation.ok) return yield* Effect.fail(new BoatFinalCloseError("unavailable"));
    const expected = allocation.input;
    const labels = {
      "sealant-runtime": "boat",
      "sealant-deployment": host.deploymentId,
      "sealant-workspace": expected.workspaceId,
      "sealant-run": runId,
      "sealant-instance": expected.consumer.runtimeInstanceId,
      "sealant-attempt": expected.launchAttemptId,
      "sealant-source": expected.publication.publicationId,
    };
    if (
      observation.value.id !== id ||
      !Object.entries(labels).every(([key, value]) => observation.value.labels?.[key] === value)
    )
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    let operation: BoatDeletion;
    if (allocation.removal?.kind === "operation") {
      const operationId = yield* parse(() =>
        boatDeletionIdSchema.parse(
          allocation?.removal?.kind === "operation" ? allocation.removal.id : undefined,
        ),
      );
      operation = yield* call(() => provider.api.getDeletion(operationId));
    } else {
      if (allocation.removal?.kind !== "issued")
        return yield* Effect.fail(new BoatFinalCloseError("held"));
      // Unknown DELETE retains a bounded lease. Accepted operations are polled, never reissued.
      if (!claimed && now - Date.parse(allocation.removal.at) < 180_000) return "pending" as const;
      if (!claimed)
        allocation = yield* allocations.advance(allocation, {
          ...allocation,
          removal: { kind: "issued", token: randomUUID(), at: new Date(now).toISOString() },
        });
      operation = yield* call(() => provider.api.deleteSandbox(id));
    }
    if (
      operation.kind !== "sandbox" ||
      operation.targetId !== id ||
      (allocation.removal?.kind === "operation" && allocation.removal.id !== operation.id)
    )
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
    return allocation.phase === "deleted" ? yield* finishUnused(allocation) : ("pending" as const);
  });
  const boundedUnbound = (runId: string, sandboxId: string) =>
    closeUnused(runId, sandboxId).pipe(
      Effect.timeout(120_000),
      Effect.mapError((error) =>
        error instanceof BoatFinalCloseError ? error : new BoatFinalCloseError("unavailable"),
      ),
    );
  const reconcile = Effect.fn("BoatFinalClose.reconcile")(function* (
    input: Parameters<BoatFinalClose["Service"]["reconcile"]>[0],
  ) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)
      return yield* Effect.fail(new BoatFinalCloseError("held"));
    const ids = yield* allocations.list({ deploymentId: host.deploymentId, ...input });
    const entries = yield* Effect.forEach(
      ids,
      (id) =>
        Effect.gen(function* () {
          const allocation = yield* allocations.get(id);
          if (allocation?.target === null && allocation.sandboxId !== null) {
            const instance = yield* runtimes.getRuntimeInstanceByRunId(id);
            if (instance?.stopReason !== null || instance?.status === "failed")
              return { runId: id, outcome: yield* boundedUnbound(id, allocation.sandboxId) };
          }
          if (
            allocation?.target == null ||
            !["bound", "deleting", "deleted"].includes(allocation.phase)
          )
            return { runId: id, outcome: "skipped" as const };
          const target = allocation.target;
          const instance = yield* runtimes.getRuntimeInstanceByRunId(target.runId);
          if (
            instance?.adapter !== "boat" ||
            instance.resourceId !== target.sandboxId ||
            (instance.stopReason === null && instance.status !== "failed")
          )
            return { runId: id, outcome: "skipped" as const };
          return { runId: id, outcome: yield* boundedClose(target) };
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
  | NativePublicationRepo
  | BoatAllocationRepo
  | BoatExecutionRepo
  | BoatTunnelRepo
  | WorkspaceCaptureDrainRepo
  | WorkspaceRuntimeInstanceRepo
  | BoatExecution
  | BoatResourcesHost
  | BoatFinalCloseProvider
  | SealantRuntime
> = Layer.effect(BoatFinalClose, make);
/** Reuses the canonical capture owner and the existing sealed execution. */
export const boatFinalCloseLayer: Layer.Layer<
  BoatFinalClose,
  never,
  SealantDB | BoatExecution | BoatResourcesHost | BoatFinalCloseProvider
> = boatFinalCloseLayerNoDeps.pipe(
  Layer.provide(
    Layer.mergeAll(
      NativePublicationRepoLive,
      BoatAllocationRepoLive,
      BoatExecutionRepoLive,
      boatTunnelRepoLayer,
      WorkspaceCaptureDrainRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
      SealantRuntimeControlLive,
    ),
  ),
);
