import type { CredentialCipher } from "@sealant/credentials";
import type { SealantDB } from "@sealant/db";
import { Effect, Layer } from "effect";

import {
  BoatAllocation,
  BoatAllocationProvider,
  boatAllocationLayer,
} from "../runtime/boat/allocation.js";
import {
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
const ExecutionLayer = boatExecutionLayer.pipe(Layer.provide(TransportLayer));

/** Worker assembly for allocation through authenticated held bootstrap. Ordinary registration remains disabled. */
export const boatAllocationWorkerLayer: Layer.Layer<
  BoatAllocation,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider
> = boatAllocationLayer.pipe(Layer.provide(ExecutionLayer));
