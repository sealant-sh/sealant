import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatObservationRepo,
  BoatObservationRepoLive,
  type BoatAllocationStoreError,
  type BoatObservationStoreError,
  type SealantDB,
} from "@sealant/db";
import type { BoatAllocationRecord } from "@sealant/validators";
import { Clock, Context, Effect, Layer } from "effect";

import { BoatAllocationProvider, boatAllocationMatches } from "./allocation.js";
import type { BoatSandbox } from "./api.js";
import { boatSandboxIdSchema } from "./config.js";

/**
 * How long after create was issued Boat may still be unable to read the VM it accepted. Create is
 * asynchronous (202, then `provisioned` and `cloning`); a 404 inside this fence, before the VM was
 * ever read, is not absence. Recorded provisioning takes seconds to a few minutes.
 */
export const BOAT_CREATE_FENCE_MS = 15 * 60_000;

/** What Boat says about one launch's VM right now. Only `absent` is terminal. */
export type BoatPresence =
  | { readonly kind: "present"; readonly sandbox: BoatSandbox }
  | {
      readonly kind: "absent";
      readonly basis: "not-found" | "deletion-completed" | "not-discovered";
    }
  | {
      readonly kind: "unknown";
      /**
       * `unreadable`: Boat did not answer conclusively. `creating`: a 404 inside the create fence of
       * a VM never read. `foreign`: Boat returned a VM without this launch's exact labels.
       * `no-sandbox`: the launch has no VM identity to read.
       */
      readonly reason: "unreadable" | "creating" | "foreign" | "no-sandbox";
    };

export type BoatObserverError = BoatObservationStoreError | BoatAllocationStoreError;

/** The only writer of observed presence. It never infers absence from a launch error or a lease. */
export class BoatObserver extends Context.Service<
  BoatObserver,
  {
    readonly observe: (
      allocation: BoatAllocationRecord,
    ) => Effect.Effect<BoatPresence, BoatObserverError>;
    /** Boat's own deletion operation for this exact VM completed. */
    readonly deletionCompleted: (
      allocation: BoatAllocationRecord,
      sandboxId: string,
    ) => Effect.Effect<void, BoatObserverError>;
  }
>()("@sealant/workspaces/boat/BoatObserver") {}

const notFound = (error: { readonly status: number | null; readonly code: string }) =>
  error.status === 404 && ["not_found", "sandbox_not_found"].includes(error.code);

const ids = (allocation: BoatAllocationRecord) => ({
  runtimeInstanceId: allocation.input.consumer.runtimeInstanceId,
  runId: allocation.input.consumer.runId,
  deploymentId: allocation.input.deploymentId,
});

const make = Effect.gen(function* () {
  const observations = yield* BoatObservationRepo;
  const allocations = yield* BoatAllocationRepo;
  const provider = yield* BoatAllocationProvider;
  /** Whether Boat has certainly finished accepting create, so a 404 can only mean gone. */
  const createSettled = (allocation: BoatAllocationRecord) =>
    Effect.gen(function* () {
      // A bound VM booted and answered: its creation is long finished.
      if (allocation.target !== null) return true;
      const issuedAt =
        allocation.issuedAt === undefined
          ? yield* allocations.reservedAt(allocation.input.consumer.runtimeInstanceId)
          : new Date(allocation.issuedAt);
      if (issuedAt === undefined) return false;
      return (yield* Clock.currentTimeMillis) - issuedAt.getTime() >= BOAT_CREATE_FENCE_MS;
    });
  const observe = Effect.fn("BoatObserver.observe")(function* (allocation: BoatAllocationRecord) {
    const key = ids(allocation);
    const known = yield* observations.get(key.runtimeInstanceId);
    if (known?.presence === "absent")
      return { kind: "absent", basis: known.basis === "read" ? "not-found" : known.basis } as const;
    if (allocation.sandboxId === null) return { kind: "unknown", reason: "no-sandbox" } as const;
    const id = boatSandboxIdSchema.safeParse(allocation.sandboxId);
    if (!id.success) return { kind: "unknown", reason: "foreign" } as const;
    const read = yield* Effect.tryPromise(() => provider.api.get(id.data)).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (read === undefined) return { kind: "unknown", reason: "unreadable" } as const;
    if (read.ok) {
      if (read.value.id !== id.data || !boatAllocationMatches(allocation, read.value))
        return { kind: "unknown", reason: "foreign" } as const;
      yield* observations.recordPresent({
        ...key,
        sandboxId: id.data,
        providerState: read.value.state,
      });
      return { kind: "present", sandbox: read.value } as const;
    }
    if (!notFound(read.error)) return { kind: "unknown", reason: "unreadable" } as const;
    const seen = known?.presence === "present" && known.sandboxId === id.data;
    if (!seen && !(yield* createSettled(allocation)))
      return { kind: "unknown", reason: "creating" } as const;
    yield* observations.recordAbsent({ ...key, sandboxId: id.data, basis: "not-found" });
    return { kind: "absent", basis: "not-found" } as const;
  });
  const deletionCompleted = Effect.fn("BoatObserver.deletionCompleted")(function* (
    allocation: BoatAllocationRecord,
    sandboxId: string,
  ) {
    yield* observations.recordAbsent({
      ...ids(allocation),
      sandboxId,
      basis: "deletion-completed",
    });
  });
  return BoatObserver.of({ observe, deletionCompleted });
});

export const boatObserverLayerNoDeps: Layer.Layer<
  BoatObserver,
  never,
  BoatObservationRepo | BoatAllocationRepo | BoatAllocationProvider
> = Layer.effect(BoatObserver, make);

export const boatObserverLayer: Layer.Layer<
  BoatObserver,
  never,
  SealantDB | BoatAllocationProvider
> = boatObserverLayerNoDeps.pipe(
  Layer.provide(Layer.mergeAll(BoatObservationRepoLive, BoatAllocationRepoLive)),
);
