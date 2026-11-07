import { isDeepStrictEqual } from "node:util";

import {
  boatExecutionRecordSchema,
  boatTunnelBindingSchema,
  boatTunnelMaterialSchema,
  boatTunnelReservationSchema,
  type BoatTunnelBinding,
  type BoatTunnelMaterial,
  type BoatTunnelReservation,
} from "@sealant/validators";
import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import { boatExecutions } from "../schema/boat-executions.js";
import { boatTunnels } from "../schema/boat-tunnels.js";

/** Store errors never include SQL, ciphertext or serialized key material. */
export class BoatTunnelStoreError extends Error {
  readonly _tag = "BoatTunnelStoreError";
  constructor(
    readonly code:
      | "unavailable"
      | "invalid-record"
      | "binding-conflict"
      | "execution-unavailable"
      | "ports-exhausted"
      | "stale-transition",
  ) {
    super(`Boat tunnel store: ${code}`);
  }
}

/** The database owns port exclusion and the single winning sealed key installation. */
export interface BoatTunnelRepoService {
  readonly get: (
    id: string,
  ) => Effect.Effect<BoatTunnelReservation | undefined, BoatTunnelStoreError>;
  readonly reserve: (
    binding: BoatTunnelBinding,
    reservationId: string,
  ) => Effect.Effect<BoatTunnelReservation, BoatTunnelStoreError>;
  readonly install: (
    previous: BoatTunnelReservation,
    material: BoatTunnelMaterial,
  ) => Effect.Effect<BoatTunnelReservation, BoatTunnelStoreError>;
}
/** No release operation exists until canonical close can prove both peer and host cleanup. */
export class BoatTunnelRepo extends Context.Service<BoatTunnelRepo, BoatTunnelRepoService>()(
  "@sealant/db/BoatTunnelRepo",
) {}

const parse = <A>(run: () => A) =>
  Effect.try({ try: run, catch: () => new BoatTunnelStoreError("invalid-record") });
const boundary = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, BoatTunnelStoreError> =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof BoatTunnelStoreError ? error : new BoatTunnelStoreError("unavailable"),
    ),
  );
const make: Effect.Effect<BoatTunnelRepo["Service"], never, SealantDB> = Effect.gen(function* () {
  const db = yield* SealantDB;
  const get = Effect.fn("BoatTunnelRepo.get")(function* (id: string) {
    const [row] = yield* db.select().from(boatTunnels).where(eq(boatTunnels.runtimeInstanceId, id));
    if (row === undefined) return undefined;
    const record = yield* parse(() => boatTunnelReservationSchema.parse(row.record));
    if (
      record.binding.target.runtimeInstanceId !== row.runtimeInstanceId ||
      record.binding.gatewayHostId !== row.gatewayHostId ||
      record.listenPort !== row.listenPort ||
      record.reservationId !== row.reservationId
    )
      return yield* Effect.fail(new BoatTunnelStoreError("invalid-record"));
    return record;
  });
  const reserve = Effect.fn("BoatTunnelRepo.reserve")(function* (
    input: BoatTunnelBinding,
    reservationId: string,
  ) {
    const binding = yield* parse(() => boatTunnelBindingSchema.parse(input));
    const id = binding.target.runtimeInstanceId;
    const [row] = yield* db
      .select()
      .from(boatExecutions)
      .where(eq(boatExecutions.runtimeInstanceId, id));
    const execution = yield* parse(() =>
      row === undefined ? undefined : boatExecutionRecordSchema.parse(row.record),
    );
    if (execution === undefined || execution.phase === "exchange" || execution.phase === "held")
      return yield* Effect.fail(new BoatTunnelStoreError("execution-unavailable"));
    if (
      row === undefined ||
      execution.target.runtimeInstanceId !== row.runtimeInstanceId ||
      execution.target.deploymentId !== row.deploymentId ||
      execution.target.sandboxId !== row.sandboxId ||
      execution.target.diskLineage !== row.diskLineage
    )
      return yield* Effect.fail(new BoatTunnelStoreError("invalid-record"));
    if (!isDeepStrictEqual(execution.target, binding.target))
      return yield* Effect.fail(new BoatTunnelStoreError("binding-conflict"));
    const existing = yield* get(id);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing.binding, binding))
        return yield* Effect.fail(new BoatTunnelStoreError("binding-conflict"));
      return existing;
    }
    // Each insert atomically arbitrates both run ownership and host-port exclusion.
    for (let listenPort = 40000; listenPort <= 40015; listenPort++) {
      const record = yield* parse(() =>
        boatTunnelReservationSchema.parse({ binding, reservationId, listenPort, material: null }),
      );
      yield* db
        .insert(boatTunnels)
        .values({
          runtimeInstanceId: id,
          gatewayHostId: binding.gatewayHostId,
          listenPort,
          reservationId,
          record,
        })
        .onConflictDoNothing();
      const saved = yield* get(id);
      if (saved !== undefined) {
        if (!isDeepStrictEqual(saved.binding, binding))
          return yield* Effect.fail(new BoatTunnelStoreError("binding-conflict"));
        return saved;
      }
      const [collision] = yield* db
        .select({ id: boatTunnels.runtimeInstanceId })
        .from(boatTunnels)
        .where(eq(boatTunnels.reservationId, reservationId));
      if (collision !== undefined)
        return yield* Effect.fail(new BoatTunnelStoreError("binding-conflict"));
    }
    return yield* Effect.fail(new BoatTunnelStoreError("ports-exhausted"));
  });
  const install = Effect.fn("BoatTunnelRepo.install")(function* (
    input: BoatTunnelReservation,
    value: BoatTunnelMaterial,
  ) {
    const previous = yield* parse(() => boatTunnelReservationSchema.parse(input));
    const material = yield* parse(() => boatTunnelMaterialSchema.parse(value));
    if (previous.material !== null)
      return yield* Effect.fail(new BoatTunnelStoreError("stale-transition"));
    const next = { ...previous, material };
    const rows = yield* db
      .update(boatTunnels)
      .set({ record: next })
      .where(
        and(
          eq(boatTunnels.runtimeInstanceId, previous.binding.target.runtimeInstanceId),
          sql`${boatTunnels.record} = ${JSON.stringify(previous)}::jsonb`,
        ),
      )
      .returning();
    if (rows.length !== 0) return next;
    const saved = yield* get(previous.binding.target.runtimeInstanceId);
    if (
      saved !== undefined &&
      saved.material !== null &&
      isDeepStrictEqual({ ...saved, material: null }, previous)
    )
      return saved;
    return yield* Effect.fail(new BoatTunnelStoreError("stale-transition"));
  });
  return BoatTunnelRepo.of({
    get: (id) => boundary(get(id)),
    reserve: (binding, id) => boundary(reserve(binding, id)),
    install: (previous, material) => boundary(install(previous, material)),
  });
});

/** PostgreSQL enforces unique host ports across deployments and immutable ownership per run. */
export const boatTunnelRepoLayer: Layer.Layer<BoatTunnelRepo, never, SealantDB> = Layer.effect(
  BoatTunnelRepo,
  make,
);
