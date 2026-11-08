import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  boatAllocationRecordSchema,
  boatExecutionRecordSchema,
  boatTunnelReservationSchema,
  nativeArtifactConsumerSchema,
  nativeCatalogRecordSchema,
  nativeBuildRetryReasonSchema,
  nativePublicationKeySchema,
  nativePublicationSchema,
  nativeConsumerStateSchema,
  type NativeArtifactConsumer,
  type NativeBuildOwnership,
  type NativeCatalogClaim,
  type NativeCatalogRecord,
  type NativeConsumerState,
  type NativePublication,
  type NativePublicationKey,
} from "@sealant/validators";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import { boatAllocations } from "../schema/boat-allocations.js";
import { boatExecutions } from "../schema/boat-executions.js";
import { boatTunnels } from "../schema/boat-tunnels.js";
import {
  nativePublicationConsumers as consumers,
  nativePublications as publications,
} from "../schema/native-publications.js";
import {
  workspaceRuntimeInstances,
  workspaceCaptureDrains,
} from "../schema/workspace-build-jobs.js";

/** Persistence failures never imply a publication was absent or a consumer was released. */
export class NativeCatalogStoreError extends Error {
  readonly _tag = "NativeCatalogStoreError";
  constructor(
    readonly operation: string,
    readonly code:
      | "store-unavailable"
      | "malformed-state"
      | "consumer-conflict"
      | "consumer-released"
      | "stale-claim"
      | "invalid-input",
  ) {
    super(`Native catalog store failed during ${operation}: ${code}`);
  }
}

/** Transactional ownership; provider and filesystem operations belong outside these methods. */
export interface NativePublicationRepoService {
  /** A new consumer may replace one completed failed build; redelivery never changes its pin. */
  readonly reserve: (
    key: NativePublicationKey,
    consumer: NativeArtifactConsumer,
  ) => Effect.Effect<NativeCatalogRecord, NativeCatalogStoreError>;
  /** Observe the active recipe reservation before repairing a legacy failed-build cause. */
  readonly getActive: (
    key: NativePublicationKey,
  ) => Effect.Effect<NativeCatalogRecord | undefined, NativeCatalogStoreError>;
  readonly get: (
    publicationId: string,
  ) => Effect.Effect<NativeCatalogRecord | undefined, NativeCatalogStoreError>;
  readonly claim: (
    publicationId: string,
    purpose: NativeCatalogClaim["purpose"],
    ttlMs: number,
  ) => Effect.Effect<NativeCatalogClaim | undefined, NativeCatalogStoreError>;
  readonly releaseClaim: (
    claim: NativeCatalogClaim,
  ) => Effect.Effect<void, NativeCatalogStoreError>;
  readonly publish: (
    claim: NativeCatalogClaim,
    publication: NativePublication,
  ) => Effect.Effect<NativeCatalogRecord, NativeCatalogStoreError>;
  /** Fence a ready publication whose provider/journal evidence no longer agrees. */
  readonly rejectReady: (
    publication: NativePublication,
    reason: string,
  ) => Effect.Effect<void, NativeCatalogStoreError>;
  readonly quarantine: (
    claim: NativeCatalogClaim,
    reason: string,
  ) => Effect.Effect<void, NativeCatalogStoreError>;
  readonly markConsumer: (
    consumer: NativeArtifactConsumer,
    publicationId: string,
    state: Exclude<NativeConsumerState, "released">,
  ) => Effect.Effect<void, NativeCatalogStoreError>;
  readonly release: (
    consumer: NativeArtifactConsumer,
    publicationId: string,
  ) => Effect.Effect<void, NativeCatalogStoreError>;
  readonly candidates: (
    scope: Pick<NativePublicationKey, "deploymentId" | "scope">,
    limit: number,
    after?: string,
  ) => Effect.Effect<ReadonlyArray<NativeCatalogRecord>, NativeCatalogStoreError>;
  readonly retire: (
    publicationId: string,
    policy?: { readonly keepRecent: number; readonly minAgeMs: number },
  ) => Effect.Effect<NativeCatalogRecord | undefined, NativeCatalogStoreError>;
  /** Explicit operator withdrawal of an exact unused build, independent of cache retention. */
  readonly withdraw: (
    ownership: NativeBuildOwnership,
  ) => Effect.Effect<NativeCatalogRecord | undefined, NativeCatalogStoreError>;
  readonly removed: (claim: NativeCatalogClaim) => Effect.Effect<void, NativeCatalogStoreError>;
}

