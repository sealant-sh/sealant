import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type SealantDB,
} from "@sealant/db";
import type { BoatAllocationRecord } from "@sealant/validators";
import { Clock, Context, Effect, Layer, Ref } from "effect";

import { BoatResourcesHost } from "../../worker/boat-resources.js";
import type { BoatApi, BoatDeletion } from "./api.js";
import { boatDeletionIdSchema, boatSandboxIdSchema, type BoatResult } from "./config.js";
import { BoatDischarge, boatDischargeLayer } from "./discharge.js";
import { BoatExecution } from "./execution.js";
import { BoatObserver, boatObserverLayer, type BoatPresence } from "./observation.js";
import type { BoatAllocationProvider } from "./provider.js";

/**
 * Why a removal did not finish. `held`: the run is not this removal's to remove as it stands (it is
 * not stopping, its records disagree, it is not fenced, Boat answered for another VM or another
 * operation). `unavailable`: Boat or the database did not answer.
 *
 * `requested` says whether a DELETE may have reached Boat: this call sent one, or an earlier call's
 * operation is on record. `false` means this call sent Boat nothing and knows of no deletion in
 * progress, which is the only failure a caller may take for a definitive refusal.
 */
export class BoatRemovalError extends Error {
  readonly _tag = "BoatRemovalError";
  constructor(
    readonly code: "held" | "unavailable",
    readonly requested: boolean,
  ) {
    super(`Boat removal: ${code}`);
  }
}

export interface BoatRemovalOptions {
  /**
   * `true`: the caller has not fenced the run, so the removal does before it sends DELETE. A
   * launch that was pushed is held, one that never was is aborted, the run's tunnel is frozen if
   * it has one, and a VM never bound is claimed by its allocation. `false`: the caller fenced it
   * where its own sequence needs to (Boat's close holds and freezes before its FINAL drain), and
   * the removal only verifies that, sending nothing to a run that is not fenced.
   */
  readonly fence: boolean;
  /**
   * What the caller read through the observer a moment ago, so Boat is not read twice for one
   * decision. Absent: the removal observes.
   */
  readonly presence?: BoatPresence;
}

/**
 * How far Boat's deletion is. `absent`: Boat no longer has the VM (its own typed 404 for a VM seen
 * past creation, or a deletion it completed earlier). `completed`: its deletion operation reads
 * `completed`, recorded on the allocation. `deleting`: Boat still says the deletion is in progress.
 */
export type BoatDeletionOutcome = "absent" | "completed" | "deleting";

/**
 * `removed`: Boat no longer has the VM and every obligation of it is discharged. `discharging`:
 * Boat no longer has the VM and an obligation (the gateway on another host, say) could not be
 * discharged on this pass; the next one retries it alone. `deleting`: Boat still says the deletion
 * is in progress, and nothing was released.
 */
export type BoatRemovalOutcome = "removed" | "discharging" | "deleting";

/**
 * The one deletion of a Boat VM. Every caller already holds what authorizes a DELETE (the ledger's
 * deletion ticket after an observed-complete FINAL, the owner's discard, or a launch that never
 * ran): this service decides nothing about the work on the VM. It is resumable from every point,
 * and absence is only ever Boat's own answer.
 *
 * In order: observe the VM; if Boat no longer has it, discharge and stop. If a deletion operation
 * is already on record, poll it and never send DELETE again. Otherwise fence the run, then send
 * DELETE. The operation id is written to the allocation before any wait; the wait for `completed`
 * is bounded (20 s by default). On `completed` the absence is recorded and every obligation
 * discharged: the gateway removed and the tunnel slot released if the run has one, the allocation
 * deleted, the resume secrets forgotten, the publication pin released. Until then nothing is.
 */
export class BoatRemoval extends Context.Service<
  BoatRemoval,
  {
    readonly remove: (
      allocation: BoatAllocationRecord,
      options: BoatRemovalOptions,
    ) => Effect.Effect<BoatRemovalOutcome, BoatRemovalError>;
    /**
     * `remove` up to Boat's `completed`, releasing nothing. Only for Boat's own FINAL close, whose
     * capture ledger records the deletion before anything is released: it records that, then the
     * absence, then discharges. The shared stop path needs only `remove`.
     */
    readonly deletion: (
      allocation: BoatAllocationRecord,
      options: BoatRemovalOptions,
    ) => Effect.Effect<BoatDeletionOutcome, BoatRemovalError>;
  }
>()("@sealant/workspaces/boat/BoatRemoval") {}

/** The root supplies the allocation account; this service never discovers credentials. */
export class BoatRemovalProvider extends Context.Service<
  BoatRemovalProvider,
  {
    readonly api: Pick<BoatApi, "deleteSandbox" | "getDeletion">;
    /**
     * How long one removal waits for Boat's deletion operation to complete, so the removal is
     * recorded by the call that issued it rather than a later pass. Default 20 s.
     */
    readonly deletionWaitMs?: number;
  }
