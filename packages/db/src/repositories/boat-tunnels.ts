import { isDeepStrictEqual } from "node:util";

import {
  boatExecutionRecordSchema,
  boatAllocationRecordSchema,
  boatNetworkIntentSchema,
  boatTunnelBindingSchema,
  boatTunnelMaterialSchema,
  boatTunnelReservationSchema,
  type BoatTunnelBinding,
  type BoatTunnelMaterial,
  type BoatTunnelReservation,
  type BoatNetworkIntent,
} from "@sealant/validators";
import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB, type DB } from "../client.js";
import { boatAllocations } from "../schema/boat-allocations.js";
import { boatExecutions } from "../schema/boat-executions.js";
import { boatTunnels } from "../schema/boat-tunnels.js";
import { workspaceCaptureDrains } from "../schema/workspace-build-jobs.js";
import {
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
} from "./workspace-capture-drains.js";

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
      | "stale-transition"
      | "operation-held",
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
  /** Freeze setup before external effects. Changed boots, epochs and endpoints require canonical recovery. */
  readonly configure: (
    previous: BoatTunnelReservation,
    network: BoatNetworkIntent,
  ) => Effect.Effect<BoatTunnelReservation, BoatTunnelStoreError>;
  /** Records each host mutation before dispatch. Only the winning insert permits a call. */
  readonly beginUpdate: (
    previous: BoatTunnelReservation,
    operationId: string,
  ) => Effect.Effect<"issued" | "observe-only", BoatTunnelStoreError>;
  /** A positively returned host operation settles only its own outstanding request. */
  readonly endUpdate: (
    binding: BoatTunnelBinding,
    operationId: string,
  ) => Effect.Effect<void, BoatTunnelStoreError>;
  /** Irreversible barrier: unsettled effects refuse unless absent network intent proves no dispatch. */
  readonly freeze: (
    previous: BoatTunnelReservation,
    closeId: string,
  ) => Effect.Effect<BoatTunnelReservation, BoatTunnelStoreError>;

  /** Monotonic exact provider deletion receipt, accepted only after canonical issuance. */
  readonly recordRemoval: (
    previous: BoatTunnelReservation,
    operation: { readonly id: string; readonly targetId: string; readonly completed: boolean },
  ) => Effect.Effect<BoatTunnelReservation, BoatTunnelStoreError>;
  /** After host cleanup, proves an aborted guest positively gone without inventing FINAL evidence. */
  readonly releaseAborted: (
    previous: BoatTunnelReservation,
  ) => Effect.Effect<void, BoatTunnelStoreError>;
  /** Canonical deletion and exact provider completion are necessary; the caller has just proved host cleanup. */
  readonly release: (previous: BoatTunnelReservation) => Effect.Effect<void, BoatTunnelStoreError>;
}
/** Durable custody, with release available only to the canonical terminal close owner. */
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
const update = (
  previous: BoatTunnelReservation,
  next: BoatTunnelReservation,
  connection: Pick<DB, "update">,
) =>
  connection
    .update(boatTunnels)
    .set({ record: next })
    .where(
      and(
        eq(boatTunnels.runtimeInstanceId, previous.binding.target.runtimeInstanceId),
        sql`${boatTunnels.record} = ${JSON.stringify(previous)}::jsonb`,
      ),
    )
    .returning();
const uuid = (value: string) =>
  parse(() => boatTunnelReservationSchema.shape.closeId.unwrap().parse(value));

