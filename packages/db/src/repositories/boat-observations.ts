import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import { boatObservations, type BoatObservation } from "../schema/boat-observations.js";
import { workspaceRuntimeInstances } from "../schema/workspace-build-jobs.js";

/** Safe failure codes; no provider response is stored or echoed. */
export class BoatObservationStoreError extends Error {
  readonly _tag = "BoatObservationStoreError";
  constructor(readonly code: "unavailable" | "target-conflict") {
    super(`Boat observation store: ${code}`);
  }
}

export type BoatAbsenceBasis = "not-found" | "deletion-completed" | "not-discovered";

export interface BoatObservationRepoService {
  readonly get: (
    runtimeInstanceId: string,
  ) => Effect.Effect<BoatObservation | undefined, BoatObservationStoreError>;
  /**
   * Boat returned the exact labelled VM. Refreshes the last read; never revives an absent VM and
   * never moves the observation to a different VM (`target-conflict`).
   */
  readonly recordPresent: (input: {
    readonly runtimeInstanceId: string;
    readonly deploymentId: string;
    readonly sandboxId: string;
    readonly providerState: string;
  }) => Effect.Effect<BoatObservation, BoatObservationStoreError>;
  /**
   * Boat positively no longer has the VM. In the same transaction the Boat runtime row reads it:
   * stopped (keeping any stop reason already chosen, `failed` otherwise) and removed. Its launch
   * error is left as history. Idempotent; the first absence stands.
   */
  readonly recordAbsent: (input: {
    readonly runtimeInstanceId: string;
    readonly runId: string;
    readonly deploymentId: string;
    readonly sandboxId: string | null;
    readonly basis: BoatAbsenceBasis;
  }) => Effect.Effect<BoatObservation, BoatObservationStoreError>;
}

export class BoatObservationRepo extends Context.Service<
  BoatObservationRepo,
  BoatObservationRepoService
>()("@sealant/db/BoatObservationRepo") {}

const make: Effect.Effect<BoatObservationRepoService, never, SealantDB> = Effect.gen(function* () {
  const db = yield* SealantDB;
  const boundary = <A>(effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof BoatObservationStoreError
          ? error
          : new BoatObservationStoreError("unavailable"),
      ),
    );
  const get = (runtimeInstanceId: string) =>
    boundary(
      db
        .select()
        .from(boatObservations)
        .where(eq(boatObservations.runtimeInstanceId, runtimeInstanceId))
        .pipe(Effect.map(([row]) => row)),
    );
  const recordPresent: BoatObservationRepoService["recordPresent"] = (input) =>
    boundary(
      Effect.gen(function* () {
        const now = new Date();
        yield* db
          .insert(boatObservations)
          .values({
            runtimeInstanceId: input.runtimeInstanceId,
            deploymentId: input.deploymentId,
            sandboxId: input.sandboxId,
            presence: "present",
            basis: "read",
            providerState: input.providerState,
            firstPresentAt: now,
            observedAt: now,
          })
          .onConflictDoUpdate({
            target: boatObservations.runtimeInstanceId,
            set: { providerState: input.providerState, observedAt: now },
            setWhere:
              and(
                eq(boatObservations.presence, "present"),
                eq(boatObservations.sandboxId, input.sandboxId),
                eq(boatObservations.deploymentId, input.deploymentId),
              ) ?? sql`false`,
          });
        const row = yield* get(input.runtimeInstanceId);
        if (
          row === undefined ||
          row.sandboxId !== input.sandboxId ||
          row.deploymentId !== input.deploymentId
        )
          return yield* Effect.fail(new BoatObservationStoreError("target-conflict"));
        return row;
      }),
    );
  const recordAbsent: BoatObservationRepoService["recordAbsent"] = (input) =>
    boundary(
      db.transaction(() =>
        Effect.gen(function* () {
          const now = new Date();
          yield* db
            .insert(boatObservations)
            .values({
              runtimeInstanceId: input.runtimeInstanceId,
              deploymentId: input.deploymentId,
              sandboxId: input.sandboxId,
              presence: "absent",
              basis: input.basis,
              observedAt: now,
            })
            .onConflictDoUpdate({
              target: boatObservations.runtimeInstanceId,
              set: { presence: "absent", basis: input.basis, observedAt: now },
              setWhere:
                and(
                  eq(boatObservations.presence, "present"),
                  input.sandboxId === null
                    ? sql`false`
                    : eq(boatObservations.sandboxId, input.sandboxId),
                  eq(boatObservations.deploymentId, input.deploymentId),
                ) ?? sql`false`,
            });
          const row = yield* get(input.runtimeInstanceId);
          if (
            row === undefined ||
            row.presence !== "absent" ||
            row.sandboxId !== input.sandboxId ||
            row.deploymentId !== input.deploymentId
          )
            return yield* Effect.fail(new BoatObservationStoreError("target-conflict"));
          // The runtime row is the public surface every reader already uses: it now says what Boat
          // said. A row naming a different resource is someone else's observation and is left.
          yield* db
            .update(workspaceRuntimeInstances)
            .set({
              status: "stopped",
              stopReason: sql`coalesce(${workspaceRuntimeInstances.stopReason}, 'failed')`,
              finishedAt: sql`coalesce(${workspaceRuntimeInstances.finishedAt}, now())`,
              removedAt: sql`coalesce(${workspaceRuntimeInstances.removedAt}, now())`,
            })
            .where(
              and(
                eq(workspaceRuntimeInstances.runId, input.runId),
                eq(workspaceRuntimeInstances.adapter, "boat"),
                input.sandboxId === null
                  ? isNull(workspaceRuntimeInstances.resourceId)
                  : eq(workspaceRuntimeInstances.resourceId, input.sandboxId),
                or(
                  ne(workspaceRuntimeInstances.status, "stopped"),
                  isNull(workspaceRuntimeInstances.removedAt),
                ),
              ),
            );
          return row;
        }),
      ),
    );
  return { get, recordPresent, recordAbsent };
});

export const BoatObservationRepoLive: Layer.Layer<BoatObservationRepo, never, SealantDB> =
  Layer.effect(BoatObservationRepo, make);
