import { randomUUID } from "node:crypto";

import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatObservationRepo,
  BoatObservationRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  NativePublicationRepo,
  NativePublicationRepoLive,
  SealantDB,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  type WorkspaceCaptureDrain,
} from "@sealant/db";
import type { BoatAllocationRecord } from "@sealant/validators";
import { Cause, Context, Effect, Exit, Layer, Option } from "effect";

import { BoatResourcesHost } from "../../worker/boat-resources.js";
import { databaseCaptureDrainLedger } from "../../worker/capture-drain-ledger.js";

/**
 * What became of a VM's work once Boat positively no longer has it. `stopped`: removed after its
 * final capture was saved. `discarded`: its owner discarded the unsaved work. `gone`: removed with
 * work not confirmed saved; consumers report it lost. All three end the retention.
 */
export const terminalCaptureState = (
  root: Pick<WorkspaceCaptureDrain, "state" | "discardRequestedAt"> | undefined,
): "stopped" | "discarded" | "gone" =>
  root?.discardRequestedAt != null
    ? "discarded"
    : root?.state === "saved" || root?.state === "stopped"
      ? "stopped"
      : "gone";

const TERMINAL_DETAIL = {
  stopped: "Boat removed the VM after its final capture was saved.",
  discarded: "Boat removed the VM; its owner discarded the unsaved captures.",
  gone: "Boat no longer has the VM; its work was not confirmed saved.",
} as const;

/** One obligation that could not be discharged on this pass; the next pass retries it alone. */
export interface BoatDischargeBlocker {
  readonly obligation: "runtime" | "capture" | "allocation" | "tunnel" | "publication";
  readonly reason: "held" | "unavailable";
}

/**
 * Discharges every obligation of a VM Boat positively no longer has. Each obligation is idempotent
 * and retried on its own: a host that cannot remove the gateway does not keep the public status,
 * the capture outcome or the allocation from settling.
 */
export class BoatDischarge extends Context.Service<
  BoatDischarge,
  {
    readonly discharge: (
      allocation: BoatAllocationRecord,
    ) => Effect.Effect<
      | { readonly kind: "discharged" }
      | { readonly kind: "pending"; readonly blockers: readonly BoatDischargeBlocker[] }
      | { readonly kind: "not-absent" }
    >;
  }
>()("@sealant/workspaces/boat/BoatDischarge") {}