/** One database owner for reservations, claims, pins and removal fences. */
export class NativePublicationRepo extends Context.Service<
  NativePublicationRepo,
  NativePublicationRepoService
>()("@sealant/db/NativePublicationRepo") {}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scopeId = (scope: NativePublicationKey["scope"]) =>
  scope.kind === "owner" ? scope.ownerUserId : scope.domainId;
const clearClaim = { claimToken: null, claimUntil: null, claimPurpose: null };

const parseRow = (
  row: typeof publications.$inferSelect,
): Effect.Effect<NativeCatalogRecord, NativeCatalogStoreError> =>
  Effect.try({
    try: () => {
      const record = nativeCatalogRecordSchema.parse({
        ownership: { publicationId: row.id, buildId: row.buildId, key: row.keyPayload },
        state: row.state,
        generation: row.generation,
        claim:
          row.claimToken === null
            ? null
            : {
                publicationId: row.id,
                token: row.claimToken,
                generation: row.generation,
                purpose: row.claimPurpose,
                expiresAt: row.claimUntil,
              },
        publication: row.publication,
        createdAt: row.createdAt,
        readyAt: row.readyAt,
        reason: row.reason,
        buildAttempt: row.buildAttempt,
        replacesPublicationId: row.replacesPublicationId,
      });
      const key = record.ownership.key;
      if (
        row.keyHash !== digest(key) ||
        row.deploymentId !== key.deploymentId ||
        row.scopeKind !== key.scope.kind ||
        row.scopeId !== scopeId(key.scope) ||
        row.recipeHash !== key.recipeHash ||
        (row.claimToken === null && (row.claimUntil !== null || row.claimPurpose !== null))
      )
        throw new Error("binding");
      if (record.publication !== null) checkPublication(record.ownership, record.publication);
      return record;
    },
    catch: () => new NativeCatalogStoreError("read", "malformed-state"),
  });

const checkPublication = (ownership: NativeBuildOwnership, input: NativePublication): void => {
  const publication = nativePublicationSchema.parse(input);
  const { snapshot, evidence } = publication;
  const receipt: unknown = JSON.parse(evidence.receipt);
  if (
    publication.publicationId !== ownership.publicationId ||
    snapshot.build !== ownership.buildId ||
    snapshot.recipeHash !== ownership.key.recipeHash ||
    evidence.recipeHash !== ownership.key.recipeHash ||
    snapshot.receiptHash !== evidence.receiptHash ||
    createHash("sha256").update(evidence.receipt).digest("hex") !== evidence.receiptHash ||
    evidence.assetsHash !== ownership.key.assetsHash ||
    !isDeepStrictEqual(snapshot.runtime, ownership.key.runtime) ||
    !isDeepStrictEqual(evidence.runtime, ownership.key.runtime) ||
    typeof receipt !== "object" ||
    receipt === null ||
    !("ownership" in receipt) ||
    !isDeepStrictEqual(receipt.ownership, ownership) ||
    !("owner" in receipt) ||
    receipt.owner !== snapshot.owner ||
    !("build" in receipt) ||
    receipt.build !== snapshot.build ||
    !("recipeHash" in receipt) ||
    receipt.recipeHash !== evidence.recipeHash ||
    !("assetsHash" in receipt) ||
    receipt.assetsHash !== evidence.assetsHash ||
    !("runtime" in receipt) ||
    !isDeepStrictEqual(receipt.runtime, evidence.runtime) ||
    !("probe" in receipt) ||
    !isDeepStrictEqual(receipt.probe, evidence.imageProbe)
  )
    throw new Error("publication binding");
};

const consumerWhere = (consumer: NativeArtifactConsumer) =>
  and(
    eq(consumers.runId, consumer.runId),
    eq(consumers.runtimeInstanceId, consumer.runtimeInstanceId),
  );
const fence = (claim: NativeCatalogClaim) =>
  and(
    eq(publications.id, claim.publicationId),
    eq(publications.generation, claim.generation),
    eq(publications.claimToken, claim.token),
    eq(publications.claimPurpose, claim.purpose),
    sql`${publications.claimUntil} > clock_timestamp()`,
  );
