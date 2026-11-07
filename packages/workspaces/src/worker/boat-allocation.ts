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

const TransportLayer: Layer.Layer<BoatGuestTransportService, never, BoatAllocationProvider> =
  Layer.effect(
    BoatGuestTransportService,
    Effect.gen(function* () {
      const provider = yield* BoatAllocationProvider;
      return createBoatGuestTransport(provider.api);
    }),
  );
/** Shared sealed execution owner for allocation and resource reconciliation in one worker graph. */
export const boatWorkerExecutionLayer: Layer.Layer<
  BoatExecution,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider
> = boatExecutionLayer.pipe(Layer.provide(TransportLayer));

/** Worker assembly for allocation through authenticated held bootstrap. Ordinary registration remains disabled. */
export const boatAllocationWorkerLayer: Layer.Layer<
  BoatAllocation,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider
> = boatAllocationLayer.pipe(Layer.provide(boatWorkerExecutionLayer));
