import { isDeepStrictEqual } from "node:util";

import {
  boatAllocationRecordSchema,
  boatExecutionRecordSchema,
  nativePublicationKeySchema,
  nativeConsumerStateSchema,
  nativePublicationSchema,
  type BoatAllocationRecord,
} from "@sealant/validators";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import { boatAllocations } from "../schema/boat-allocations.js";
import { boatExecutions } from "../schema/boat-executions.js";
import { boatObservations } from "../schema/boat-observations.js";
import { boatTunnels } from "../schema/boat-tunnels.js";
import { nativePublications, nativePublicationConsumers } from "../schema/native-publications.js";
import { workspaceRuntimeInstances } from "../schema/workspace-build-jobs.js";

/** Safe failure codes do not contain provider bodies or launch material. */
export class BoatAllocationStoreError extends Error {
  readonly _tag = "BoatAllocationStoreError";
  constructor(
    readonly code:
      | "unavailable"
      | "invalid-record"
      | "binding-conflict"
      | "pin-unavailable"
      | "stale-transition"
      | "run-stopped",
  ) {
    super(`Boat allocation store: ${code}`);
  }
}
/** Atomic ownership and runtime projection. Every provider effect happens outside its transactions. */
export interface BoatAllocationRepoService {
  readonly reserve: (
    record: BoatAllocationRecord,
  ) => Effect.Effect<BoatAllocationRecord, BoatAllocationStoreError>;
  readonly get: (
    id: string,
  ) => Effect.Effect<BoatAllocationRecord | undefined, BoatAllocationStoreError>;
  readonly advance: (
    previous: BoatAllocationRecord,
    next: BoatAllocationRecord,
  ) => Effect.Effect<BoatAllocationRecord, BoatAllocationStoreError>;
  readonly isActive: (id: string) => Effect.Effect<boolean, BoatAllocationStoreError>;
  /** When the allocation was reserved; it precedes issuance, for records issued before `issuedAt`. */
  readonly reservedAt: (id: string) => Effect.Effect<Date | undefined, BoatAllocationStoreError>;
  /**
   * A live launch owns this allocation and its VM: its runtime row is pending and names a launch
   * owner whose lease has not lapsed (by the database clock). Sweeps leave it alone until the launch
   * finishes or its lease lapses; only then do they adopt it.
   */
  readonly launchInFlight: (id: string) => Effect.Effect<boolean, BoatAllocationStoreError>;
  readonly list: (input: {
    readonly deploymentId: string;
    readonly limit: number;
    readonly after?: string;
  }) => Effect.Effect<readonly string[], BoatAllocationStoreError>;
  /**
   * The live allocations of a deployment that hold a tunnel on one gateway host: bound, not
   * launched without resources, their run active, their tunnel reservation there unreleased. Ended
   * runs are never read, so a page costs the same however many runs the deployment has had. Same
   * order and cursor as `list`.
   */
  readonly listTunnelled: (input: {
    readonly deploymentId: string;
    readonly gatewayHostId: string;
    readonly limit: number;
    readonly after?: string;
  }) => Effect.Effect<readonly string[], BoatAllocationStoreError>;
}
/** A run has one allocation obligation. This layer has no delete, replacement or release operation. */
export class BoatAllocationRepo extends Context.Service<
  BoatAllocationRepo,
  BoatAllocationRepoService
>()("@sealant/db/BoatAllocationRepo") {}
const parse = (value: unknown) =>
  Effect.try({
    try: () => boatAllocationRecordSchema.parse(value),
    catch: () => new BoatAllocationStoreError("invalid-record"),
  });
const transitions: Readonly<
  Record<BoatAllocationRecord["phase"], readonly BoatAllocationRecord["phase"][]>