const make: Effect.Effect<NativePublicationRepo["Service"], never, SealantDB> = Effect.gen(
  function* () {
    const db = yield* SealantDB;
    const boundary = <A>(
      operation: string,
      action: Effect.Effect<A, unknown>,
    ): Effect.Effect<A, NativeCatalogStoreError> =>
      action.pipe(
        Effect.mapError((error) =>
          error instanceof NativeCatalogStoreError
            ? error
            : new NativeCatalogStoreError(operation, "store-unavailable"),
        ),
      );
    const get = Effect.fn("NativePublicationRepo.get")(function* (id: string) {
      const [row] = yield* db.select().from(publications).where(eq(publications.id, id));
      return row === undefined ? undefined : yield* parseRow(row);
    });
    const getActive = Effect.fn("NativePublicationRepo.getActive")(function* (
      input: NativePublicationKey,
    ) {
      const key = yield* Effect.try({
        try: () => nativePublicationKeySchema.parse(input),
        catch: () => new NativeCatalogStoreError("getActive", "invalid-input"),
      });
      const [row] = yield* db
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.keyHash, digest(key)),
            sql`${publications.state} not in ('removed','superseded')`,
          ),
        );
      if (row === undefined) return undefined;
      const record = yield* parseRow(row);
      if (!isDeepStrictEqual(record.ownership.key, key))
        return yield* Effect.fail(new NativeCatalogStoreError("getActive", "malformed-state"));
      return record;
    });
    const lock = (id: string) =>
      db.select().from(publications).where(eq(publications.id, id)).for("update");
    const pins = (id: string) =>
      db
        .select({ runId: consumers.runId })
        .from(consumers)
        .where(and(eq(consumers.publicationId, id), ne(consumers.state, "released")))
        .limit(1);
    const reserve = Effect.fn("NativePublicationRepo.reserve")(function* (
      input: NativePublicationKey,
      consumerInput: NativeArtifactConsumer,
    ) {
      const parsed = yield* Effect.try({
        try: () => ({
          key: nativePublicationKeySchema.parse(input),
          consumer: nativeArtifactConsumerSchema.parse(consumerInput),
        }),
        catch: () => new NativeCatalogStoreError("reserve", "invalid-input"),
      });
      const { key, consumer } = parsed;
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          // Serialize only this recipe. Publication locks still precede consumer locks,
          // as they do in release/retirement. Redelivery keeps its original binding.
          yield* db.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${"native-publication:" + digest(key)}, 0))`,
          );
          const [existingPin] = yield* db.select().from(consumers).where(consumerWhere(consumer));
          if (existingPin !== undefined) {
            const [owned] = yield* lock(existingPin.publicationId);
            const [pin] = yield* db
              .select()
              .from(consumers)
              .where(consumerWhere(consumer))
              .for("update");
            if (
              owned === undefined ||
              pin === undefined ||
              pin.publicationId !== owned.id ||
              !nativeConsumerStateSchema.safeParse(pin.state).success
            )
              return yield* Effect.fail(
                new NativeCatalogStoreError("reserve", "consumer-conflict"),
              );
            const record = yield* parseRow(owned);
            if (!isDeepStrictEqual(record.ownership.key, key))
              return yield* Effect.fail(
                new NativeCatalogStoreError("reserve", "consumer-conflict"),
              );
            if (pin.state === "released")
              return yield* Effect.fail(
                new NativeCatalogStoreError("reserve", "consumer-released"),
              );
            return record;
          }
          const [active] = yield* db
            .select()
            .from(publications)
            .where(
              and(
                eq(publications.keyHash, digest(key)),
                sql`${publications.state} not in ('removed','superseded')`,
              ),
            )
            .for("update");
          let row = active;
          let record = row === undefined ? undefined : yield* parseRow(row);
          if (record !== undefined && !isDeepStrictEqual(record.ownership.key, key))
            return yield* Effect.fail(new NativeCatalogStoreError("reserve", "malformed-state"));
          const replace =
            record?.state === "quarantined" &&
            record.publication === null &&
            record.claim === null &&
            record.buildAttempt === 1 &&
            nativeBuildRetryReasonSchema.safeParse(record.reason).success;
          if (row === undefined || replace) {
            const predecessor = replace ? row : undefined;
            if (predecessor !== undefined) {
              yield* db
                .update(publications)
                .set({
                  state: "superseded",
                  generation: sql`${publications.generation} + 1`,
                  ...clearClaim,
                })
                .where(eq(publications.id, predecessor.id));
            }
            const [fresh] = yield* db
              .insert(publications)
              .values({
                id: randomUUID(),
                buildId: randomUUID(),
                keyHash: digest(key),
                keyPayload: key,
                deploymentId: key.deploymentId,
                scopeKind: key.scope.kind,
                scopeId: scopeId(key.scope),
                recipeHash: key.recipeHash,
                buildAttempt: predecessor === undefined ? 1 : 2,
                replacesPublicationId: predecessor?.id ?? null,
              })
              .returning();
            row = fresh;
            record = row === undefined ? undefined : yield* parseRow(row);
          }
          if (row === undefined || record === undefined)
            return yield* Effect.fail(new NativeCatalogStoreError("reserve", "malformed-state"));
          if (
            record.state === "retiring" ||
            (record.state === "quarantined" && record.reason === "native-removal-pending")
          )
            return yield* Effect.fail(new NativeCatalogStoreError("reserve", "consumer-conflict"));
          yield* db
            .insert(consumers)
            .values({ ...consumer, publicationId: row.id })
            .onConflictDoNothing();
          const [pin] = yield* db
            .select()
            .from(consumers)
            .where(consumerWhere(consumer))
            .for("update");
          if (
            pin === undefined ||
            pin.publicationId !== row.id ||
            !nativeConsumerStateSchema.safeParse(pin.state).success
          )
            return yield* Effect.fail(new NativeCatalogStoreError("reserve", "consumer-conflict"));
          if (pin.state === "released")
            return yield* Effect.fail(new NativeCatalogStoreError("reserve", "consumer-released"));
          return record;
        }),
      );
    });
    const takeClaim = Effect.fn("NativePublicationRepo.claim")(function* (
      id: string,
      purpose: NativeCatalogClaim["purpose"],
      ttlMs: number,
    ) {
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 1800000)
        return yield* Effect.fail(new NativeCatalogStoreError("claim", "invalid-input"));
      const eligible =
        purpose === "build"
          ? eq(publications.state, "reserved")
          : purpose === "remove"
            ? eq(publications.state, "retiring")
            : sql`(${publications.state} in ('reserved','building') or (${publications.state} = 'quarantined' and ${publications.reason} <> 'native-removal-pending'))`;
      const [row] = yield* db
        .update(publications)
        .set({
          claimToken: randomUUID(),
          claimPurpose: purpose,
          claimUntil: sql`clock_timestamp() + ${ttlMs} * interval '1 millisecond'`,
          generation: sql`${publications.generation} + 1`,
          ...(purpose === "build" ? { state: "building" } : {}),
        })
        .where(
          and(
            eq(publications.id, id),
            eligible,
            sql`(${publications.claimUntil} is null or ${publications.claimUntil} <= clock_timestamp())`,
          ),
        )
        .returning();
      return row === undefined ? undefined : ((yield* parseRow(row)).claim ?? undefined);
    });
    const publish = Effect.fn("NativePublicationRepo.publish")(function* (
      claim: NativeCatalogClaim,
      publication: NativePublication,
    ) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          const [row] = yield* lock(claim.publicationId);
          if (row === undefined)
            return yield* Effect.fail(new NativeCatalogStoreError("publish", "stale-claim"));
          const record = yield* parseRow(row);
          if (
            record.reason === "native-removal-pending" ||
            (record.publication !== null && !isDeepStrictEqual(record.publication, publication))
          )
            return yield* Effect.fail(new NativeCatalogStoreError("publish", "stale-claim"));
          yield* Effect.try({
            try: () => checkPublication(record.ownership, publication),
            catch: () => new NativeCatalogStoreError("publish", "malformed-state"),
          });
          const allowed =
            claim.purpose === "reconcile"
              ? sql`${publications.state} in ('reserved','building','quarantined')`
              : eq(publications.state, "building");
          if (claim.purpose === "remove")
            return yield* Effect.fail(new NativeCatalogStoreError("publish", "stale-claim"));
          const [updated] = yield* db
            .update(publications)
            .set({
              state: "ready",
              publication,
              readyAt: sql`now()`,
              reason: null,
              ...clearClaim,
            })
            .where(and(fence(claim), allowed))
            .returning();
          if (updated === undefined)
            return yield* Effect.fail(new NativeCatalogStoreError("publish", "stale-claim"));
          return yield* parseRow(updated);
        }),
      );
    });
    const rejectReady = Effect.fn("NativePublicationRepo.rejectReady")(function* (
      publication: NativePublication,
      reason: string,
    ) {
      if (!/^[a-z][a-z0-9_-]{0,127}$/.test(reason))
        return yield* Effect.fail(new NativeCatalogStoreError("rejectReady", "invalid-input"));
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          const [row] = yield* lock(publication.publicationId);
          if (row === undefined) return;
          const record = yield* parseRow(row);
          if (record.state !== "ready" || !isDeepStrictEqual(record.publication, publication))
            return;
          yield* db
            .update(publications)
            .set({
              state: "quarantined",
              reason,
              generation: sql`${publications.generation} + 1`,
              ...clearClaim,
            })
            .where(eq(publications.id, row.id));
        }),
      );
    });
    const quarantine = Effect.fn("NativePublicationRepo.quarantine")(function* (
      claim: NativeCatalogClaim,
      reason: string,
    ) {
      if (!/^[a-z][a-z0-9_-]{0,127}$/.test(reason))
        return yield* Effect.fail(new NativeCatalogStoreError("quarantine", "invalid-input"));
      const [updated] = yield* db
        .update(publications)
        .set({
          state: "quarantined",
          reason,
          generation: sql`${publications.generation} + 1`,
          ...clearClaim,
        })
        .where(and(fence(claim), ne(publications.state, "removed")))
        .returning({ id: publications.id });
      if (updated === undefined)
        return yield* Effect.fail(new NativeCatalogStoreError("quarantine", "stale-claim"));
    });
    const changeConsumer = (
      consumerInput: NativeArtifactConsumer,
      publicationId: string,
      state: NativeConsumerState,
    ) =>
      db.transaction(() =>
        Effect.gen(function* () {
          const consumer = yield* Effect.try({
            try: () => nativeArtifactConsumerSchema.parse(consumerInput),
            catch: () => new NativeCatalogStoreError("consumer", "invalid-input"),
          });
          const [owner] = yield* lock(publicationId);
          if (owner === undefined)
            return yield* Effect.fail(new NativeCatalogStoreError("consumer", "consumer-conflict"));
          yield* parseRow(owner);
          const [pin] = yield* db
            .select()
            .from(consumers)
            .where(consumerWhere(consumer))
            .for("update");
          if (
            pin === undefined ||
            pin.publicationId !== publicationId ||
            !nativeConsumerStateSchema.safeParse(pin.state).success
          )
            return yield* Effect.fail(new NativeCatalogStoreError("consumer", "consumer-conflict"));
          if (pin.state === "released") {
            if (state === "released") return;
            return yield* Effect.fail(new NativeCatalogStoreError("consumer", "consumer-released"));
          }
          if (state === "released") {
            const [allocation] = yield* db
              .select()
              .from(boatAllocations)
              .where(eq(boatAllocations.runtimeInstanceId, consumer.runtimeInstanceId))
              .limit(1);
            if (allocation !== undefined) {
              const bound = boatAllocationRecordSchema.safeParse(allocation.record);
              const [runtime] = yield* db
                .select()
                .from(workspaceRuntimeInstances)
                .where(eq(workspaceRuntimeInstances.runId, consumer.runId));
              const [capture] = yield* db
                .select()
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, consumer.runId));
              const [tunnel] = yield* db
                .select()
                .from(boatTunnels)
                .where(eq(boatTunnels.runtimeInstanceId, consumer.runtimeInstanceId));
              const reservation = boatTunnelReservationSchema.safeParse(tunnel?.record);
              const [execution] = yield* db
                .select()
                .from(boatExecutions)
                .where(eq(boatExecutions.runtimeInstanceId, consumer.runtimeInstanceId));
              const aborted = boatExecutionRecordSchema.safeParse(execution?.record);
              const deletedUnused =
                bound.success &&
                bound.data.phase === "deleted" &&
                bound.data.removal !== undefined &&
                bound.data.removal.kind !== "issued" &&
                bound.data.removal.completed &&
                capture?.custodyContract !== 3 &&
                (bound.data.target === null
                  ? execution === undefined && tunnel === undefined
                  : aborted.success &&
                    aborted.data.phase === "aborted" &&
                    isDeepStrictEqual(aborted.data.target, bound.data.target) &&
                    (tunnel === undefined ||
                      (reservation.success &&
                        reservation.data.released === true &&
                        reservation.data.aborted === true &&
                        tunnel.releasedAt !== null &&
                        isDeepStrictEqual(reservation.data.binding.target, bound.data.target))));
              // The immutable allocation remains as an audit record after canonical FINAL.
              // Parking custody still needs its root publication for recovery.
              if (
                !bound.success ||
                (!deletedUnused && (bound.data.phase !== "bound" || bound.data.target === null)) ||
                !isDeepStrictEqual(bound.data.input.consumer, consumer) ||
                bound.data.input.publication.publicationId !== publicationId ||
                allocation.publicationId !== publicationId ||
                allocation.sandboxId !== bound.data.sandboxId ||
                runtime?.adapter !== "boat" ||
                runtime.status !== "stopped" ||
                runtime.resourceId !== bound.data.sandboxId ||
                runtime.removedAt === null ||
                runtime.publicationId !== publicationId ||
                (!deletedUnused &&
                  (capture?.deletionState !== "deleted" ||
                    capture.custodyContract === 3 ||
                    !reservation.success ||
                    reservation.data.released !== true ||
                    tunnel?.releasedAt === null ||
                    reservation.data.removal?.completed !== true ||
                    !isDeepStrictEqual(reservation.data.binding.target, bound.data.target)))
              )
                return yield* Effect.fail(
                  new NativeCatalogStoreError("consumer", "consumer-conflict"),
                );
            }
          }
          yield* db
            .update(consumers)
            .set({ state, releasedAt: state === "released" ? sql`now()` : null })
            .where(consumerWhere(consumer));
        }),
      );
    const candidates = Effect.fn("NativePublicationRepo.candidates")(function* (
      scope: Pick<NativePublicationKey, "deploymentId" | "scope">,
      limit: number,
      after?: string,
    ) {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        (after !== undefined &&
          !nativePublicationSchema.shape.publicationId.safeParse(after).success)
      )
        return yield* Effect.fail(new NativeCatalogStoreError("candidates", "invalid-input"));
      const rows = yield* db
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.deploymentId, scope.deploymentId),
            eq(publications.scopeKind, scope.scope.kind),
            eq(publications.scopeId, scopeId(scope.scope)),
            after === undefined ? undefined : gt(publications.id, after),
            sql`(${publications.state} in ('ready','retiring') or (${publications.state} = 'quarantined' and ${publications.reason} = 'native-removal-pending'))`,
          ),
        )
        .orderBy(asc(publications.id))
        .limit(limit);
      return yield* Effect.forEach(rows, parseRow);
    });
    const retire = Effect.fn("NativePublicationRepo.retire")(function* (
      id: string,
      policy = { keepRecent: 10, minAgeMs: 7 * 86400000 },
    ) {
      if (
        !Number.isInteger(policy.keepRecent) ||
        policy.keepRecent < 10 ||
        !Number.isSafeInteger(policy.minAgeMs) ||
        policy.minAgeMs < 7 * 86400000
      )
        return yield* Effect.fail(new NativeCatalogStoreError("retire", "invalid-input"));
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          const [row] = yield* lock(id);
          if (row === undefined) return undefined;
          const record = yield* parseRow(row);
          if (record.state === "retiring") return record;
          const retryRemoval =
            record.state === "quarantined" &&
            record.reason === "native-removal-pending" &&
            record.publication !== null;
          if ((record.state !== "ready" && !retryRemoval) || (yield* pins(id)).length !== 0)
            return undefined;
          if (retryRemoval) {
            const [updated] = yield* db
              .update(publications)
              .set({
                state: "retiring",
                generation: sql`${publications.generation} + 1`,
                ...clearClaim,
              })
              .where(eq(publications.id, id))
              .returning();
            return updated === undefined ? undefined : yield* parseRow(updated);
          }
          const recent = yield* db
            .select({ recipeHash: publications.recipeHash })
            .from(publications)
            .where(
              and(
                eq(publications.deploymentId, row.deploymentId),
                eq(publications.scopeKind, row.scopeKind),
                eq(publications.scopeId, row.scopeId),
                sql`${publications.state} in ('ready','retiring')`,
              ),
            )
            .groupBy(publications.recipeHash)
            .orderBy(sql`max(${publications.createdAt}) desc`, asc(publications.recipeHash))
            .limit(policy.keepRecent);
          if (recent.some((plan) => plan.recipeHash === row.recipeHash)) return undefined;
          const [updated] = yield* db
            .update(publications)
            .set({
              state: "retiring",
              generation: sql`${publications.generation} + 1`,
              ...clearClaim,
            })
            .where(
              and(
                eq(publications.id, id),
                sql`${publications.readyAt} <= now() - ${policy.minAgeMs} * interval '1 millisecond'`,
              ),
            )
            .returning();
          return updated === undefined ? undefined : yield* parseRow(updated);
        }),
      );
    });
    const withdraw = Effect.fn("NativePublicationRepo.withdraw")(function* (
      ownership: NativeBuildOwnership,
    ) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          const [row] = yield* lock(ownership.publicationId);
          if (row === undefined) return undefined;
          const record = yield* parseRow(row);
          if (
            !isDeepStrictEqual(record.ownership, ownership) ||
            (!["ready", "retiring", "removed"].includes(record.state) &&
              !(record.state === "quarantined" && record.reason === "native-removal-pending")) ||
            (yield* pins(ownership.publicationId)).length !== 0
          )
            return yield* Effect.fail(new NativeCatalogStoreError("withdraw", "consumer-conflict"));
          if (record.state === "removed" || record.state === "retiring") return record;
          const [updated] = yield* db
            .update(publications)
            .set({
              state: "retiring",
              generation: sql`${publications.generation} + 1`,
              ...clearClaim,
            })
            .where(
              and(
                eq(publications.id, row.id),
                sql`(${publications.claimUntil} is null or ${publications.claimUntil} <= now())`,
              ),
            )
            .returning();
          return updated === undefined ? undefined : yield* parseRow(updated);
        }),
      );
    });
    const removed = Effect.fn("NativePublicationRepo.removed")(function* (
      claim: NativeCatalogClaim,
    ) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* lock(claim.publicationId);
          if (claim.purpose !== "remove" || (yield* pins(claim.publicationId)).length !== 0)
            return yield* Effect.fail(new NativeCatalogStoreError("removed", "stale-claim"));
          const [updated] = yield* db
            .update(publications)
            .set({ state: "removed", ...clearClaim })
            .where(and(fence(claim), eq(publications.state, "retiring")))
            .returning({ id: publications.id });
          if (updated === undefined)
            return yield* Effect.fail(new NativeCatalogStoreError("removed", "stale-claim"));
        }),
      );
    });
    return NativePublicationRepo.of({
      reserve: (key, consumer) => boundary("reserve", reserve(key, consumer)),
      getActive: (key) => boundary("getActive", getActive(key)),
      get: (id) => boundary("get", get(id)),
      claim: (id, purpose, ttlMs) => boundary("claim", takeClaim(id, purpose, ttlMs)),
      releaseClaim: (claim) =>
        boundary(
          "releaseClaim",
          db.update(publications).set(clearClaim).where(fence(claim)).pipe(Effect.asVoid),
        ),
      publish: (claim, publication) => boundary("publish", publish(claim, publication)),
      rejectReady: (publication, reason) =>
        boundary("rejectReady", rejectReady(publication, reason)),
      quarantine: (claim, reason) => boundary("quarantine", quarantine(claim, reason)),
      markConsumer: (consumer, id, state) =>
        boundary("markConsumer", changeConsumer(consumer, id, state)),
      release: (consumer, id) => boundary("release", changeConsumer(consumer, id, "released")),
      candidates: (scope, limit, after) => boundary("candidates", candidates(scope, limit, after)),
      retire: (id, policy) => boundary("retire", retire(id, policy)),
      withdraw: (ownership) => boundary("withdraw", withdraw(ownership)),
      removed: (claim) => boundary("removed", removed(claim)),
    });
  },
);

/** Infrastructure stays open so each composition root chooses its database. */
export const NativePublicationRepoLive: Layer.Layer<NativePublicationRepo, never, SealantDB> =
  Layer.effect(NativePublicationRepo, make);
