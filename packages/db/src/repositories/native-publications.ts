import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  boatTunnelReservationSchema,
  nativeArtifactConsumerSchema,
  nativeCatalogRecordSchema,
  nativeBuildRetryReasonSchema,
  nativeReopenReasonSchema,
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
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import { boatAccounts } from "../schema/boat-accounts.js";
import { boatRuns } from "../schema/boat-runs.js";
import { boatTunnels } from "../schema/boat-tunnels.js";
import { workspaceAttempts, workspaces } from "../schema/control-plane.js";
import {
  nativePublicationConsumers as consumers,
  nativePublications as publications,
} from "../schema/native-publications.js";
import { ociImageBuildJobs, workspaceRuntimeInstances } from "../schema/workspace-build-jobs.js";
import { deploymentCreateWallet, inWallet, recordedWallet } from "./boat-wallets.js";

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
      | "invalid-input"
      | "account-unavailable"
      /**
       * Reserve: this key's image is being removed (retiring, or its removal pending). Not a
       * conflict of the caller's: a launch waits for the removal, then builds the image again.
       */
      | "publication-removing",
  ) {
    super(`Native catalog store failed during ${operation}: ${code}`);
  }
}

/**
 * What a retention pass of one Boat account keeps. An image is retired only when no run holds it,
 * its key is not one a workspace that can still start would look up (`wanted`), no build for its
 * image scope is queued or running, and nothing has used it since `unusedSince`: it became ready
 * before then, and no run was pinned to it or released it after.
 */
export interface NativeRetentionPolicy {
  readonly wanted: ReadonlyArray<NativePublicationKey>;
  readonly unusedSince: Date;
}

