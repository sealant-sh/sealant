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
> = boatAllocationLayer.pipe(Layer.provide(boatWorkerExecutionLayer));

const Resources = boatResourcesLayer.pipe(Layer.provide(boatWorkerExecutionLayer));
/** Explicit launch/readiness entrypoint. No sweep invokes it and runtime registration remains disabled. */
export const boatReadinessWorkerLayer: Layer.Layer<
  BoatReadiness,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider | BoatResourcesHost
> = boatReadinessLayer.pipe(Layer.provide(Layer.merge(Resources, boatWorkerExecutionLayer)));