const make: Effect.Effect<BoatTunnelRepo["Service"], never, SealantDB | WorkspaceCaptureDrainRepo> =
  Effect.gen(function* () {
    const db = yield* SealantDB;
    const canonical = yield* WorkspaceCaptureDrainRepo;
    const custody = yield* canonical.preservation;
    const get = Effect.fn("BoatTunnelRepo.get")(function* (
      id: string,
      connection: Pick<DB, "select"> = db,
    ) {
      const [row] = yield* connection
        .select()
        .from(boatTunnels)
        .where(eq(boatTunnels.runtimeInstanceId, id));
      if (row === undefined) return undefined;
      const record = yield* parse(() => boatTunnelReservationSchema.parse(row.record));
      if (
        record.binding.target.runtimeInstanceId !== row.runtimeInstanceId ||
        record.binding.gatewayHostId !== row.gatewayHostId ||
        record.listenPort !== row.listenPort ||
        record.reservationId !== row.reservationId ||
        (record.released === true) !== (row.releasedAt !== null)
      )
        return yield* Effect.fail(new BoatTunnelStoreError("invalid-record"));
      return record;
    });
    const reserve = Effect.fn("BoatTunnelRepo.reserve")(function* (
      input: BoatTunnelBinding,
      reservationId: string,
    ) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          const binding = yield* parse(() => boatTunnelBindingSchema.parse(input));
          const id = binding.target.runtimeInstanceId;
          const [row] = yield* db
            .select()
            .from(boatExecutions)
            .where(eq(boatExecutions.runtimeInstanceId, id))
            .for("update");
          const execution = yield* parse(() =>
            row === undefined ? undefined : boatExecutionRecordSchema.parse(row.record),
          );
          if (execution === undefined || ["exchange", "held", "aborted"].includes(execution.phase))
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
            if (existing.closeId !== undefined)
              return yield* Effect.fail(new BoatTunnelStoreError("operation-held"));
            if (!isDeepStrictEqual(existing.binding, binding))
              return yield* Effect.fail(new BoatTunnelStoreError("binding-conflict"));
            return existing;
          }
          // Each insert atomically arbitrates both run ownership and host-port exclusion.
          for (let listenPort = 40000; listenPort <= 40015; listenPort++) {
            const record = yield* parse(() =>
              boatTunnelReservationSchema.parse({
                binding,
                reservationId,
                listenPort,
                material: null,
              }),
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
        }),
      );
    });
    const install = Effect.fn("BoatTunnelRepo.install")(function* (
      input: BoatTunnelReservation,
      value: BoatTunnelMaterial,
    ) {
      const previous = yield* parse(() => boatTunnelReservationSchema.parse(input));
      const material = yield* parse(() => boatTunnelMaterialSchema.parse(value));
      if (previous.closeId !== undefined)
        return yield* Effect.fail(new BoatTunnelStoreError("operation-held"));
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

      recordRemoval: (previous, operation) =>
        boundary(
          db.transaction((tx) =>
            Effect.gen(function* () {
              const before = yield* parse(() => boatTunnelReservationSchema.parse(previous));
              const removal = yield* parse(() =>
                boatTunnelReservationSchema.shape.removal
                  .unwrap()
                  .parse({ id: operation.id, completed: operation.completed }),
              );
              const [root] = yield* tx
                .select()
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, before.binding.target.runId))
                .for("update");
              const parking =
                root?.custodyContract === 3 &&
                (yield* custody.tunnelRemovalAuthorized(
                  before.binding.target,
                  operation.id,
                  false,
                ));
              const saved = yield* get(before.binding.target.runtimeInstanceId, tx);
              if (
                saved === undefined ||
                !isDeepStrictEqual(saved.binding, before.binding) ||
                saved.closeId !== before.closeId ||
                before.closeId === undefined ||
                operation.targetId !== before.binding.target.sandboxId ||
                (!["deleting-issued", "deleted"].includes(root?.deletionState ?? "") && !parking) ||
                (saved.updates?.length ?? 0) !== 0 ||
                (saved.removal !== undefined && saved.removal.id !== removal.id)
              )
                return yield* Effect.fail(new BoatTunnelStoreError("binding-conflict"));
              if (saved.removal?.completed === true) return saved;
              const next = { ...saved, removal };
              if ((yield* update(saved, next, tx)).length !== 0) return next;
              return yield* Effect.fail(new BoatTunnelStoreError("stale-transition"));
            }),
          ),
        ),
      releaseAborted: (previous) =>
        boundary(
          db.transaction((tx) =>
            Effect.gen(function* () {
              const before = yield* parse(() => boatTunnelReservationSchema.parse(previous));
              const target = before.binding.target;
              const [allocated] = yield* tx
                .select()
                .from(boatAllocations)
                .where(eq(boatAllocations.runtimeInstanceId, target.runtimeInstanceId));
              const allocation = yield* parse(() =>
                boatAllocationRecordSchema.parse(allocated?.record),
              );
              const [executed] = yield* tx
                .select()
                .from(boatExecutions)
                .where(eq(boatExecutions.runtimeInstanceId, target.runtimeInstanceId));
              const execution = yield* parse(() =>
                boatExecutionRecordSchema.parse(executed?.record),
              );
              const [root] = yield* tx
                .select()
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, target.runId));
              if (
                allocation.phase !== "deleted" ||
                allocation.removal === undefined ||
                allocation.removal.kind === "issued" ||
                !allocation.removal.completed ||
                !isDeepStrictEqual(allocation.target, target) ||
                execution.phase !== "aborted" ||
                !isDeepStrictEqual(execution.target, target) ||
                root?.custodyContract === 3 ||
                before.closeId === undefined ||
                (before.updates?.length ?? 0) !== 0
              )
                return yield* Effect.fail(new BoatTunnelStoreError("operation-held"));
              const next = yield* parse(() =>
                boatTunnelReservationSchema.parse({ ...before, aborted: true, released: true }),
              );
              const saved = yield* get(target.runtimeInstanceId, tx);
              if (isDeepStrictEqual(saved, next)) return;
              if (!isDeepStrictEqual(saved, before))
                return yield* Effect.fail(new BoatTunnelStoreError("stale-transition"));
              const rows = yield* tx
                .update(boatTunnels)
                .set({ record: next, releasedAt: sql`now()` })
                .where(
                  and(
                    eq(boatTunnels.runtimeInstanceId, target.runtimeInstanceId),
                    sql`${boatTunnels.record} = ${JSON.stringify(before)}::jsonb`,
                  ),
                )
                .returning();
              if (rows.length === 0)
                return yield* Effect.fail(new BoatTunnelStoreError("stale-transition"));
            }),
          ),
        ),
      release: (previous) =>
        boundary(
          db.transaction((tx) =>
            Effect.gen(function* () {
              const before = yield* parse(() => boatTunnelReservationSchema.parse(previous));
              const [root] = yield* tx
                .select()
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, before.binding.target.runId))
                .for("update");
              const [row] = yield* tx
                .select()
                .from(boatExecutions)
                .where(
                  eq(boatExecutions.runtimeInstanceId, before.binding.target.runtimeInstanceId),
                );
              const execution = yield* parse(() => boatExecutionRecordSchema.parse(row?.record));
              const parking =
                root?.custodyContract === 3 &&
                (yield* custody.tunnelRemovalAuthorized(
                  before.binding.target,
                  before.removal?.id ?? "",
                  true,
                ));
              const saved = yield* get(before.binding.target.runtimeInstanceId, tx);
              if (
                row === undefined ||
                execution.target.runtimeInstanceId !== row.runtimeInstanceId ||
                execution.target.sandboxId !== row.sandboxId ||
                execution.target.deploymentId !== row.deploymentId ||
                execution.target.diskLineage !== row.diskLineage ||
                (root?.deletionState !== "deleted" && !parking) ||
                execution.phase !== "held" ||
                !isDeepStrictEqual(execution.target, before.binding.target) ||
                before.closeId === undefined ||
                before.removal?.completed !== true ||
                (before.updates?.length ?? 0) !== 0
              )
                return yield* Effect.fail(new BoatTunnelStoreError("operation-held"));
              const next = yield* parse(() =>
                boatTunnelReservationSchema.parse({ ...before, released: true }),
              );
              if (isDeepStrictEqual(saved, next)) return;
              if (!isDeepStrictEqual(saved, before))
                return yield* Effect.fail(new BoatTunnelStoreError("stale-transition"));
              const rows = yield* tx
                .update(boatTunnels)
                .set({ record: next, releasedAt: sql`now()` })
                .where(
                  and(
                    eq(boatTunnels.runtimeInstanceId, before.binding.target.runtimeInstanceId),
                    sql`${boatTunnels.record} = ${JSON.stringify(before)}::jsonb`,
                  ),
                )
                .returning();
              if (rows.length !== 0) return;
              return yield* Effect.fail(new BoatTunnelStoreError("stale-transition"));
            }),
          ),
        ),
      beginUpdate: (previous, operationId) =>
        boundary(
          Effect.gen(function* () {
            const before = yield* parse(() => boatTunnelReservationSchema.parse(previous));
            const id = yield* uuid(operationId);
            if (before.closeId !== undefined || (before.updates?.length ?? 0) >= 16)
              return yield* Effect.fail(new BoatTunnelStoreError("operation-held"));
            if (before.updates?.includes(id)) return "observe-only" as const;
            if (before.material === null)
              return yield* Effect.fail(new BoatTunnelStoreError("invalid-record"));
            const next = { ...before, updates: [...(before.updates ?? []), id] };
            const rows = yield* update(before, next, db);
            if (rows.length !== 0) return "issued" as const;
            const saved = yield* get(before.binding.target.runtimeInstanceId);
            if (saved?.updates?.includes(id)) return "observe-only" as const;
            return yield* Effect.fail(new BoatTunnelStoreError("stale-transition"));
          }),
        ),
      endUpdate: (binding, operationId) =>
        boundary(
          db.transaction((tx) =>
            Effect.gen(function* () {
              const id = yield* uuid(operationId);
              const [row] = yield* tx
                .select()
                .from(boatTunnels)
                .where(eq(boatTunnels.runtimeInstanceId, binding.target.runtimeInstanceId))
                .for("update");
              const before = yield* get(binding.target.runtimeInstanceId, tx);
              if (row === undefined || before === undefined)
                return yield* Effect.fail(new BoatTunnelStoreError("invalid-record"));
              if (!isDeepStrictEqual(before.binding, binding))
                return yield* Effect.fail(new BoatTunnelStoreError("binding-conflict"));
              if (!before.updates?.includes(id)) return;
              if (
                (yield* update(
                  before,
                  { ...before, updates: before.updates.filter((value) => value !== id) },
                  tx,
                )).length !== 1
              )
                return yield* Effect.fail(new BoatTunnelStoreError("stale-transition"));
            }),
          ),
        ),
      freeze: (previous, closeId) =>
        boundary(
          Effect.gen(function* () {
            const before = yield* parse(() => boatTunnelReservationSchema.parse(previous));
            const id = yield* uuid(closeId);
            if ((before.updates?.length ?? 0) !== 0 && before.network !== undefined)
              return yield* Effect.fail(new BoatTunnelStoreError("operation-held"));
            if (before.closeId !== undefined && before.closeId !== id)
              return yield* Effect.fail(new BoatTunnelStoreError("binding-conflict"));
            // Legacy workers began updates before subnet allocation. Gateway dispatch has always
            // required the immutable network intent first. This CAS fences a delayed configure:
            // if configure wins, retry sees a network and must await its actual host operation.
            const next = {
              ...before,
              ...((before.updates?.length ?? 0) === 0 ? {} : { updates: [] }),
              closeId: id,
            };
            if ((yield* update(before, next, db)).length !== 0) return next;
            if (isDeepStrictEqual(yield* get(before.binding.target.runtimeInstanceId), next))
              return next;
            return yield* Effect.fail(new BoatTunnelStoreError("stale-transition"));
          }),
        ),
      reserve: (binding, id) => boundary(reserve(binding, id)),
      install: (previous, material) => boundary(install(previous, material)),
      configure: (previous, input) =>
        boundary(
          Effect.gen(function* () {
            const before = yield* parse(() => boatTunnelReservationSchema.parse(previous));
            const network = yield* parse(() => boatNetworkIntentSchema.parse(input));
            if (before.closeId !== undefined)
              return yield* Effect.fail(new BoatTunnelStoreError("operation-held"));
            if (before.material === null)
              return yield* Effect.fail(new BoatTunnelStoreError("invalid-record"));
            const [row] = yield* db
              .select()
              .from(boatExecutions)
              .where(eq(boatExecutions.runtimeInstanceId, before.binding.target.runtimeInstanceId));
            const execution = yield* parse(() =>
              row === undefined ? undefined : boatExecutionRecordSchema.parse(row.record),
            );
            if (
              execution === undefined ||
              !["installed", "issued", "running"].includes(execution.phase) ||
              execution.admission === null
            )
              return yield* Effect.fail(new BoatTunnelStoreError("execution-unavailable"));
            if (
              !isDeepStrictEqual(execution.target, before.binding.target) ||
              execution.target.runtimeInstanceId !== row?.runtimeInstanceId ||
              execution.target.deploymentId !== row.deploymentId ||
              execution.target.sandboxId !== row.sandboxId ||
              execution.target.diskLineage !== row.diskLineage ||
              execution.admission.epoch !== network.epoch ||
              execution.admission.operationId !== network.operationId
            )
              return yield* Effect.fail(new BoatTunnelStoreError("binding-conflict"));
            const next = { ...before, network };
            if (before.network !== undefined && !isDeepStrictEqual(before.network, network))
              return yield* Effect.fail(new BoatTunnelStoreError("binding-conflict"));
            const rows = yield* db
              .update(boatTunnels)
              .set({ record: next })
              .where(
                and(
                  eq(boatTunnels.runtimeInstanceId, before.binding.target.runtimeInstanceId),
                  sql`${boatTunnels.record} = ${JSON.stringify(before)}::jsonb`,
                ),
              )
              .returning();
            if (rows.length !== 0) return next;
            const saved = yield* get(before.binding.target.runtimeInstanceId);
            if (isDeepStrictEqual(saved, next)) return next;
            return yield* Effect.fail(new BoatTunnelStoreError("stale-transition"));
          }),
        ),
    });
  });

/** PostgreSQL enforces unique host ports across deployments and immutable ownership per run. */
export const boatTunnelRepoLayer: Layer.Layer<BoatTunnelRepo, never, SealantDB> = Layer.effect(
  BoatTunnelRepo,
  make,
).pipe(Layer.provide(WorkspaceCaptureDrainRepoLive));
