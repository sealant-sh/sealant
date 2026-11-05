import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  nativeArtifactConsumerSchema,
  nativeCatalogRecordSchema,
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
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import {
  nativePublicationConsumers as consumers,
  nativePublications as publications,
} from "../schema/native-publications.js";

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
  readonly reserve: (
    key: NativePublicationKey,
    consumer: NativeArtifactConsumer,
  ) => Effect.Effect<NativeCatalogRecord, NativeCatalogStoreError>;
  readonly get: (
    publicationId: string,
  ) => Effect.Effect<NativeCatalogRecord | undefined, NativeCatalogStoreError>;
  readonly claim: (
    publicationId: string,
    purpose: NativeCatalogClaim["purpose"],
    ttlMs: number,
  ) => Effect.Effect<NativeCatalogClaim | undefined, NativeCatalogStoreError>;
  readonly publish: (
    claim: NativeCatalogClaim,
    publication: NativePublication,
  ) => Effect.Effect<NativeCatalogRecord, NativeCatalogStoreError>;
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
  ) => Effect.Effect<ReadonlyArray<NativeCatalogRecord>, NativeCatalogStoreError>;
  readonly retire: (
    publicationId: string,
    policy?: { readonly keepRecent: number; readonly minAgeMs: number },
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
    sql`${publications.claimUntil} > now()`,
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
          yield* db
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
            })
            .onConflictDoNothing();
          const [row] = yield* db
            .select()
            .from(publications)
            .where(and(eq(publications.keyHash, digest(key)), ne(publications.state, "removed")))
            .for("update");
          if (row === undefined)
            return yield* Effect.fail(new NativeCatalogStoreError("reserve", "malformed-state"));
          const record = yield* parseRow(row);
          if (!isDeepStrictEqual(record.ownership.key, key))
            return yield* Effect.fail(new NativeCatalogStoreError("reserve", "malformed-state"));
          if (record.state === "retiring")
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
          ? sql`${publications.state} in ('reserved','building')`
          : purpose === "remove"
            ? eq(publications.state, "retiring")
            : sql`${publications.state} in ('reserved','building','quarantined')`;
      const [row] = yield* db
        .update(publications)
        .set({
          claimToken: randomUUID(),
          claimPurpose: purpose,
          claimUntil: sql`now() + ${ttlMs} * interval '1 millisecond'`,
          generation: sql`${publications.generation} + 1`,
          ...(purpose === "build" ? { state: "building" } : {}),
        })
        .where(
          and(
            eq(publications.id, id),
            eligible,
            sql`(${publications.claimUntil} is null or ${publications.claimUntil} <= now())`,
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
          yield* db
            .update(consumers)
            .set({ state, releasedAt: state === "released" ? sql`now()` : null })
            .where(consumerWhere(consumer));
        }),
      );
    const candidates = Effect.fn("NativePublicationRepo.candidates")(function* (
      scope: Pick<NativePublicationKey, "deploymentId" | "scope">,
      limit: number,
    ) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        return yield* Effect.fail(new NativeCatalogStoreError("candidates", "invalid-input"));
      const rows = yield* db
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.deploymentId, scope.deploymentId),
            eq(publications.scopeKind, scope.scope.kind),
            eq(publications.scopeId, scopeId(scope.scope)),
            sql`${publications.state} in ('ready','retiring')`,
          ),
        )
        .orderBy(asc(publications.createdAt), asc(publications.id))
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
          if (record.state !== "ready" || (yield* pins(id)).length !== 0) return undefined;
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
      get: (id) => boundary("get", get(id)),
      claim: (id, purpose, ttlMs) => boundary("claim", takeClaim(id, purpose, ttlMs)),
      publish: (claim, publication) => boundary("publish", publish(claim, publication)),
      quarantine: (claim, reason) => boundary("quarantine", quarantine(claim, reason)),
      markConsumer: (consumer, id, state) =>
        boundary("markConsumer", changeConsumer(consumer, id, state)),
      release: (consumer, id) => boundary("release", changeConsumer(consumer, id, "released")),
      candidates: (scope, limit) => boundary("candidates", candidates(scope, limit)),
      retire: (id, policy) => boundary("retire", retire(id, policy)),
      removed: (claim) => boundary("removed", removed(claim)),
    });
  },
);

/** Infrastructure stays open so each composition root chooses its database. */
export const NativePublicationRepoLive: Layer.Layer<NativePublicationRepo, never, SealantDB> =
  Layer.effect(NativePublicationRepo, make);