/** A workspace that can still start, as retention reads it: its latest launch's spec and scope. */
export interface NativeStartableWorkspace {
  readonly workspaceId: string;
  /** The latest build job's request, unparsed: the spec that job's acquire planned from. */
  readonly spec: unknown;
  readonly scope: unknown;
  /**
   * The runtime the latest launch resolved to (`workspace_runtime_instances.adapter`), or null
   * when none is recorded yet (queued, or failed before a runtime was chosen). Every create has an
   * image scope whatever its runtime, so this is what tells a Docker workspace from a Boat one.
   */
  readonly adapter: string | null;
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
  /**
   * Pending pins no VM can ever discharge: the run never got a Boat row (its native build
   * failed or was abandoned, or it stopped first) and the run is over. Over means its runtime row
   * is failed or stopped with no live launch lease, or it has no runtime row and its attempt
   * failed or was cancelled. The pin of a run that has a Boat row belongs to the lifecycle of that VM.
   */
  readonly endedUnallocatedConsumers: (input: {
    readonly deploymentId: string;
    readonly limit: number;
  }) => Effect.Effect<
    readonly { readonly consumer: NativeArtifactConsumer; readonly publicationId: string }[],
    NativeCatalogStoreError
  >;
  readonly candidates: (
    scope: Pick<NativePublicationKey, "deploymentId" | "scope">,
    limit: number,
    after?: string,
  ) => Effect.Effect<ReadonlyArray<NativeCatalogRecord>, NativeCatalogStoreError>;
  /**
   * Marks a publication `retiring`, the record a removal is made from, or `undefined` when it is
   * kept. A removal already under way is resumed (`retiring` is returned as it is; a pending one
   * becomes `retiring` again) with or without a policy. A ready one is retired only under a
   * retention policy (`NativeRetentionPolicy`), checked here under its row lock, and never in a
   * Boat account whose removal was asked: that removal deletes it.
   */
  readonly retire: (
    publicationId: string,
    policy?: NativeRetentionPolicy,
  ) => Effect.Effect<NativeCatalogRecord | undefined, NativeCatalogStoreError>;
  /**
   * One page of a deployment's saved images (ready, retiring, or a removal still pending), by id:
   * what a retention pass of its Boat account looks at.
   */
  readonly images: (input: {
    readonly deploymentId: string;
    readonly limit: number;
    readonly after?: string;
  }) => Effect.Effect<ReadonlyArray<NativeCatalogRecord>, NativeCatalogStoreError>;
  /**
   * One page, by workspace id, of the workspaces whose next launch may run in this deployment's
   * Boat account and look up an image there: not archived, their latest launch's spec naming this
   * account (or none, for the install's own), and either not stopped or failed, or stopped or
   * failed at or after `stoppedSince`. A stopped Boat workspace is started again from its latest
   * launch's spec, so each row is the spec and scope that launch planned from, and the runtime it
   * resolved to: the caller keeps only the Boat ones.
   */
  readonly startable: (input: {
    readonly deploymentId: string;
    readonly stoppedSince: Date;
    readonly limit: number;
    readonly after?: string;
  }) => Effect.Effect<ReadonlyArray<NativeStartableWorkspace>, NativeCatalogStoreError>;
  /**
   * The wallet a publication was recorded in: `known` with the wallet (null: the key's only one),
   * `unknown`, or `unreachable`; undefined for no such publication.
   */
  readonly wallet: (
    publicationId: string,
  ) => Effect.Effect<
    | { readonly state: "known"; readonly wallet: string | null }
    | { readonly state: "unknown" | "unreachable" }
    | undefined,
    NativeCatalogStoreError
  >;
  /** Explicit operator withdrawal of an exact unused build, independent of cache retention. */
  readonly withdraw: (
    ownership: NativeBuildOwnership,
  ) => Effect.Effect<NativeCatalogRecord | undefined, NativeCatalogStoreError>;
  readonly removed: (claim: NativeCatalogClaim) => Effect.Effect<void, NativeCatalogStoreError>;
  /**
   * What a deployment still holds in Boat or may yet: its saved images (ready, retiring, or a
   * removal still pending) and its builds in flight (reserved, building). What a Boat account's
   * removal deletes, and waits for, before the account is gone. Oldest first.
   */
  readonly heldByDeployment: (input: {
    readonly deploymentId: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<NativeCatalogRecord>, NativeCatalogStoreError>;
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
/** A caller's instant as SQL takes it; an invalid date is refused. */
const instant = (value: Date): string => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("instant");
  return value.toISOString();
};

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
        reopenedAt: row.reopenedAt,
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
      // Only an image in the wallet the account creates in now: one elsewhere is not its to use.
      const current = (yield* deploymentCreateWallet(db, key.deploymentId)).wallet;
      if (current.kind === "unresolved") return undefined;
      const [row] = yield* db
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.keyHash, digest(key)),
            sql`${publications.state} not in ('removed','superseded')`,
            inWallet(publications, current.wallet),
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
          // A stored Boat account's images are reserved under its row, the row its removal and its
          // wallet change take `for update`: none is reserved, or built, once its removal was
          // asked, and each is recorded in the wallet the account creates in now. An account whose
          // wallet sealant has not resolved creates nothing. The install's own account has no row.
          const owner = yield* deploymentCreateWallet(db, key.deploymentId);
          if (owner.removing || owner.wallet.kind === "unresolved")
            return yield* Effect.fail(
              new NativeCatalogStoreError("reserve", "account-unavailable"),
            );
          const wallet = owner.wallet;
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
          // The recipe's image in this wallet: one recorded in another wallet, or one sealant cannot
          // reach, is never used here; a launch builds its own.
          const [active] = yield* db
            .select()
            .from(publications)
            .where(
              and(
                eq(publications.keyHash, digest(key)),
                sql`${publications.state} not in ('removed','superseded')`,
                inWallet(publications, wallet.wallet),
              ),
            )
            .for("update");
          let row = active;
          let record = row === undefined ? undefined : yield* parseRow(row);
          if (record !== undefined && !isDeepStrictEqual(record.ownership.key, key))
            return yield* Effect.fail(new NativeCatalogStoreError("reserve", "malformed-state"));
          // A first build that failed for a retryable reason is tried once more; a quarantine a
          // person may have fixed is tried once more each time it is reopened.
          const replace =
            record?.state === "quarantined" &&
            record.publication === null &&
            record.claim === null &&
            ((record.buildAttempt === 1 &&
              nativeBuildRetryReasonSchema.safeParse(record.reason).success) ||
              (record.reopenedAt !== null &&
                nativeReopenReasonSchema.safeParse(record.reason).success));
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
                ...recordedWallet(wallet),
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
            return yield* Effect.fail(
              new NativeCatalogStoreError("reserve", "publication-removing"),
            );
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
            const [run] = yield* db
              .select()
              .from(boatRuns)
              .where(eq(boatRuns.runId, consumer.runtimeInstanceId))
              .limit(1);
            if (run !== undefined) {
              const [runtime] = yield* db
                .select()
                .from(workspaceRuntimeInstances)
                .where(eq(workspaceRuntimeInstances.runId, consumer.runId));
              const [tunnel] = yield* db
                .select()
                .from(boatTunnels)
                .where(eq(boatTunnels.runtimeInstanceId, consumer.runtimeInstanceId));
              const reservation = boatTunnelReservationSchema.safeParse(tunnel?.record);
              // The pin of a run that has a Boat row goes on one thing only: Boat's own word, on
              // that row, that it holds no VM for the run (its typed 404 for a VM seen past
              // creation, its completed deletion, or a create that was never issued or was
              // refused). Nothing of the VM can use the publication again, whatever the run's
              // runtime row says by now (the shared stop records that after the removal returns).
              // A run that had a tunnel releases its slot first, after host cleanup.
              if (
                run.absentAt === null ||
                run.publicationId !== publicationId ||
                (tunnel !== undefined &&
                  !(
                    reservation.success &&
                    reservation.data.released === true &&
                    tunnel.releasedAt !== null
                  )) ||
                runtime?.adapter !== "boat" ||
                runtime.resourceId !== run.sandboxId ||
                runtime.publicationId !== publicationId
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
      policy?: NativeRetentionPolicy,
    ) {
      const parsed = yield* Effect.try({
        try: () =>
          policy === undefined
            ? undefined
            : {
                wanted: new Set(
                  policy.wanted.map((key) => digest(nativePublicationKeySchema.parse(key))),
                ),
                unusedSince: instant(policy.unusedSince),
              },
        catch: () => new NativeCatalogStoreError("retire", "invalid-input"),
      });
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          if (parsed !== undefined) {
            // The account first, as reserve and removal take it: an account whose removal was
            // asked is left to that removal, which deletes every image it holds.
            const [owner] = yield* db
              .select({ deploymentId: publications.deploymentId })
              .from(publications)
              .where(eq(publications.id, id));
            if (owner === undefined) return undefined;
            const [account] = yield* db
              .select({ removalRequestedAt: boatAccounts.removalRequestedAt })
              .from(boatAccounts)
              .where(eq(boatAccounts.deploymentId, owner.deploymentId))
              .for("share");
            if (account !== undefined && account.removalRequestedAt !== null) return undefined;
          }
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
          if (parsed === undefined || parsed.wanted.has(row.keyHash)) return undefined;
          // A build of this image scope queued or running may be about to look this image up: its
          // spec was not read when the wanted keys were.
          const [inFlight] = yield* db
            .select({ id: ociImageBuildJobs.id })
            .from(ociImageBuildJobs)
            .where(
              and(
                sql`${ociImageBuildJobs.imageScope} = ${JSON.stringify(record.ownership.key.scope)}::jsonb`,
                inArray(ociImageBuildJobs.status, ["queued", "running"]),
              ),
            )
            .limit(1);
          if (inFlight !== undefined) return undefined;
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
                sql`${publications.readyAt} <= ${parsed.unusedSince}::timestamptz`,
                sql`not exists (select 1 from ${consumers} where ${consumers.publicationId} = ${publications.id} and (${consumers.createdAt} > ${parsed.unusedSince}::timestamptz or ${consumers.releasedAt} > ${parsed.unusedSince}::timestamptz))`,
              ),
            )
            .returning();
          return updated === undefined ? undefined : yield* parseRow(updated);
        }),
      );
    });
    const images = Effect.fn("NativePublicationRepo.images")(function* (input: {
      readonly deploymentId: string;
      readonly limit: number;
      readonly after?: string;
    }) {
      if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 200 ||
        (input.after !== undefined &&
          !nativePublicationSchema.shape.publicationId.safeParse(input.after).success)
      )
        return yield* Effect.fail(new NativeCatalogStoreError("images", "invalid-input"));
      // Retention removes an image with requests that name the wallet the account creates in now,
      // so it reads only the images recorded there. One recorded in another wallet is removed by a
      // client that names its own; one whose wallet is unknown or unreachable is never removed.
      const current = (yield* deploymentCreateWallet(db, input.deploymentId)).wallet;
      if (current.kind === "unresolved") return [];
      const rows = yield* db
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.deploymentId, input.deploymentId),
            input.after === undefined ? undefined : gt(publications.id, input.after),
            sql`(${publications.state} in ('ready','retiring') or (${publications.state} = 'quarantined' and ${publications.reason} = 'native-removal-pending'))`,
            inWallet(publications, current.wallet),
          ),
        )
        .orderBy(asc(publications.id))
        .limit(input.limit);
      return yield* Effect.forEach(rows, parseRow);
    });
    const wallet = Effect.fn("NativePublicationRepo.wallet")(function* (id: string) {
      const [row] = yield* db
        .select({ wallet: publications.boatWallet, state: publications.boatWalletState })
        .from(publications)
        .where(eq(publications.id, id));
      if (row === undefined) return undefined;
      return row.state === "known"
        ? ({ state: "known", wallet: row.wallet } as const)
        : row.state === "unreachable"
          ? ({ state: "unreachable" } as const)
          : ({ state: "unknown" } as const);
    });
    const startable = Effect.fn("NativePublicationRepo.startable")(function* (input: {
      readonly deploymentId: string;
      readonly stoppedSince: Date;
      readonly limit: number;
      readonly after?: string;
    }) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)
        return yield* Effect.fail(new NativeCatalogStoreError("startable", "invalid-input"));
      const stoppedSince = yield* Effect.try({
        try: () => instant(input.stoppedSince),
        catch: () => new NativeCatalogStoreError("startable", "invalid-input"),
      });
      // A stored account's deployment has its row; the install's own account has none, and its
      // workspaces name no account.
      const [account] = yield* db
        .select({ id: boatAccounts.id })
        .from(boatAccounts)
        .where(eq(boatAccounts.deploymentId, input.deploymentId));
      const accountOfSpec = sql`(${ociImageBuildJobs.requestPayload} -> 'runtime' ->> 'boatAccountId')`;
      const rows = yield* db
        .selectDistinctOn([workspaces.id], {
          workspaceId: workspaces.id,
          spec: ociImageBuildJobs.requestPayload,
          scope: ociImageBuildJobs.imageScope,
          adapter: workspaceRuntimeInstances.adapter,
        })
        .from(workspaces)
        .innerJoin(ociImageBuildJobs, eq(ociImageBuildJobs.runId, workspaces.latestRunId))
        .leftJoin(
          workspaceRuntimeInstances,
          eq(workspaceRuntimeInstances.runId, workspaces.latestRunId),
        )
        .where(
          and(
            isNull(workspaces.archivedAt),
            sql`${ociImageBuildJobs.imageScope} is not null`,
            account === undefined
              ? sql`${accountOfSpec} is null`
              : sql`${accountOfSpec} = ${account.id}`,
            sql`(${workspaces.status} not in ('stopped','failed') or ${workspaces.updatedAt} >= ${stoppedSince}::timestamptz)`,
            input.after === undefined ? undefined : gt(workspaces.id, input.after),
          ),
        )
        .orderBy(asc(workspaces.id), desc(ociImageBuildJobs.createdAt))
        .limit(input.limit);
      return rows;
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
      endedUnallocatedConsumers: (input) =>
        boundary(
          "endedUnallocatedConsumers",
          db
            .select({
              runId: consumers.runId,
              runtimeInstanceId: consumers.runtimeInstanceId,
              publicationId: consumers.publicationId,
            })
            .from(consumers)
            .innerJoin(publications, eq(publications.id, consumers.publicationId))
            .leftJoin(boatRuns, eq(boatRuns.runId, consumers.runtimeInstanceId))
            .leftJoin(
              workspaceRuntimeInstances,
              eq(workspaceRuntimeInstances.runId, consumers.runId),
            )
            .leftJoin(workspaceAttempts, eq(workspaceAttempts.id, consumers.runId))
            .where(
              and(
                eq(consumers.state, "pending"),
                eq(publications.deploymentId, input.deploymentId),
                isNull(boatRuns.runId),
                sql`(
                  (${workspaceRuntimeInstances.runId} is not null
                    and ${workspaceRuntimeInstances.status} in ('failed', 'stopped')
                    and (${workspaceRuntimeInstances.launchOwner} is null
                      or ${workspaceRuntimeInstances.launchLeaseExpiresAt} <= now()))
                  or (${workspaceRuntimeInstances.runId} is null
                    and ${workspaceAttempts.status} in ('failed', 'cancelled'))
                )`,
              ),
            )
            .orderBy(asc(consumers.runId))
            .limit(Math.max(1, Math.min(100, Math.round(input.limit))))
            .pipe(
              Effect.map((rows) =>
                rows.flatMap((row) => {
                  const consumer = nativeArtifactConsumerSchema.safeParse({
                    runId: row.runId,
                    runtimeInstanceId: row.runtimeInstanceId,
                  });
                  return consumer.success
                    ? [{ consumer: consumer.data, publicationId: row.publicationId }]
                    : [];
                }),
              ),
            ),
        ),
      candidates: (scope, limit, after) => boundary("candidates", candidates(scope, limit, after)),
      retire: (id, policy) => boundary("retire", retire(id, policy)),
      images: (input) => boundary("images", images(input)),
      startable: (input) => boundary("startable", startable(input)),
      wallet: (id) => boundary("wallet", wallet(id)),
      withdraw: (ownership) => boundary("withdraw", withdraw(ownership)),
      removed: (claim) => boundary("removed", removed(claim)),
      heldByDeployment: (input) =>
        boundary(
          "heldByDeployment",
          Effect.gen(function* () {
            if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)
              return yield* Effect.fail(
                new NativeCatalogStoreError("heldByDeployment", "invalid-input"),
              );
            const rows = yield* db
              .select()
              .from(publications)
              .where(
                and(
                  eq(publications.deploymentId, input.deploymentId),
                  sql`(${publications.state} in ('reserved','building','ready','retiring') or (${publications.state} = 'quarantined' and ${publications.reason} = 'native-removal-pending'))`,
                ),
              )
              .orderBy(asc(publications.createdAt), asc(publications.id))
              .limit(input.limit);
            return yield* Effect.forEach(rows, parseRow);
          }),
        ),
    });
  },
);

/** Infrastructure stays open so each composition root chooses its database. */
export const NativePublicationRepoLive: Layer.Layer<NativePublicationRepo, never, SealantDB> =
  Layer.effect(NativePublicationRepo, make);