> = {
  // `deleted` with no VM only once Boat is recorded to hold none (`removal.kind` never-created).
  reserved: ["issued", "held", "deleted"],
  issued: ["allocated", "held", "deleted"],
  // `deleted` straight from a live phase only on Boat's own positive absence (`removal.kind` absent).
  allocated: ["bound", "held", "deleting", "deleted"],
  bound: ["deleting", "deleted"],
  held: ["allocated", "deleting", "deleted"],
  deleting: ["deleting", "deleted"],
  deleted: [],
};
const make: Effect.Effect<BoatAllocationRepo["Service"], never, SealantDB> = Effect.gen(
  function* () {
    const db = yield* SealantDB;
    const boundary = <A>(
      effect: Effect.Effect<A, unknown>,
    ): Effect.Effect<A, BoatAllocationStoreError> =>
      effect.pipe(
        Effect.mapError((error) =>
          error instanceof BoatAllocationStoreError
            ? error
            : new BoatAllocationStoreError("unavailable"),
        ),
      );
    const rowRecord = (row: typeof boatAllocations.$inferSelect) =>
      Effect.gen(function* () {
        const record = yield* parse(row.record);
        if (
          record.input.consumer.runtimeInstanceId !== row.runtimeInstanceId ||
          record.input.deploymentId !== row.deploymentId ||
          record.input.publication.publicationId !== row.publicationId ||
          record.idempotencyKey !== row.idempotencyKey ||
          record.diskLineage !== row.diskLineage ||
          record.sandboxId !== row.sandboxId
        )
          return yield* Effect.fail(new BoatAllocationStoreError("invalid-record"));
        return record;
      });
    const get = Effect.fn("BoatAllocationRepo.get")(function* (id: string) {
      const [row] = yield* db
        .select()
        .from(boatAllocations)
        .where(eq(boatAllocations.runtimeInstanceId, id));
      return row === undefined ? undefined : yield* rowRecord(row);
    });
    const reserve = Effect.fn("BoatAllocationRepo.reserve")(function* (
      input: BoatAllocationRecord,
    ) {
      const record = yield* parse(input);
      if (record.phase !== "reserved")
        return yield* Effect.fail(new BoatAllocationStoreError("invalid-record"));
      const { consumer, publication, scope } = record.input;
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          // The catalog uses this same lock order for release and retirement.
          const [owner] = yield* db
            .select()
            .from(nativePublications)
            .where(eq(nativePublications.id, publication.publicationId))
            .for("update");
          const [pin] = yield* db
            .select()
            .from(nativePublicationConsumers)
            .where(
              and(
                eq(nativePublicationConsumers.runId, consumer.runId),
                eq(nativePublicationConsumers.runtimeInstanceId, consumer.runtimeInstanceId),
              ),
            )
            .for("update");
          if (
            owner === undefined ||
            pin === undefined ||
            owner.state !== "ready" ||
            !nativeConsumerStateSchema.safeParse(pin.state).success ||
            pin.state === "released" ||
            pin.publicationId !== publication.publicationId ||
            owner.deploymentId !== record.input.deploymentId ||
            !isDeepStrictEqual(
              nativePublicationSchema.safeParse(owner.publication).data,
              publication,
            ) ||
            !isDeepStrictEqual(
              nativePublicationKeySchema.safeParse(owner.keyPayload).data?.scope,
              scope,
            )
          )
            return yield* Effect.fail(new BoatAllocationStoreError("pin-unavailable"));
          yield* db
            .insert(boatAllocations)
            .values({
              runtimeInstanceId: consumer.runtimeInstanceId,
              deploymentId: record.input.deploymentId,
              publicationId: publication.publicationId,
              idempotencyKey: record.idempotencyKey,
              diskLineage: record.diskLineage,
              record,
            })
            .onConflictDoNothing();
          const saved = yield* get(consumer.runtimeInstanceId);
          if (
            saved === undefined ||
            !isDeepStrictEqual(saved.input, record.input) ||
            saved.manifestDigest !== record.manifestDigest
          )
            return yield* Effect.fail(new BoatAllocationStoreError("binding-conflict"));
          // The worker records its selected adapter before dispatch. A matching pending row is
          // deliberately a no-op here: never overwrite its launch lease or repair a foreign binding.
          yield* db
            .insert(workspaceRuntimeInstances)
            .values({
              runId: consumer.runId,
              adapter: "boat",
              status: "pending",
              publicationId: publication.publicationId,
              publication,
              imageScope: scope,
              sourceKind: record.input.sourceKind,
              daemonImage: publication.evidence.runtime.source,
              daemonRecoveryBoot: publication.evidence.daemonRecovery === "supported",
            })
            .onConflictDoNothing();
          const [runtime] = yield* db
            .select()
            .from(workspaceRuntimeInstances)
            .where(eq(workspaceRuntimeInstances.runId, consumer.runId))
            .for("update");
          if (
            runtime === undefined ||
            runtime.adapter !== "boat" ||
            runtime.publicationId !== publication.publicationId ||
            !isDeepStrictEqual(runtime.publication, publication) ||
            !isDeepStrictEqual(runtime.imageScope, scope) ||
            runtime.sourceKind !== record.input.sourceKind ||
            runtime.resourceId !== saved.sandboxId
          )
            return yield* Effect.fail(new BoatAllocationStoreError("binding-conflict"));
          return saved;
        }),
      );
    });
    const advance = Effect.fn("BoatAllocationRepo.advance")(function* (
      before: BoatAllocationRecord,
      input: BoatAllocationRecord,
    ) {
      const previous = yield* parse(before);
      const next = yield* parse(input);
      if (
        !isDeepStrictEqual(previous.input, next.input) ||
        previous.idempotencyKey !== next.idempotencyKey ||
        previous.diskLineage !== next.diskLineage ||
        previous.manifestDigest !== next.manifestDigest ||
        (previous.issuedAt !== undefined && previous.issuedAt !== next.issuedAt) ||
        // Only an unresolved create is ever adopted from held, when discovery finds its VM.
        (previous.phase === "held" &&
          next.phase === "allocated" &&
          previous.reason !== "create-unresolved") ||
        !transitions[previous.phase].includes(next.phase) ||
        (previous.sandboxId !== null && previous.sandboxId !== next.sandboxId) ||
        (next.phase === "deleting" && previous.sandboxId === null) ||
        (next.phase === "deleted" &&
          previous.phase !== "deleting" &&
          !(
            (next.removal?.kind === "absent" && previous.sandboxId !== null) ||
            (next.removal?.kind === "never-created" && previous.sandboxId === null)
          )) ||
        ((previous.phase !== "allocated" || next.phase !== "bound") &&
          !isDeepStrictEqual(previous.target, next.target)) ||
        (next.removal?.kind !== "absent" &&
          previous.removal !== undefined &&
          previous.removal.kind !== "issued" &&
          (next.removal?.kind !== previous.removal.kind ||
            (previous.removal.kind === "operation" &&
              (next.removal.kind !== "operation" || previous.removal.id !== next.removal.id)) ||
            (previous.removal.completed && !next.removal.completed)))
      )
        return yield* Effect.fail(new BoatAllocationStoreError("stale-transition"));
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          if (next.phase === "deleted" && previous.phase !== "deleting") {
            const [observed] = yield* db
              .select()
              .from(boatObservations)
              .where(eq(boatObservations.runtimeInstanceId, next.input.consumer.runtimeInstanceId));
            if (observed?.presence !== "absent" || observed.sandboxId !== next.sandboxId)
              return yield* Effect.fail(new BoatAllocationStoreError("stale-transition"));
          }
          if (next.phase === "deleting" && next.target !== null) {
            const [row] = yield* db
              .select()
              .from(boatExecutions)
              .where(eq(boatExecutions.runtimeInstanceId, next.target.runtimeInstanceId))
              .for("update");
            const execution = boatExecutionRecordSchema.safeParse(row?.record);
            // A bound VM is removed only once its execution can never start again: aborted before
            // any launch was pushed, or, for a run without resources (no tunnel row to carry its
            // removal), held by the FINAL close that drained it.
            if (
              !execution.success ||
              !(
                execution.data.phase === "aborted" ||
                (next.input.resources === "none" && execution.data.phase === "held")
              ) ||
              !isDeepStrictEqual(execution.data.target, next.target)
            )
              return yield* Effect.fail(new BoatAllocationStoreError("binding-conflict"));
          }
          if (next.phase === "issued") {
            const [source] = yield* db
              .select()
              .from(nativePublications)
              .where(eq(nativePublications.id, next.input.publication.publicationId))
              .for("update");
            if (
              source === undefined ||
              source.state !== "ready" ||
              !isDeepStrictEqual(
                nativePublicationSchema.safeParse(source.publication).data,
                next.input.publication,
              )
            )
              return yield* Effect.fail(new BoatAllocationStoreError("pin-unavailable"));
          }
          const [changed] = yield* db
            .update(boatAllocations)
            .set({ record: next, sandboxId: next.sandboxId })
            .where(
              and(
                eq(boatAllocations.runtimeInstanceId, previous.input.consumer.runtimeInstanceId),
                sql`${boatAllocations.record} = ${JSON.stringify(previous)}::jsonb`,
              ),
            )
            .returning();
          if (changed === undefined)
            return yield* Effect.fail(new BoatAllocationStoreError("stale-transition"));
          const [runtime] = yield* db
            .update(workspaceRuntimeInstances)
            .set({
              resourceId: next.sandboxId,
              reference: next.sandboxId === null ? null : `boat:${next.sandboxId}`,
            })
            .where(
              and(
                eq(workspaceRuntimeInstances.runId, next.input.consumer.runId),
                eq(workspaceRuntimeInstances.adapter, "boat"),
                next.phase === "issued"
                  ? eq(workspaceRuntimeInstances.status, "pending")
                  : undefined,
                eq(workspaceRuntimeInstances.publicationId, next.input.publication.publicationId),
                next.phase === "issued" ? isNull(workspaceRuntimeInstances.stopReason) : undefined,
                next.phase === "deleting" || next.phase === "deleted"
                  ? sql`(${workspaceRuntimeInstances.stopReason} is not null or ${workspaceRuntimeInstances.status} = 'failed')`
                  : undefined,
                sql`${workspaceRuntimeInstances.resourceId} is not distinct from ${previous.sandboxId}`,
              ),
            )
            .returning();
          if (runtime === undefined)
            return yield* Effect.fail(new BoatAllocationStoreError("run-stopped"));
          return next;
        }),
      );
    });
    const isActive = Effect.fn("BoatAllocationRepo.isActive")(function* (id: string) {
      const [row] = yield* db
        .select({ id: workspaceRuntimeInstances.runId })
        .from(workspaceRuntimeInstances)
        .where(
          and(
            eq(workspaceRuntimeInstances.runId, id),
            eq(workspaceRuntimeInstances.adapter, "boat"),
            inArray(workspaceRuntimeInstances.status, ["pending", "running", "ready"]),
            isNull(workspaceRuntimeInstances.stopReason),
          ),
        );
      return row !== undefined;
    });
    const launchInFlight = Effect.fn("BoatAllocationRepo.launchInFlight")(function* (id: string) {
      const [row] = yield* db
        .select({ id: workspaceRuntimeInstances.runId })
        .from(workspaceRuntimeInstances)
        .where(
          and(
            eq(workspaceRuntimeInstances.runId, id),
            eq(workspaceRuntimeInstances.status, "pending"),
            // Boat launches always name their owner; its lease is read by the database clock.
            isNotNull(workspaceRuntimeInstances.launchOwner),
            gt(workspaceRuntimeInstances.launchLeaseExpiresAt, sql`now()`),
          ),
        );
      return row !== undefined;
    });
    const list = Effect.fn("BoatAllocationRepo.list")(function* (
      input: Parameters<BoatAllocationRepoService["list"]>[0],
    ) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        return yield* Effect.fail(new BoatAllocationStoreError("invalid-record"));
      const rows = yield* db
        .select({ id: boatAllocations.runtimeInstanceId })
        .from(boatAllocations)
        .where(
          and(
            eq(boatAllocations.deploymentId, input.deploymentId),
            input.after === undefined
              ? undefined
              : gt(boatAllocations.runtimeInstanceId, input.after),
          ),
        )
        .orderBy(asc(boatAllocations.runtimeInstanceId))
        .limit(input.limit);
      return rows.map((row) => row.id);
    });
    const listTunnelled = Effect.fn("BoatAllocationRepo.listTunnelled")(function* (
      input: Parameters<BoatAllocationRepoService["listTunnelled"]>[0],
    ) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        return yield* Effect.fail(new BoatAllocationStoreError("invalid-record"));
      const rows = yield* db
        .select({ id: boatAllocations.runtimeInstanceId })
        .from(boatAllocations)
        .innerJoin(
          boatTunnels,
          eq(boatTunnels.runtimeInstanceId, boatAllocations.runtimeInstanceId),
        )
        .innerJoin(
          workspaceRuntimeInstances,
          eq(
            workspaceRuntimeInstances.runId,
            sql`${boatAllocations.record}->'input'->'consumer'->>'runId'`,
          ),
        )
        .where(
          and(
            eq(boatAllocations.deploymentId, input.deploymentId),
            sql`${boatAllocations.record}->>'phase' = 'bound'`,
            sql`(${boatAllocations.record}->'input'->>'resources') is distinct from 'none'`,
            eq(boatTunnels.gatewayHostId, input.gatewayHostId),
            isNull(boatTunnels.releasedAt),
            // The same active run `isActive` reads.
            eq(workspaceRuntimeInstances.adapter, "boat"),
            inArray(workspaceRuntimeInstances.status, ["pending", "running", "ready"]),
            isNull(workspaceRuntimeInstances.stopReason),
            input.after === undefined
              ? undefined
              : gt(boatAllocations.runtimeInstanceId, input.after),
          ),
        )
        .orderBy(asc(boatAllocations.runtimeInstanceId))
        .limit(input.limit);
      return rows.map((row) => row.id);
    });
    const reservedAt = (id: string) =>
      db
        .select({ createdAt: boatAllocations.createdAt })
        .from(boatAllocations)
        .where(eq(boatAllocations.runtimeInstanceId, id))
        .pipe(Effect.map(([row]) => row?.createdAt));
    return BoatAllocationRepo.of({
      isActive: (id) => boundary(isActive(id)),
      reservedAt: (id) => boundary(reservedAt(id)),
      launchInFlight: (id) => boundary(launchInFlight(id)),
      get: (id) => boundary(get(id)),
      reserve: (record) => boundary(reserve(record)),
      advance: (before, next) => boundary(advance(before, next)),
      list: (input) => boundary(list(input)),
      listTunnelled: (input) => boundary(listTunnelled(input)),
    });
  },
);
/** Owns database transactions and complete-record compare-and-set transitions. */
export const BoatAllocationRepoLive: Layer.Layer<BoatAllocationRepo, never, SealantDB> =
  Layer.effect(BoatAllocationRepo, make);
