import type { CredentialCipher } from "@sealant/credentials";
import type { SealantDB } from "@sealant/db";
import { Effect, Layer } from "effect";

import {
  BoatAllocation,
  BoatAllocationProvider,
  boatAllocationLayer,
} from "../runtime/boat/allocation.js";
import {
  BoatExecution,
  BoatGuestTransportService,
  boatExecutionLayer,
  createBoatGuestTransport,
} from "../runtime/boat/execution.js";
import {
  BoatFinalClose,
  BoatFinalCloseProvider,
  boatFinalCloseLayer,
} from "../runtime/boat/final-close.js";
import { boatObserverLayer } from "../runtime/boat/observation.js";
import { BoatParking, BoatParkingProvider, boatParkingLayer } from "../runtime/boat/parking.js";
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
/** Shared sealed execution owner for allocation and resource reconciliation in one worker graph. */
export const boatWorkerExecutionLayer: Layer.Layer<
  BoatExecution,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider
> = boatExecutionLayer.pipe(
  Layer.provide(TransportLayer),
  Layer.provide(SealantRuntimeControlLive),
);

/** Worker assembly for allocation through authenticated held bootstrap. Ordinary registration remains disabled. */
export const boatAllocationWorkerLayer: Layer.Layer<
  BoatAllocation,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider
> = boatAllocationLayer.pipe(
  Layer.provide(Layer.merge(boatWorkerExecutionLayer, boatObserverLayer)),
);

const Resources = boatResourcesLayer.pipe(Layer.provide(boatWorkerExecutionLayer));
/** Explicit launch/readiness entrypoint. No sweep invokes it and runtime registration remains disabled. */
export const boatReadinessWorkerLayer: Layer.Layer<
  BoatReadiness,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider | BoatResourcesHost
> = boatReadinessLayer.pipe(Layer.provide(Layer.merge(Resources, boatWorkerExecutionLayer)));

/** Canonical stopped-run reconciliation, sharing the original sealed execution custody. */
export const boatFinalCloseWorkerLayer: Layer.Layer<
  BoatFinalClose,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider | BoatFinalCloseProvider | BoatResourcesHost
> = boatFinalCloseLayer.pipe(Layer.provide(boatWorkerExecutionLayer));

/** Parking shares the exact exchange, resource and readiness owners used by ordinary held launch. */
export const boatParkingWorkerLayer: Layer.Layer<
  BoatParking,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider | BoatResourcesHost | BoatParkingProvider
> = boatParkingLayer.pipe(
  Layer.provide(
    Layer.mergeAll(boatWorkerExecutionLayer, boatReadinessWorkerLayer, SealantRuntimeControlLive),
  ),
);
