import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  SealantDB,
} from "@sealant/db";
import type { BoatExecutionTarget, BoatTunnelReservation } from "@sealant/validators";
import { Context, Effect, Layer, Redacted } from "effect";

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
  | BoatAllocationRepo
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
    return "closed" as const;
  });
  const close = Effect.fn("BoatFinalClose.close")(function* (target: BoatExecutionTarget) {
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
          if (allocation?.phase !== "bound" || allocation.target === null)
            return { runId: id, outcome: "skipped" as const };
          const target = allocation.target;
          const instance = yield* runtimes.getRuntimeInstanceByRunId(target.runId);
          if (
            instance?.adapter !== "boat" ||
            instance.resourceId !== target.sandboxId ||
            instance.stopReason === null ||
            instance.removedAt !== null
          )
            return { runId: id, outcome: "skipped" as const };
          const reservation = yield* tunnels.get(id);
          if (reservation?.binding.gatewayHostId !== host.gatewayHostId)
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
  | BoatAllocationRepo
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
      BoatAllocationRepoLive,
      boatTunnelRepoLayer,
      WorkspaceCaptureDrainRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
      SealantRuntimeControlLive,
    ),
  ),
);
