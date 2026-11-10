import { randomUUID } from "node:crypto";

import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  BoatObservationRepo,
  BoatObservationRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  NativePublicationRepo,
  NativePublicationRepoLive,
  type SealantDB,
} from "@sealant/db";
import type { BoatAllocationRecord } from "@sealant/validators";
import { Cause, Context, Effect, Exit, Layer, Option } from "effect";

import { BoatResourcesHost } from "../../worker/boat-resources.js";

/** One obligation that could not be discharged on this pass; the next pass retries it alone. */
export interface BoatDischargeBlocker {
  readonly obligation: "allocation" | "tunnel" | "publication" | "secrets";
  readonly reason: "held" | "unavailable";
}

/**
 * Discharges what a VM Boat positively no longer has still holds, and what only Boat's own records
 * hold: the allocation, the resume secrets, the gateway and its tunnel slot, the publication pin.
 * Each obligation is idempotent and retried on its own: a host that cannot remove the gateway does
 * not keep the allocation from settling. The run's runtime row and its capture record are not
 * among them: the shared stop and exit paths write both, for every runtime.
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
    /**
     * Releases the publication pins no VM will ever discharge: runs that never got a Boat
     * allocation (a failed or abandoned native build, a stop first) and are over. Idempotent.
     */
    readonly releaseEndedPins: (input: { readonly limit: number }) => Effect.Effect<number>;
  }
>()("@sealant/workspaces/boat/BoatDischarge") {}

const make = Effect.gen(function* () {
  const observations = yield* BoatObservationRepo;
  const allocations = yield* BoatAllocationRepo;
  const tunnels = yield* BoatTunnelRepo;
  const executions = yield* BoatExecutionRepo;
  const catalog = yield* NativePublicationRepo;
  const host = yield* BoatResourcesHost;
  const discharge = Effect.fn("BoatDischarge.discharge")(function* (
    allocation: BoatAllocationRecord,
  ) {
    const id = allocation.input.consumer.runtimeInstanceId;
    const runId = allocation.input.consumer.runId;
    const observed = yield* observations.get(id).pipe(Effect.orElseSucceed(() => undefined));
    if (observed?.presence !== "absent" || observed.sandboxId !== allocation.sandboxId)
      return { kind: "not-absent" } as const;
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
    yield* settle(
      "allocation",
      Effect.gen(function* () {
        const current = yield* allocations.get(id);
        if (current === undefined || current.phase === "deleted") return;
        // Boat holds no VM for the launch (observed not-discovered): finish its terminalization.
        if (current.sandboxId === null) {
          yield* allocations.advance(current, {
            ...current,
            phase: "deleted",
            reason: null,
            conflictingSandboxes: [],
            removal: { kind: "never-created", completed: true },
          });
          return;
        }
        yield* allocations.advance(current, {
          ...current,
          phase: "deleted",
          reason: null,
          conflictingSandboxes: [],
          // A removal this allocation recorded as Boat's own completed deletion operation stays
          // as its receipt.
          removal:
            current.removal?.kind === "operation" && current.removal.completed
              ? current.removal
              : { kind: "absent", targetId: current.sandboxId, completed: true },
        });
      }),
    );
    yield* settle("secrets", executions.forgetResume(id));
    const tunnelSettled = yield* settle(
      "tunnel",
      Effect.gen(function* () {
        const reservation = yield* tunnels.get(id);
        if (reservation === undefined || reservation.released === true) return;
        // A slot recorded by another gateway host is that host's to clean; it is never guessed. A
        // deployment with no resource gateway has no host of its own to clean one from.
        const gateway = host.gateway;
        if (gateway === undefined || reservation.binding.gatewayHostId !== gateway.hostId)
          return yield* Effect.fail("foreign-host" as const);
        const frozen =
          reservation.closeId === undefined
            ? yield* tunnels.freeze(reservation, randomUUID())
            : reservation;
        yield* gateway.tunnel.remove(frozen.binding.target);
        yield* tunnels.releaseAbsent(frozen);
      }),
      (error) => error === "foreign-host",
    );
    // The pin goes last, and only once the gateway is gone and its slot released.
    if (tunnelSettled)
      yield* settle(
        "publication",
        catalog.release(allocation.input.consumer, allocation.input.publication.publicationId),
      );
    else blockers.push({ obligation: "publication", reason: "held" });
    return blockers.length === 0
      ? ({ kind: "discharged" } as const)
      : ({ kind: "pending", blockers } as const);
  });
  const releaseEndedPins = Effect.fn("BoatDischarge.releaseEndedPins")(function* (input: {
    readonly limit: number;
  }) {
    const ended = yield* catalog
      .endedUnallocatedConsumers({ deploymentId: host.deploymentId, limit: input.limit })
      .pipe(Effect.orElseSucceed(() => []));
    let released = 0;
    for (const { consumer, publicationId } of ended) {
      // The guarded release keeps the catalog's lock order and refuses anything still pinned.
      const result = yield* Effect.exit(catalog.release(consumer, publicationId));
      if (Exit.isSuccess(result)) released += 1;
      else
        yield* Effect.logWarning(
          `Boat discharge · run ${consumer.runId}: its ended, unallocated publication pin was not released; retried on the next pass.`,
          result.cause,
        );
    }
    return released;
  });
  return BoatDischarge.of({ discharge, releaseEndedPins });
});

export const boatDischargeLayerNoDeps: Layer.Layer<
  BoatDischarge,
  never,
  | BoatObservationRepo
  | BoatAllocationRepo
  | BoatTunnelRepo
  | BoatExecutionRepo
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
        BoatExecutionRepoLive,
        NativePublicationRepoLive,
      ),
    ),
  );
