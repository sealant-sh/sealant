import {
  BoatObservationRepo,
  BoatObservationRepoLive,
  type BoatObservation,
  type BoatObservationStoreError,
  type SealantDB,
} from "@sealant/db";
import type { BoatAllocationRecord } from "@sealant/validators";
import { Context, Effect, Layer } from "effect";

import type { BoatSandbox } from "./api.js";
import { boatSandboxIdSchema, type BoatApiError } from "./config.js";
import { BoatAllocationProvider, boatAllocationMatches } from "./provider.js";

/**
 * Boat's states while it is still accepting an asynchronous create (202, then `provisioned` and
 * `cloning`). A VM read only in these states may not be readable yet, so a 404 for it is unknown.
 */
const CREATING: ReadonlySet<BoatSandbox["state"]> = new Set([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
]);

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
       * `unreadable`: Boat did not answer conclusively. `creating`: a 404 before Boat ever reported
       * the VM past creation. `foreign`: Boat returned a VM without this launch's exact labels.
       * `no-sandbox`: the launch has no VM identity to read.
       */
      readonly reason: "unreadable" | "creating" | "foreign" | "no-sandbox";
      /** Boat's own answer, for diagnostics; never response text. */
      readonly error?: BoatApiError;
    };

/**
 * The only writer of observed presence. Absence comes from Boat alone: a typed 404 for a VM Boat
 * had reported past creation, or Boat's own completed deletion. Never elapsed time, a launch error
 * or a lease.
 */
export class BoatObserver extends Context.Service<
  BoatObserver,
  {
    readonly observe: (
      allocation: BoatAllocationRecord,
    ) => Effect.Effect<BoatPresence, BoatObservationStoreError>;
    /** Boat's own deletion operation for this exact VM completed. */
    readonly deletionCompleted: (
      allocation: BoatAllocationRecord,
      sandboxId: string,
    ) => Effect.Effect<void, BoatObservationStoreError>;
  }
>()("@sealant/workspaces/boat/BoatObserver") {}

const notFound = (error: BoatApiError) =>
  error.status === 404 && ["not_found", "sandbox_not_found"].includes(error.code);

const ids = (allocation: BoatAllocationRecord) => ({
  runtimeInstanceId: allocation.input.consumer.runtimeInstanceId,
  runId: allocation.input.consumer.runId,
  deploymentId: allocation.input.deploymentId,
});

/** The committed absence, whoever wrote it. */
const absence = (row: BoatObservation) =>
  ({ kind: "absent", basis: row.basis === "read" ? "not-found" : row.basis }) as const;

const make = Effect.gen(function* () {
  const observations = yield* BoatObservationRepo;
  const provider = yield* BoatAllocationProvider;
  const observe = Effect.fn("BoatObserver.observe")(function* (allocation: BoatAllocationRecord) {
    const key = ids(allocation);
    const known = yield* observations.get(key.runtimeInstanceId);
    if (known?.presence === "absent") return absence(known);
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
      const row = yield* observations.recordPresent({
        ...key,
        sandboxId: id.data,
        providerState: read.value.state,
        created: !CREATING.has(read.value.state),
      });
      // Another observer may have committed absence while this read was in flight; it stands.
      return row.presence === "absent"
        ? absence(row)
        : ({ kind: "present", sandbox: read.value } as const);
    }
    if (!notFound(read.error))
      return { kind: "unknown", reason: "unreadable", error: read.error } as const;
    if (
      known?.presence !== "present" ||
      known.sandboxId !== id.data ||
      known.createdObservedAt === null
    )
      return { kind: "unknown", reason: "creating", error: read.error } as const;
    return absence(
      yield* observations.recordAbsent({ ...key, sandboxId: id.data, basis: "not-found" }),
    );
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
  BoatObservationRepo | BoatAllocationProvider
> = Layer.effect(BoatObserver, make);

export const boatObserverLayer: Layer.Layer<
  BoatObserver,
  never,
  SealantDB | BoatAllocationProvider
> = boatObserverLayerNoDeps.pipe(Layer.provide(BoatObservationRepoLive));
