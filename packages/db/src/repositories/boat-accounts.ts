import { createHash } from "node:crypto";

import { and, asc, count, eq, exists, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import { boatAccounts, type BoatAccountRow } from "../schema/boat-accounts.js";
import { boatRuns } from "../schema/boat-runs.js";
import { nativePublications } from "../schema/native-publications.js";

/** Safe failure codes: never the key, its ciphertext or a provider body. */
export class BoatAccountStoreError extends Error {
  readonly _tag = "BoatAccountStoreError";
  constructor(
    readonly code: "unavailable" | "invalid-record" | "not-found" | "removing" | "stale-revision",
  ) {
    super(`Boat account store: ${code}`);
  }
}

type Failing<A> = Effect.Effect<A, BoatAccountStoreError>;

/** A stored Boat account as every read but the key's own returns it: never the key. */
export interface BoatAccountRecord {
  readonly id: string;
  readonly label: string;
  /** The `sealant-deployment` label of every VM and saved image Core makes under the key. */
  readonly deploymentId: string;
  /** The `sealant-owner` of every saved image Core builds under the key. */
  readonly builderOwner: string;
  readonly keyRevision: number;
  readonly createdAt: Date;
  readonly keyRotatedAt: Date | null;
  readonly removalRequestedAt: Date | null;
  readonly removedAt: Date | null;
}

/** The account's sealed key, for the one process step that opens it into a client. */
export interface BoatAccountSealedKey {
  readonly sealedKey: string;
  readonly keyId: string;
  readonly keyRevision: number;
}

/** What a removal request found: done, or refused for what the account still has in Boat. */
export type BoatAccountRemovalRequest =
  | { readonly kind: "requested"; readonly account: BoatAccountRecord }
  | {
      readonly kind: "in-use";
      /** Runs whose VM Boat may still have under the key: no absence committed. */
      readonly liveRuns: number;
      /** Saved images Core is building in the account right now. */
      readonly buildsInFlight: number;
    };

/** The deployment label every VM and image of the account carries, from its id alone. */
export const boatAccountDeploymentId = (accountId: string) => `boat-account-${accountId}`;

/**
 * The builder owner of the account's saved images, from its id alone: a UUID (the builder accepts
 * only one) that no other account can have.
 */
export const boatAccountBuilderOwner = (accountId: string) => {
  const hex = createHash("sha256")
    .update(`sealant-boat-account-builder-owner:${accountId}`)
    .digest("hex");
  // RFC 9562 version 8 (custom), variant 10xx.
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * The install's stored Boat accounts. Nothing here calls Boat or opens a key: the API validates a
 * key with Boat before it stores one, and a worker opens the sealed key it reads.
 */
export interface BoatAccountRepoService {
  readonly create: (input: {
    readonly id: string;
    readonly label: string;
    readonly sealedKey: string;
    readonly keyId: string;
  }) => Failing<BoatAccountRecord>;
  /** The account whatever its state, removed included; never its key. */
  readonly get: (id: string) => Failing<BoatAccountRecord | undefined>;
  /** The account a deployment label belongs to, removed included. */
  readonly getByDeployment: (deploymentId: string) => Failing<BoatAccountRecord | undefined>;
  /** Every account not removed, oldest first. */
  readonly list: () => Failing<readonly BoatAccountRecord[]>;
  /** The sealed key of an account not removed; undefined once it is removed, or unknown. */
  readonly sealedKey: (id: string) => Failing<BoatAccountSealedKey | undefined>;
  /** The key's revision, read without the key: how a holder of a client learns of a rotation. */
  readonly keyRevision: (id: string) => Failing<number | undefined>;
  /**
   * Replaces the key of an account that is in use and not being removed, guarded on the revision
   * the caller checked the new key against: of two rotations at once, one writes.
   */
  readonly rotate: (
    id: string,
    input: { readonly sealedKey: string; readonly keyId: string; readonly revision: number },
  ) => Failing<BoatAccountRecord>;
  /** The VMs of the account's runs that Boat may still have: no absence committed, a VM on record. */
  readonly liveSandboxes: (
    id: string,
  ) => Failing<readonly { readonly runId: string; readonly sandboxId: string }[]>;
  /**
   * The names of the saved images Core built in the account that Boat may still hold: the ones
   * launches use, and the ones retiring or whose removal is pending.
   */
  readonly heldImages: (id: string) => Failing<readonly string[]>;
  /**
   * The account's runs whose create was issued and whose VM is not on record yet: Boat may hold a
   * VM for them that only the key they were created under can find.
   */
  readonly unresolvedCreates: (id: string) => Failing<number>;
  /**
   * Stops every new use of the account, unless it still has runs Boat may hold a VM for or an
   * image build in flight; then it says how many and changes nothing. Serialized with a run's
   * reservation under the account (which takes the same row), so no run is reserved after it.
   */
  readonly requestRemoval: (id: string) => Failing<BoatAccountRemovalRequest>;
  /** The accounts a removal was asked for and not finished. */
  readonly listRemoving: () => Failing<readonly BoatAccountRecord[]>;
  /** The accounts not removed that have ever had a run: the ones Boat's sweeps visit. */
  readonly listWithRuns: () => Failing<readonly BoatAccountRecord[]>;
  /**
   * The removal's end: the sealed key is erased. Only for an account whose removal was asked, and
   * only once Boat holds nothing Core made under the key, as one statement under the account's row
   * reads it: no run whose VM's absence is not committed, no image reserved, building, held or
   * pending removal. `held`: something is still there, and nothing was changed.
   */
  readonly finishRemoval: (id: string) => Failing<"removed" | "held">;
}

export class BoatAccountRepo extends Context.Service<BoatAccountRepo, BoatAccountRepoService>()(
  "@sealant/db/BoatAccountRepo",
) {}

const record = (row: BoatAccountRow): BoatAccountRecord => ({
  id: row.id,
  label: row.label,
  deploymentId: row.deploymentId,
  builderOwner: row.builderOwner,
  keyRevision: row.keyRevision,
  createdAt: row.createdAt,
  keyRotatedAt: row.keyRotatedAt,
  removalRequestedAt: row.removalRequestedAt,
  removedAt: row.removedAt,
});

const make: Effect.Effect<BoatAccountRepoService, never, SealantDB> = Effect.gen(function* () {
  const db = yield* SealantDB;
  const boundary = <A>(effect: Effect.Effect<A, unknown>): Failing<A> =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof BoatAccountStoreError ? error : new BoatAccountStoreError("unavailable"),
      ),
    );
  const one = (rows: readonly BoatAccountRow[]) =>
    rows[0] === undefined ? undefined : record(rows[0]);

  const create = Effect.fn("BoatAccountRepo.create")(function* (
    input: Parameters<BoatAccountRepoService["create"]>[0],
  ) {
    const label = input.label.trim();
    if (label.length === 0 || label.length > 200)
      return yield* Effect.fail(new BoatAccountStoreError("invalid-record"));
    const [row] = yield* db
      .insert(boatAccounts)
      .values({
        id: input.id,
        label,
        deploymentId: boatAccountDeploymentId(input.id),
        builderOwner: boatAccountBuilderOwner(input.id),
        sealedKey: input.sealedKey,
        keyId: input.keyId,
      })
      .returning();
    if (row === undefined) return yield* Effect.fail(new BoatAccountStoreError("unavailable"));
    return record(row);
  });
  const get = Effect.fn("BoatAccountRepo.get")(function* (id: string) {
    return one(yield* db.select().from(boatAccounts).where(eq(boatAccounts.id, id)));
  });
  const getByDeployment = Effect.fn("BoatAccountRepo.getByDeployment")(function* (
    deploymentId: string,
  ) {
    return one(
      yield* db.select().from(boatAccounts).where(eq(boatAccounts.deploymentId, deploymentId)),
    );
  });
  const list = Effect.fn("BoatAccountRepo.list")(function* () {
    const rows = yield* db
      .select()
      .from(boatAccounts)
      .where(isNull(boatAccounts.removedAt))
      .orderBy(asc(boatAccounts.createdAt), asc(boatAccounts.id));
    return rows.map(record);
  });
  const sealedKey = Effect.fn("BoatAccountRepo.sealedKey")(function* (id: string) {
    const [row] = yield* db
      .select({
        sealedKey: boatAccounts.sealedKey,
        keyId: boatAccounts.keyId,
        keyRevision: boatAccounts.keyRevision,
      })
      .from(boatAccounts)
      .where(and(eq(boatAccounts.id, id), isNull(boatAccounts.removedAt)));
    if (row === undefined || row.sealedKey === null || row.keyId === null) return undefined;
    return { sealedKey: row.sealedKey, keyId: row.keyId, keyRevision: row.keyRevision };
  });
  const keyRevision = Effect.fn("BoatAccountRepo.keyRevision")(function* (id: string) {
    const [row] = yield* db
      .select({ keyRevision: boatAccounts.keyRevision })
      .from(boatAccounts)
      .where(and(eq(boatAccounts.id, id), isNull(boatAccounts.removedAt)));
    return row?.keyRevision;
  });
  const rotate = Effect.fn("BoatAccountRepo.rotate")(function* (
    id: string,
    input: Parameters<BoatAccountRepoService["rotate"]>[1],
  ) {
    const [row] = yield* db
      .update(boatAccounts)
      .set({
        sealedKey: input.sealedKey,
        keyId: input.keyId,
        keyRevision: sql`${boatAccounts.keyRevision} + 1`,
        keyRotatedAt: sql`now()`,
      })
      .where(
        and(
          eq(boatAccounts.id, id),
          eq(boatAccounts.keyRevision, input.revision),
          isNull(boatAccounts.removalRequestedAt),
        ),
      )
      .returning();
    if (row !== undefined) return record(row);
    const now = yield* get(id);
    if (now === undefined || now.removedAt !== null)
      return yield* Effect.fail(new BoatAccountStoreError("not-found"));
    return yield* Effect.fail(
      new BoatAccountStoreError(now.removalRequestedAt === null ? "stale-revision" : "removing"),
    );
  });
  const liveSandboxes = Effect.fn("BoatAccountRepo.liveSandboxes")(function* (id: string) {
    const rows = yield* db
      .select({ runId: boatRuns.runId, sandboxId: boatRuns.sandboxId })
      .from(boatRuns)
      .where(
        and(eq(boatRuns.accountId, id), isNull(boatRuns.absentAt), isNotNull(boatRuns.sandboxId)),
      )
      .orderBy(asc(boatRuns.runId));
    return rows.flatMap((row) =>
      row.sandboxId === null ? [] : [{ runId: row.runId, sandboxId: row.sandboxId }],
    );
  });
  const heldImages = Effect.fn("BoatAccountRepo.heldImages")(function* (id: string) {
    const rows = yield* db
      .select({
        name: sql<
          string | null
        >`${nativePublications.publication}->'snapshot'->'identity'->>'name'`,
      })
      .from(nativePublications)
      .innerJoin(boatAccounts, eq(boatAccounts.deploymentId, nativePublications.deploymentId))
      .where(
        and(
          eq(boatAccounts.id, id),
          isNotNull(nativePublications.publication),
          sql`(${nativePublications.state} in ('ready','retiring') or (${nativePublications.state} = 'quarantined' and ${nativePublications.reason} = 'native-removal-pending'))`,
        ),
      )
      .orderBy(asc(nativePublications.id));
    return rows.flatMap((row) => (row.name === null ? [] : [row.name]));
  });
  const unresolvedCreates = Effect.fn("BoatAccountRepo.unresolvedCreates")(function* (id: string) {
    const [row] = yield* db
      .select({ value: count() })
      .from(boatRuns)
      .where(
        and(
          eq(boatRuns.accountId, id),
          isNull(boatRuns.absentAt),
          isNull(boatRuns.sandboxId),
          isNotNull(boatRuns.createIssuedAt),
        ),
      );
    return row?.value ?? 0;
  });
  const requestRemoval = Effect.fn("BoatAccountRepo.requestRemoval")(function* (id: string) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        // The same row a reservation under the account reads `for share`: one of the two waits.
        const [row] = yield* db
          .select()
          .from(boatAccounts)
          .where(eq(boatAccounts.id, id))
          .for("update");
        if (row === undefined || row.removedAt !== null)
          return yield* Effect.fail(new BoatAccountStoreError("not-found"));
        const [runs] = yield* db
          .select({ value: count() })
          .from(boatRuns)
          .where(and(eq(boatRuns.accountId, id), isNull(boatRuns.absentAt)));
        const [builds] = yield* db
          .select({ value: count() })
          .from(nativePublications)
          .where(
            and(
              eq(nativePublications.deploymentId, row.deploymentId),
              inArray(nativePublications.state, ["reserved", "building"]),
            ),
          );
        const liveRuns = runs?.value ?? 0;
        const buildsInFlight = builds?.value ?? 0;
        if (liveRuns > 0 || buildsInFlight > 0)
          return { kind: "in-use", liveRuns, buildsInFlight } as const;
        if (row.removalRequestedAt !== null)
          return { kind: "requested", account: record(row) } as const;
        const [updated] = yield* db
          .update(boatAccounts)
          .set({ removalRequestedAt: sql`now()` })
          .where(eq(boatAccounts.id, id))
          .returning();
        if (updated === undefined)
          return yield* Effect.fail(new BoatAccountStoreError("unavailable"));
        return { kind: "requested", account: record(updated) } as const;
      }),
    );
  });
  const listRemoving = Effect.fn("BoatAccountRepo.listRemoving")(function* () {
    const rows = yield* db
      .select()
      .from(boatAccounts)
      .where(and(isNotNull(boatAccounts.removalRequestedAt), isNull(boatAccounts.removedAt)))
      .orderBy(asc(boatAccounts.id));
    return rows.map(record);
  });
  const listWithRuns = Effect.fn("BoatAccountRepo.listWithRuns")(function* () {
    const rows = yield* db
      .select()
      .from(boatAccounts)
      .where(
        and(
          isNull(boatAccounts.removedAt),
          exists(
            db
              .select({ one: sql`1` })
              .from(boatRuns)
              .where(eq(boatRuns.accountId, boatAccounts.id)),
          ),
        ),
      )
      .orderBy(asc(boatAccounts.id));
    return rows.map(record);
  });
  const finishRemoval = Effect.fn("BoatAccountRepo.finishRemoval")(function* (id: string) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        // The row a run's or an image's reservation reads `for share`: nothing new can be
        // reserved under the account while this decides.
        const [row] = yield* db
          .select()
          .from(boatAccounts)
          .where(eq(boatAccounts.id, id))
          .for("update");
        if (row?.removedAt != null) return "removed" as const;
        if (row === undefined || row.removalRequestedAt === null)
          return yield* Effect.fail(new BoatAccountStoreError("not-found"));
        const [runs] = yield* db
          .select({ value: count() })
          .from(boatRuns)
          .where(and(eq(boatRuns.accountId, id), isNull(boatRuns.absentAt)));
        const [images] = yield* db
          .select({ value: count() })
          .from(nativePublications)
          .where(
            and(
              eq(nativePublications.deploymentId, row.deploymentId),
              sql`(${nativePublications.state} in ('reserved','building','ready','retiring') or (${nativePublications.state} = 'quarantined' and ${nativePublications.reason} = 'native-removal-pending'))`,
            ),
          );
        // Boat may still hold something under the key: it is not erased.
        if ((runs?.value ?? 0) > 0 || (images?.value ?? 0) > 0) return "held" as const;
        yield* db
          .update(boatAccounts)
          .set({ removedAt: sql`now()`, sealedKey: null, keyId: null })
          .where(eq(boatAccounts.id, id));
        return "removed" as const;
      }),
    );
  });
  return BoatAccountRepo.of({
    create: (input) => boundary(create(input)),
    get: (id) => boundary(get(id)),
    getByDeployment: (deploymentId) => boundary(getByDeployment(deploymentId)),
    list: () => boundary(list()),
    sealedKey: (id) => boundary(sealedKey(id)),
    keyRevision: (id) => boundary(keyRevision(id)),
    rotate: (id, input) => boundary(rotate(id, input)),
    liveSandboxes: (id) => boundary(liveSandboxes(id)),
    heldImages: (id) => boundary(heldImages(id)),
    unresolvedCreates: (id) => boundary(unresolvedCreates(id)),
    requestRemoval: (id) => boundary(requestRemoval(id)),
    listRemoving: () => boundary(listRemoving()),
    listWithRuns: () => boundary(listWithRuns()),
    finishRemoval: (id) => boundary(finishRemoval(id)),
  });
});

/** Owns database statements and their guards. */
export const BoatAccountRepoLive: Layer.Layer<BoatAccountRepo, never, SealantDB> = Layer.effect(
  BoatAccountRepo,
  make,
);