>()("@sealant/workspaces/boat/BoatRemovalProvider") {}

const DELETION_WAIT_MS = 20_000;
const DELETION_POLL_MS = 1_000;

const runtimeInstanceId = (allocation: BoatAllocationRecord) =>
  allocation.input.consumer.runtimeInstanceId;
/** One Boat request: anything but Boat's own answer is unavailability. */
const call = <A>(request: () => Promise<BoatResult<A>>) =>
  Effect.tryPromise({ try: request, catch: () => "unavailable" as const }).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail("unavailable" as const),
    ),
  );

type Dependencies =
  | BoatAllocationRepo
  | BoatExecutionRepo
  | BoatTunnelRepo
  | WorkspaceRuntimeInstanceRepo
  | BoatExecution
  | BoatResourcesHost
  | BoatRemovalProvider
  | BoatObserver
  | BoatDischarge;

const make: Effect.Effect<BoatRemoval["Service"], never, Dependencies> = Effect.gen(function* () {
  const allocations = yield* BoatAllocationRepo;
  const executions = yield* BoatExecutionRepo;
  const tunnels = yield* BoatTunnelRepo;
  const runtimes = yield* WorkspaceRuntimeInstanceRepo;
  const execution = yield* BoatExecution;
  const host = yield* BoatResourcesHost;
  const provider = yield* BoatRemovalProvider;
  const observer = yield* BoatObserver;
  const discharger = yield* BoatDischarge;

  /** The allocation as stored now: the caller's copy may predate a write of this removal's own. */
  const stored = (given: BoatAllocationRecord) =>
    Effect.gen(function* () {
      const saved = yield* allocations.get(runtimeInstanceId(given));
      if (
        saved === undefined ||
        saved.input.deploymentId !== host.deploymentId ||
        saved.sandboxId !== given.sandboxId ||
        !isDeepStrictEqual(saved.target, given.target)
      )
        return yield* Effect.fail("held" as const);
      return saved;
    });
  /**
   * The deletion operation on record, if any. Rows written before the operation moved to the
   * allocation carry it on the run's tunnel reservation: read from there, never written there.
   */
  const recordedOperation = (allocation: BoatAllocationRecord) =>
    Effect.gen(function* () {
      if (allocation.removal?.kind === "operation")
        return { id: allocation.removal.id, completed: allocation.removal.completed };
      return (yield* tunnels.get(runtimeInstanceId(allocation)))?.removal;
    });
  /**
   * Polls Boat's own deletion operation until it completes or the wait is spent. The wait bounds
   * the whole loop, including a read still in flight, so a slow provider cannot stretch a removal.
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
            return yield* Effect.fail("held" as const);
          yield* Ref.set(latest, next);
        }
      });
      yield* poll.pipe(Effect.timeoutOption(provider.deletionWaitMs ?? DELETION_WAIT_MS));
      return yield* Ref.get(latest);
    });
  /**
   * Records Boat's deletion operation on the allocation, where it survives a worker restart,
   * before any wait. From then on the allocation is `deleting`. One operation per VM: another id
   * is not this removal's. Completion never reverts.
   */
  const record = (allocation: BoatAllocationRecord, operation: BoatDeletion) =>
    Effect.gen(function* () {
      const saved = yield* stored(allocation);
      if (
        saved.sandboxId === null ||
        operation.kind !== "sandbox" ||
        operation.targetId !== saved.sandboxId
      )
        return yield* Effect.fail("held" as const);
      // Another pass already discharged it on Boat's own absence.
      if (saved.phase === "deleted") return saved;
      if (
        saved.removal !== undefined &&
        saved.removal.kind !== "issued" &&
        (saved.removal.kind !== "operation" || saved.removal.id !== operation.id)
      )
        return yield* Effect.fail("held" as const);
      const completed = operation.status === "completed";
      if (saved.removal?.kind === "operation" && (saved.removal.completed || !completed))
        return saved;
      return yield* allocations.advance(saved, {
        ...saved,
        phase: "deleting",
        reason: null,
        removal: { kind: "operation", id: operation.id, targetId: saved.sandboxId, completed },
      });
    });
  /**
   * Records the operation Boat answered with, before any wait, then waits its bound for
   * `completed` and records that. Says how far the deletion is.
   */
  const follow = (allocation: BoatAllocationRecord, operation: BoatDeletion) =>
    Effect.gen(function* () {
      let saved = yield* record(allocation, operation);
      if (operation.status !== "completed")
        saved = yield* record(saved, yield* awaitDeletion(operation));
      if (saved.removal?.kind === "operation" && saved.removal.completed)
        return "completed" as const;
      // Another pass discharged it on Boat's own absence while this one waited.
      return saved.phase === "deleted" ? ("absent" as const) : ("deleting" as const);
    });
  /**
   * The run is Boat's own row for this VM and is stopping (or its launch failed): the only run a
   * removal fences or deletes. The allocation's `deleting` transition requires the same.
   */
  const stopping = (allocation: BoatAllocationRecord) =>
    Effect.gen(function* () {
      const instance = yield* runtimes.getRuntimeInstanceByRunId(allocation.input.consumer.runId);
      if (
        instance?.adapter !== "boat" ||
        instance.resourceId !== allocation.sandboxId ||
        instance.publicationId !== allocation.input.publication.publicationId ||
        (instance.stopReason === null && instance.status !== "failed")
      )
        return yield* Effect.fail("held" as const);
    });
  /**
   * The run's tunnel reservation, if it has one this worker can settle. A run launched without
   * resources was never given one, and a deployment with no resource gateway, or another gateway
   * host, cannot settle one: the run is held.
   */
  const ownTunnel = (allocation: BoatAllocationRecord) =>
    Effect.gen(function* () {
      const reservation = yield* tunnels.get(runtimeInstanceId(allocation));
      if (reservation === undefined) return undefined;
      if (
        allocation.target === null ||
        allocation.input.resources === "none" ||
        host.gateway === undefined ||
        !isDeepStrictEqual(reservation.binding, {
          target: allocation.target,
          gatewayHostId: host.gateway.hostId,
        })
      )
        return yield* Effect.fail("held" as const);
      return reservation;
    });
  /**
   * Whether the run is this removal's to delete as it stands, before anything is sent to Boat:
   * it is stopping, and nothing can start on the VM again. Everything the allocation's `deleting`
   * transition will require is checked here first, so a DELETE is never sent whose operation could
   * not be recorded.
   */
  const fenced = (allocation: BoatAllocationRecord) =>
    Effect.gen(function* () {
      yield* stopping(allocation);
      const state = yield* executions.get(runtimeInstanceId(allocation));
      if (allocation.target === null) {
        // Never bound: its allocation's own claim is the fence, and it owns no exchange or tunnel.
        if (
          allocation.phase !== "deleting" ||
          state !== undefined ||
          (yield* tunnels.get(runtimeInstanceId(allocation))) !== undefined
        )
          return yield* Effect.fail("held" as const);
        return;
      }
      if (
        !(allocation.phase === "bound" || allocation.phase === "deleting") ||
        state === undefined ||
        !isDeepStrictEqual(state.target, allocation.target) ||
        !(state.phase === "aborted" || state.phase === "held")
      )
        return yield* Effect.fail("held" as const);
      const reservation = yield* ownTunnel(allocation);
      // A launched run that may be linked has a tunnel: without its row nothing here can say its
      // gateway is fenced. A run launched without resources, or never launched, may have none.
      if (
        reservation === undefined
          ? state.phase === "held" && allocation.input.resources !== "none"
          : reservation.closeId === undefined
      )
        return yield* Effect.fail("held" as const);
    });
  /** Makes sure nothing can start on the VM again, for a caller that has not. */
  const fence = (allocation: BoatAllocationRecord) =>
    Effect.gen(function* () {
      // Before any fence is written: a run that is not stopping is never fenced from here.
      yield* stopping(allocation);
      const state = yield* executions.get(runtimeInstanceId(allocation));
      if (allocation.target === null) {
        // Only a never-bound VM is claimed this way. The CAS fences any concurrent binder.
        if (
          state !== undefined ||
          (yield* tunnels.get(runtimeInstanceId(allocation))) !== undefined
        )
          return yield* Effect.fail("held" as const);
        if (allocation.phase === "deleting") return allocation;
        return yield* allocations.advance(allocation, {
          ...allocation,
          phase: "deleting",
          reason: null,
          removal: {
            kind: "issued",
            token: randomUUID(),
            at: new Date(yield* Clock.currentTimeMillis).toISOString(),
          },
        });
      }
      const reservation = yield* ownTunnel(allocation);
      // A launch that may have been pushed is held: its daemon is left to whoever drains it. One
      // that never was is aborted, the durable fence against reserve, exchange, stage and issue.
      if (state !== undefined && ["issued", "running", "held"].includes(state.phase))
        yield* execution.hold(allocation.target);
      else yield* executions.abort(allocation.target);
      if (reservation !== undefined && reservation.closeId === undefined)
        yield* tunnels.freeze(reservation, randomUUID());
      return allocation;
    });

  /**
   * Runs one removal step. A failure before anything was asked of Boat says so (`requested`
   * false); from the DELETE on, or once an operation is on record, every failure is an outcome
   * nobody knows yet.
   */
  const reporting = <A>(
    step: (
      sent: Ref.Ref<boolean>,
    ) => Effect.Effect<A, "held" | "unavailable" | { readonly _tag: string }>,
  ): Effect.Effect<A, BoatRemovalError> =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(false);
      return yield* step(sent).pipe(
        Effect.catch((error) =>
          Ref.get(sent).pipe(
            Effect.flatMap((requested) =>
              Effect.fail(
                new BoatRemovalError(error === "held" ? "held" : "unavailable", requested),
              ),
            ),
          ),
        ),
      );
    });

  const deletion = (given: BoatAllocationRecord, options: BoatRemovalOptions) =>
    reporting((sent) =>
      Effect.gen(function* () {
        const saved = yield* stored(given);
        // 1. Observe. A VM Boat no longer has needs no fence and no DELETE to end.
        const presence = options.presence ?? (yield* observer.observe(saved));
        if (presence.kind === "absent") return "absent" as const;
        // 2. DELETE was accepted earlier, by this worker or one before it: its operation is
        // polled. It decides before presence does, since a VM never seen past creation reads 404
        // as `creating` and presence alone could hold it forever.
        const recorded = yield* recordedOperation(saved);
        if (recorded !== undefined) {
          yield* Ref.set(sent, true);
          const id = boatDeletionIdSchema.safeParse(recorded.id);
          if (!id.success) return yield* Effect.fail("held" as const);
          const operation = yield* call(() => provider.api.getDeletion(id.data));
          if (operation.id !== recorded.id) return yield* Effect.fail("held" as const);
          return yield* follow(saved, operation);
        }
        // 3. Nothing was sent, or its reply was lost. Absence and a timeout are never completion:
        // DELETE goes only to the exact owned VM Boat just returned. Foreign labels are never
        // touched; anything else is unknown.
        if (presence.kind !== "present")
          return yield* Effect.fail(
            presence.reason === "foreign" ? ("held" as const) : ("unavailable" as const),
          );
        const sandbox = boatSandboxIdSchema.safeParse(presence.sandbox.id);
        if (!sandbox.success || sandbox.data !== saved.sandboxId)
          return yield* Effect.fail("held" as const);
        // 4. Fence, then verify it whoever fenced.
        const allocation = options.fence ? yield* fence(saved) : saved;
        yield* fenced(allocation);
        // 5. DELETE. The operation id is recorded before waiting, so a crash mid-wait polls it.
        yield* Ref.set(sent, true);
        const operation = yield* call(() => provider.api.deleteSandbox(sandbox.data));
        return yield* follow(allocation, operation);
      }),
    );

  const discharge = (given: BoatAllocationRecord) =>
    reporting(() =>
      Effect.gen(function* () {
        const allocation = yield* stored(given);
        // Boat's own deletion operation for this exact VM completed: that is its absence.
        if (
          allocation.sandboxId !== null &&
          allocation.removal?.kind === "operation" &&
          allocation.removal.completed
        )
          yield* observer.deletionCompleted(allocation, allocation.sandboxId);
        // Every obligation is discharged against the committed absence alone; without one,
        // nothing is.
        const outcome = yield* discharger.discharge(allocation);
        if (outcome.kind === "not-absent") return yield* Effect.fail("held" as const);
        return outcome.kind === "discharged" ? ("removed" as const) : ("discharging" as const);
      }),
    );

  const remove = Effect.fn("BoatRemoval.remove")(function* (
    allocation: BoatAllocationRecord,
    options: BoatRemovalOptions,
  ) {
    const outcome = yield* deletion(allocation, options);
    if (outcome === "deleting") return "deleting" as const;
    return yield* discharge(allocation).pipe(
      // Boat no longer has the VM: a failure from here on is never a refusal to remove it.
      Effect.mapError((error) => new BoatRemovalError(error.code, true)),
    );
  });

  return BoatRemoval.of({ remove, deletion });
});

/** Open assembly for tests that bring their own repositories, observer and provider. */
export const boatRemovalLayerNoDeps: Layer.Layer<BoatRemoval, never, Dependencies> = Layer.effect(
  BoatRemoval,
  make,
);

/** Shares the sealed execution owner; owns its repositories, the observer and the discharge. */
export const boatRemovalLayer: Layer.Layer<
  BoatRemoval,
  never,
  SealantDB | BoatExecution | BoatResourcesHost | BoatRemovalProvider | BoatAllocationProvider
> = boatRemovalLayerNoDeps.pipe(
  Layer.provide(
    Layer.mergeAll(
      boatObserverLayer,
      boatDischargeLayer,
      BoatAllocationRepoLive,
      BoatExecutionRepoLive,
      boatTunnelRepoLayer,
      WorkspaceRuntimeInstanceRepoLive,
    ),
  ),
);
