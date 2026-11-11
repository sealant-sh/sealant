import type { CredentialCipher } from "@sealant/credentials";
import { BoatRunRepo, type SealantDB } from "@sealant/db";
import { Effect, Layer } from "effect";

import { BoatConvergence, boatConvergenceLayer } from "../runtime/boat/convergence.js";
import {
  BoatExecution,
  BoatGuestTransportService,
  boatExecutionLayer,
  createBoatGuestTransport,
} from "../runtime/boat/execution.js";
import { BoatAllocationProvider } from "../runtime/boat/provider.js";
import { BoatRemoval, BoatRemovalProvider, boatRemovalLayer } from "../runtime/boat/removal.js";
import type { BoatTunnelCarrier } from "../runtime/boat/tunnel-carrier.js";
import { BoatVm, boatVmLayer } from "../runtime/boat/vm.js";
import { SealantRuntime, SealantRuntimeControlLive } from "../sealantd/runtime.js";
import { BoatReadiness, boatReadinessLayer } from "./boat-readiness.js";
import { BoatResourcesHost, boatResourcesLayer } from "./boat-resources.js";

const TransportLayer: Layer.Layer<
  BoatGuestTransportService,
  never,
  BoatAllocationProvider | SealantRuntime
> = Layer.effect(
  BoatGuestTransportService,
  Effect.gen(function* () {
    const provider = yield* BoatAllocationProvider;
    const runtime = yield* SealantRuntime;
    return createBoatGuestTransport(provider.api, runtime);
  }),
);
/**
 * The sealed execution owner over Boat's real API: one per process graph, shared by every Boat owner
 * built on it (the worker's VM owner, readiness, resources and removal; the API's control access).
 */
export const boatSealedExecutionLayer: Layer.Layer<
  BoatExecution,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider
> = boatExecutionLayer.pipe(
  Layer.provide(TransportLayer),
  Layer.provide(SealantRuntimeControlLive),
);

/** Worker assembly for a run's VM through authenticated held bootstrap. */
export const boatVmWorkerLayer: Layer.Layer<
  BoatVm,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider
> = boatVmLayer.pipe(Layer.provide(boatSealedExecutionLayer));

const Resources = boatResourcesLayer.pipe(Layer.provide(boatSealedExecutionLayer));
/** Launch readiness, run by the Boat adapter's launch. No sweep invokes it. */
export const boatReadinessWorkerLayer: Layer.Layer<
  BoatReadiness,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider | BoatResourcesHost | BoatTunnelCarrier
> = boatReadinessLayer.pipe(Layer.provide(Layer.merge(Resources, boatSealedExecutionLayer)));

/**
 * Boat's own convergence sweep (the no-VM cases, the cleanup after absence, and the nudge of the
 * shared stop), sharing the original sealed execution.
 */
export const boatConvergenceWorkerLayer: Layer.Layer<
  BoatConvergence,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider | BoatRemovalProvider | BoatResourcesHost
> = boatConvergenceLayer.pipe(Layer.provide(boatSealedExecutionLayer));

/** The one deletion of a Boat VM, for the adapter's `stop`, sharing the original sealed execution. */
export const boatRemovalWorkerLayer: Layer.Layer<
  BoatRemoval,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider | BoatRemovalProvider | BoatResourcesHost
> = boatRemovalLayer.pipe(Layer.provide(boatSealedExecutionLayer));

/**
 * At worker start: opens the sealed bearer of every run of the deployment that still has one and
 * whose VM Boat may still have, once, under the context it was sealed in. Nothing is asked of Boat
 * or of a VM. A bearer that does not open (another credential key, a row whose target no longer
 * matches what it was sealed under) leaves its session undrainable: its FINAL cannot be asked for,
 * so its VM is kept and paid for until the bearer opens again or its owner discards it. Each one
 * is said at error level, by run; none stops the worker, and a run that could not be read counts
 * as one that does not open.
 */
export const verifyBoatBearers = (
  deploymentId: string,
): Effect.Effect<
  { readonly checked: number; readonly unopened: readonly string[] },
  never,
  BoatRunRepo | BoatExecution
> =>
  Effect.gen(function* () {
    const runs = yield* BoatRunRepo;
    const execution = yield* BoatExecution;
    const unopened: string[] = [];
    let checked = 0;
    let after: string | undefined;
    do {
      const ids: readonly string[] = yield* runs
        .listBearing({ deploymentId, limit: 100, ...(after === undefined ? {} : { after }) })
        .pipe(
          Effect.catch((error) =>
            Effect.logError(
              `Boat bearers: the runs holding a sealed bearer could not be listed (${error.code}); none was checked past run ${after ?? "(the first)"}.`,
            ).pipe(Effect.as([])),
          ),
        );
      for (const id of ids) {
        checked += 1;
        yield* execution.verifyBearer(id).pipe(
          Effect.catch((error) => {
            unopened.push(id);
            return Effect.logError(
              `Boat bearers · run ${id}: its sealed control bearer does not open (${"code" in error ? error.code : "cipher-unavailable"}). Its daemon cannot be reached, so its final capture cannot be drained: its VM is kept until the bearer opens again or its owner discards the session.`,
            );
          }),
        );
      }
      after = ids.length === 100 ? ids.at(-1) : undefined;
    } while (after !== undefined);
    return { checked, unopened };
  });
