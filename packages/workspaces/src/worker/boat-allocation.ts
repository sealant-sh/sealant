import type { CredentialCipher } from "@sealant/credentials";
import type { SealantDB } from "@sealant/db";
import { Effect, Layer } from "effect";

import { BoatAllocation, boatAllocationLayer } from "../runtime/boat/allocation.js";
import {
  BoatExecution,
  BoatGuestTransportService,
  boatExecutionLayer,
  createBoatGuestTransport,
} from "../runtime/boat/execution.js";
import { BoatFinalClose, boatFinalCloseLayer } from "../runtime/boat/final-close.js";
import { boatObserverLayer } from "../runtime/boat/observation.js";
import { BoatAllocationProvider } from "../runtime/boat/provider.js";
import { BoatRemoval, BoatRemovalProvider, boatRemovalLayer } from "../runtime/boat/removal.js";
import type { BoatTunnelCarrier } from "../runtime/boat/tunnel-carrier.js";
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
 * built on it (the worker's allocation, readiness, resources and close; the API's control access).
 */
export const boatSealedExecutionLayer: Layer.Layer<
  BoatExecution,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider
> = boatExecutionLayer.pipe(
  Layer.provide(TransportLayer),
  Layer.provide(SealantRuntimeControlLive),
);

/** Worker assembly for allocation through authenticated held bootstrap. */
export const boatAllocationWorkerLayer: Layer.Layer<
  BoatAllocation,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider
> = boatAllocationLayer.pipe(
  Layer.provide(Layer.merge(boatSealedExecutionLayer, boatObserverLayer)),
);

const Resources = boatResourcesLayer.pipe(Layer.provide(boatSealedExecutionLayer));
/** Launch readiness, run by the Boat adapter's launch. No sweep invokes it. */
export const boatReadinessWorkerLayer: Layer.Layer<
  BoatReadiness,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider | BoatResourcesHost | BoatTunnelCarrier
> = boatReadinessLayer.pipe(Layer.provide(Layer.merge(Resources, boatSealedExecutionLayer)));

/** Canonical stopped-run reconciliation, sharing the original sealed execution. */
export const boatFinalCloseWorkerLayer: Layer.Layer<
  BoatFinalClose,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider | BoatRemovalProvider | BoatResourcesHost
> = boatFinalCloseLayer.pipe(Layer.provide(boatSealedExecutionLayer));

/** The one deletion of a Boat VM, for the adapter's `stop`, sharing the original sealed execution. */
export const boatRemovalWorkerLayer: Layer.Layer<
  BoatRemoval,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider | BoatRemovalProvider | BoatResourcesHost
> = boatRemovalLayer.pipe(Layer.provide(boatSealedExecutionLayer));
