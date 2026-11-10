import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import { boatObservations, type BoatObservation } from "../schema/boat-observations.js";

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
   * never moves the observation to a different VM (`target-conflict`). Returns the committed row:
   * an absence another observer committed first wins over this read. `created`: Boat reported
   * the VM past creation, so from now on a 404 for it can only mean it is gone.
   */
  readonly recordPresent: (input: {
    readonly runtimeInstanceId: string;
    readonly deploymentId: string;
    readonly sandboxId: string;
    readonly providerState: string;
    readonly created: boolean;
  }) => Effect.Effect<BoatObservation, BoatObservationStoreError>;
  /**
   * Boat positively no longer has the VM. A `not-found` absence needs a committed observation of
   * the VM past creation (enforced by the table); without one nothing is written. Only the
   * observation is written: what the run's runtime row and its capture record say of it is the
   * shared stop and exit paths' to write, from this observation (the adapter's `inspect` answers
   * `missing`). Idempotent; the first absence stands.
   */
  readonly recordAbsent: (input: {
    readonly runtimeInstanceId: string;
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
            createdObservedAt: input.created ? now : null,
            observedAt: now,
          })
          .onConflictDoUpdate({
            target: boatObservations.runtimeInstanceId,
            set: {
              providerState: input.providerState,
              observedAt: now,
              ...(input.created
                ? { createdObservedAt: sql`coalesce(${boatObservations.createdObservedAt}, now())` }
                : {}),
            },
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
          const fromPresent =
            and(
              eq(boatObservations.runtimeInstanceId, input.runtimeInstanceId),
              eq(boatObservations.presence, "present"),
              input.sandboxId === null
                ? sql`false`
                : eq(boatObservations.sandboxId, input.sandboxId),
              eq(boatObservations.deploymentId, input.deploymentId),
            ) ?? sql`false`;
          if (input.basis === "not-found") {
            // A 404 is absence only for a VM Boat had reported past creation; nothing to insert.
            yield* db
              .update(boatObservations)
              .set({ presence: "absent", basis: "not-found", observedAt: now })
              .where(and(fromPresent, isNotNull(boatObservations.createdObservedAt)) ?? sql`false`);
          } else {
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
                setWhere: fromPresent,
              });
          }
          const row = yield* get(input.runtimeInstanceId);
          if (
            row === undefined ||
            row.presence !== "absent" ||
            row.sandboxId !== input.sandboxId ||
            row.deploymentId !== input.deploymentId
          )
            return yield* Effect.fail(new BoatObservationStoreError("target-conflict"));
          return row;
        }),
      ),
    );
  return { get, recordPresent, recordAbsent };
});

export const BoatObservationRepoLive: Layer.Layer<BoatObservationRepo, never, SealantDB> =
  Layer.effect(BoatObservationRepo, make);