const make = Effect.gen(function* () {
  const db = yield* SealantDB;
  const observations = yield* BoatObservationRepo;
  const allocations = yield* BoatAllocationRepo;
  const tunnels = yield* BoatTunnelRepo;
  const canonical = yield* WorkspaceCaptureDrainRepo;
  const catalog = yield* NativePublicationRepo;
  const host = yield* BoatResourcesHost;
  const ledger = databaseCaptureDrainLedger({
    db,
    owner: `boat-discharge-${randomUUID()}`,
    leaseMs: 180_000,
  });
  const discharge = Effect.fn("BoatDischarge.discharge")(function* (
    allocation: BoatAllocationRecord,
  ) {
    const id = allocation.input.consumer.runtimeInstanceId;
    const runId = allocation.input.consumer.runId;
    const observed = yield* observations.get(id).pipe(Effect.orElseSucceed(() => undefined));
    if (observed?.presence !== "absent" || observed.sandboxId !== allocation.sandboxId)
      return { kind: "not-absent" } as const;
    const root = yield* canonical.getByRunId(runId).pipe(Effect.orElseSucceed(() => undefined));
    // Snapshot parking moves the work into custody before it removes a VM; it owns that lineage.
    if (root?.custodyContract === 3) return { kind: "not-absent" } as const;
    const blockers: BoatDischargeBlocker[] = [];
    const settle = <A, E>(
      obligation: BoatDischargeBlocker["obligation"],
      effect: Effect.Effect<A, E>,
      held: (error: E) => boolean = () => false,
    ) =>
      Effect.exit(effect).pipe(
        Effect.tap((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.logWarning(
                `Boat discharge · run ${runId}: ${obligation} is not settled yet; retried on the next pass.`,
                exit.cause,
              ),
        ),
        Effect.map((exit) => {
          if (Exit.isSuccess(exit)) return true;
          const error = Cause.findErrorOption(exit.cause);
          blockers.push({
            obligation,
            reason: Option.isSome(error) && held(error.value) ? "held" : "unavailable",
          });
          return false;
        }),
      );
    // Public status first: the runtime row reads what Boat said, whatever else is still pending.
    const runtimeSettled = yield* settle(
      "runtime",
      observations.recordAbsent({
        runtimeInstanceId: id,
        runId,
        deploymentId: observed.deploymentId,
        sandboxId: observed.sandboxId,
        basis: observed.basis === "read" ? "not-found" : observed.basis,
      }),
    );
    yield* settle(
      "capture",
      Effect.gen(function* () {
        // A removal issued earlier whose reply was lost: absence is its outcome.
        if (root?.deletionState === "deleting-issued" || root?.deletionState === "deleting")
          yield* ledger.reconcileIssuedDeletion(runId, "gone", undefined);
        const state = terminalCaptureState(root);
        if (root?.state === state && root.retainedAt === null && root.captureTokenSealed === null)
          return;
        yield* canonical.recordObservation({ runId, state, detail: TERMINAL_DETAIL[state] });
      }),
    );
    yield* settle(
      "allocation",
      Effect.gen(function* () {
        const current = yield* allocations.get(id);
        if (current === undefined || current.phase === "deleted" || current.sandboxId === null)
          return;
        yield* allocations.advance(current, {
          ...current,
          phase: "deleted",
          reason: null,
          conflictingSandboxes: [],
          removal: { kind: "absent", targetId: current.sandboxId, completed: true },
        });
      }),
    );
    const tunnelSettled = yield* settle(
      "tunnel",
      Effect.gen(function* () {
        const reservation = yield* tunnels.get(id);
        if (reservation === undefined || reservation.released === true) return;
        // A slot recorded by another gateway host is that host's to clean; it is never guessed.
        if (reservation.binding.gatewayHostId !== host.gatewayHostId)
          return yield* Effect.fail("foreign-host" as const);
        const frozen =
          reservation.closeId === undefined
            ? yield* tunnels.freeze(reservation, randomUUID())
            : reservation;
        yield* host.tunnel.remove(frozen.binding.target);
        yield* tunnels.releaseAbsent(frozen);
      }),
      (error) => error === "foreign-host",
    );
    if (runtimeSettled && tunnelSettled)
      yield* settle(
        "publication",
        catalog.release(allocation.input.consumer, allocation.input.publication.publicationId),
      );
    else blockers.push({ obligation: "publication", reason: "held" });
    return blockers.length === 0
      ? ({ kind: "discharged" } as const)
      : ({ kind: "pending", blockers } as const);
  });
  return BoatDischarge.of({ discharge });
});

export const boatDischargeLayerNoDeps: Layer.Layer<
  BoatDischarge,
  never,
  | SealantDB
  | BoatObservationRepo
  | BoatAllocationRepo
  | BoatTunnelRepo
  | WorkspaceCaptureDrainRepo
  | NativePublicationRepo
  | BoatResourcesHost
> = Layer.effect(BoatDischarge, make);

export const boatDischargeLayer: Layer.Layer<BoatDischarge, never, SealantDB | BoatResourcesHost> =
  boatDischargeLayerNoDeps.pipe(
    Layer.provide(
      Layer.mergeAll(
        BoatObservationRepoLive,
        BoatAllocationRepoLive,
        boatTunnelRepoLayer,
        WorkspaceCaptureDrainRepoLive,
        NativePublicationRepoLive,
      ),
    ),
  );
