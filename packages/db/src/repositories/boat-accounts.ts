import { createHash, randomUUID } from "node:crypto";

import { NATIVE_REOPEN_BOAT_FAILURES } from "@sealant/validators";
import {
  and,
  asc,
  count,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import {
  boatAccounts,
  boatInstall,
  boatKeyProofs,
  boatKeyReports,
  boatLaunchReports,
  type BoatAccountRow,
} from "../schema/boat-accounts.js";
import { boatRuns } from "../schema/boat-runs.js";
import { nativePublications } from "../schema/native-publications.js";

/** Safe failure codes: never the key, its ciphertext or a provider body. */
export class BoatAccountStoreError extends Error {
  readonly _tag = "BoatAccountStoreError";
  constructor(
    readonly code:
      | "unavailable"
      | "invalid-record"
      | "not-found"
      | "removing"
      | "stale-revision"
      | "proof-outstanding",
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
  /** The Boat organization the account bills (`X-Boat-Org`); null: none named. */
  readonly organization: string | null;
  /**
   * A change of `organization` that was asked and is not finished (`organization`: the one to
   * bill once it is, null: none); null when none is under way.
   */
  readonly organizationChange: {
    readonly organization: string | null;
    readonly requestedAt: Date;
  } | null;
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
  /** The Boat organization every request for the account names; null: none. */
  readonly organization: string | null;
}

/** A key's last check report as stored: Boat's observations, never the key. */
export interface BoatKeyReportRecord {
  /** A stored account's id, or `default` for the install's own env key. */
  readonly account: string;
  readonly report: unknown;
  readonly observedAt: Date;
}

/** What one worker said it does for Boat, and when. */
export interface BoatLaunchReportRecord {
  /** The worker's id (`WORKER_ID`). */
  readonly worker: string;
  /** It launches Boat workspaces: its Boat adapter is registered. */
  readonly launches: boolean;
  /** It has the install's own Boat key, so a workspace that names no stored account can run. */
  readonly defaultAccount: boolean;
  /** It has the resource gateway, so a Boat workspace can reach its project's resources. */
  readonly resourceGateway: boolean;
  readonly observedAt: Date;
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

/**
 * What a request to change the organization an account bills found. `unchanged`: it already bills
 * that one (an unfinished change to another was called off). `changed`: it held nothing in Boat,
 * and bills the new one from now on. `pending`: it holds saved images in the wallet it bills now
 * (`imagesLeft`), which the worker deletes before it switches. `in-use`: it has runs whose VM Boat
 * may hold, image builds in flight or being cleaned up, or a full check that Boat may hold
 * something of; nothing was changed.
 */
export type BoatAccountOrganizationChange =
  | { readonly kind: "unchanged" | "changed"; readonly account: BoatAccountRecord }
  | { readonly kind: "pending"; readonly account: BoatAccountRecord; readonly imagesLeft: number }
  | {
      readonly kind: "in-use";
      readonly liveRuns: number;
      /** Runs whose VM is gone and whose settling (tunnels, pins, stops, captures) is not done. */
      readonly unsettledRuns: number;
      readonly buildsInFlight: number;
      readonly proofs: number;
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
    /** The Boat organization to bill on every request for the account. */
    readonly organization?: string;
  }) => Failing<BoatAccountRecord>;
  /** Replaces the key's last check report (`account`: an account id, or `default`). */
  readonly saveReport: (input: BoatKeyReportRecord) => Failing<void>;
  /**
   * The `sealant-deployment` label of the install's own account. Set once, the first time it is
   * asked for: to `preferred` (the operator's setting) when given, otherwise to a name Core makes.
   * Never changed afterwards; a caller with a setting uses its setting.
   */
  readonly installDeployment: (preferred: string | undefined) => Failing<string>;
  /** The same, for the `sealant-owner` of the saved images built in the install's own account. */
  readonly installBuilderOwner: (preferred: string | undefined) => Failing<string>;
  /** Replaces a worker's launch report, and forgets reports no worker renewed for a day. */
  /**
   * Replaces a worker's launch report, stamped with the database's own clock (or `observedAt`, for a
   * test), and forgets reports no worker renewed for a day.
   */
  readonly reportLaunch: (
    input: Omit<BoatLaunchReportRecord, "observedAt"> & { readonly observedAt?: Date },
  ) => Failing<void>;
  /** Every worker's launch report observed at or after `since`, newest first. */
  /**
   * Every worker's launch report observed within the last `withinMs`, by the database's own clock,
   * newest first: hosts with skewed clocks neither drop a live worker nor keep a dead one.
   */
  readonly launchReports: (withinMs: number) => Failing<readonly BoatLaunchReportRecord[]>;
  /**
   * The cause of a deployment's quarantined builds may have cleared (its account's key was rotated,
   * or a check of it can start): each one quarantined for a Boat reason a person fixes
   * (`NATIVE_REOPEN_BOAT_FAILURES`), not reopened yet, is reopened, so the next launch builds it once
   * more. Answers how many.
   */
  readonly reopenQuarantined: (input: {
    readonly deploymentId: string;
    readonly at: Date;
    /** Only these reasons (what a check shows cleared); absent: every one (a key rotation). */
    readonly reasons?: readonly (typeof NATIVE_REOPEN_BOAT_FAILURES)[number][];
  }) => Failing<number>;
  /** Every stored check report, by account (`default` for the env key). */
  readonly reports: () => Failing<ReadonlyMap<string, BoatKeyReportRecord>>;
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
  /**
   * Asks that the account bill `organization` (null: none named) from now on, as one statement
   * under the account's row, guarded on the organization the caller checked against (`expected`).
   * Refused while anything of the account may live in Boat outside its saved images; switched at
   * once when it holds nothing; otherwise left for the worker, which deletes its saved images
   * from the wallet it bills now and then finishes (`finishOrganizationChange`). Asking for the
   * organization it bills already calls off an unfinished change.
   */
  readonly requestOrganizationChange: (
    id: string,
    input: {
      readonly organization: string | null;
      readonly expected: string | null;
      /**
       * The account's runs not settled yet, as `BoatRunRepo.listUnsettled` reads them: the ones
       * whose VM's absence is committed are counted as runs still being settled.
       */
      readonly unsettled: readonly string[];
      /**
       * `organization` names the wallet the account bills already, by another name (Boat's id for
       * an organization stored by its name): it is relabelled at once, nothing held is in the way.
       */
      readonly sameWallet?: boolean;
    },
  ) => Failing<BoatAccountOrganizationChange>;
  /**
   * The change's end: the account bills the new organization, and its key revision grows, so every
   * process opens a client that names it. Only once Boat holds nothing Core made under the account,
   * read under its row as `finishRemoval` reads it. `held`: something is still there.
   */
  readonly finishOrganizationChange: (id: string) => Failing<"changed" | "held" | "none">;
  /** The accounts with a change of organization under way. */
  readonly listChangingOrganization: () => Failing<readonly BoatAccountRecord[]>;
  /** How many saved images the account may hold in Boat: the ones `heldImages` names. */
  readonly heldImageCount: (id: string) => Failing<number>;
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
  organization: row.boatOrganization,
  organizationChange:
    row.organizationChangeRequestedAt === null
      ? null
      : {
          organization: row.organizationChangeTarget,
          requestedAt: row.organizationChangeRequestedAt,
        },
  createdAt: row.createdAt,
  keyRotatedAt: row.keyRotatedAt,
  removalRequestedAt: row.removalRequestedAt,
  removedAt: row.removedAt,
});

/**
 * The account's full checks of its key that Boat may still hold something of: unfinished, or
 * finished with their cleanup pending (`boat_key_proofs`).
 */
const proofOutstanding = (id: string) =>
  sql`select 1 from ${boatKeyProofs} where ${boatKeyProofs.account} = ${id} and (${boatKeyProofs.finishedAt} is null or ${boatKeyProofs.cleanupPending})`;

/** Saved images Boat may hold of a deployment: in use, retiring, or their removal pending. */
const heldImage = sql`(${nativePublications.state} in ('ready','retiring') or (${nativePublications.state} = 'quarantined' and ${nativePublications.reason} = 'native-removal-pending'))`;
/** Image builds Boat may hold a VM or a save of: queued, building, or their cleanup pending. */
const imageBuildInFlight = sql`(${nativePublications.state} in ('reserved','building') or (${nativePublications.state} = 'quarantined' and ${nativePublications.reason} like 'native-cleanup-pending-%'))`;

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
        boatOrganization: input.organization ?? null,
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
        organization: boatAccounts.boatOrganization,
      })
      .from(boatAccounts)
      .where(and(eq(boatAccounts.id, id), isNull(boatAccounts.removedAt)));
    if (row === undefined || row.sealedKey === null || row.keyId === null) return undefined;
    return {
      sealedKey: row.sealedKey,
      keyId: row.keyId,
      keyRevision: row.keyRevision,
      organization: row.organization,
    };
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
          // A full check that Boat may still hold something of keeps the key that can clean it up.
          sql`not exists (${proofOutstanding(id)})`,
        ),
      )
      .returning();
    if (row !== undefined) return record(row);
    const now = yield* get(id);
    if (now === undefined || now.removedAt !== null)
      return yield* Effect.fail(new BoatAccountStoreError("not-found"));
    const [held] = yield* db
      .select({ value: count() })
      .from(boatKeyProofs)
      .where(
        and(
          eq(boatKeyProofs.account, id),
          or(isNull(boatKeyProofs.finishedAt), eq(boatKeyProofs.cleanupPending, true)),
        ),
      );
    if ((held?.value ?? 0) > 0)
      return yield* Effect.fail(new BoatAccountStoreError("proof-outstanding"));
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
        // An unfinished change of organization is called off: the account still names the wallet
        // its images are in, and its removal deletes them there.
        const [updated] = yield* db
          .update(boatAccounts)
          .set({
            removalRequestedAt: sql`now()`,
            organizationChangeRequestedAt: null,
            organizationChangeTarget: null,
          })
          .where(eq(boatAccounts.id, id))
          .returning();
        if (updated === undefined)
          return yield* Effect.fail(new BoatAccountStoreError("unavailable"));
        return { kind: "requested", account: record(updated) } as const;
      }),
    );
  });
  /** What of the account Boat may hold, read under its row: runs, builds, images, full checks. */
  const holdings = Effect.fn("BoatAccountRepo.holdings")(function* (row: BoatAccountRow) {
    const [runs] = yield* db
      .select({ value: count() })
      .from(boatRuns)
      .where(and(eq(boatRuns.accountId, row.id), isNull(boatRuns.absentAt)));
    const [builds] = yield* db
      .select({ value: count() })
      .from(nativePublications)
      .where(and(eq(nativePublications.deploymentId, row.deploymentId), imageBuildInFlight));
    const [images] = yield* db
      .select({ value: count() })
      .from(nativePublications)
      .where(and(eq(nativePublications.deploymentId, row.deploymentId), heldImage));
    const [proofs] = yield* db
      .select({ value: count() })
      .from(boatKeyProofs)
      .where(
        and(
          eq(boatKeyProofs.account, row.id),
          or(isNull(boatKeyProofs.finishedAt), eq(boatKeyProofs.cleanupPending, true)),
        ),
      );
    return {
      liveRuns: runs?.value ?? 0,
      buildsInFlight: builds?.value ?? 0,
      images: images?.value ?? 0,
      proofs: proofs?.value ?? 0,
    };
  });
  /** Switches the account to its new organization: the change is over. */
  const switchOrganization = (id: string, organization: string | null) =>
    db
      .update(boatAccounts)
      .set({
        boatOrganization: organization,
        organizationChangeRequestedAt: null,
        organizationChangeTarget: null,
        keyRevision: sql`${boatAccounts.keyRevision} + 1`,
      })
      .where(eq(boatAccounts.id, id))
      .returning();
  const requestOrganizationChange = Effect.fn("BoatAccountRepo.requestOrganizationChange")(
    function* (
      id: string,
      input: Parameters<BoatAccountRepoService["requestOrganizationChange"]>[1],
    ) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          // The row a run's or an image's reservation reads `for share`.
          const [row] = yield* db
            .select()
            .from(boatAccounts)
            .where(eq(boatAccounts.id, id))
            .for("update");
          if (row === undefined || row.removedAt !== null)
            return yield* Effect.fail(new BoatAccountStoreError("not-found"));
          if (row.removalRequestedAt !== null)
            return yield* Effect.fail(new BoatAccountStoreError("removing"));
          if (row.boatOrganization !== input.expected)
            return yield* Effect.fail(new BoatAccountStoreError("stale-revision"));
          if (row.boatOrganization === input.organization) {
            if (row.organizationChangeRequestedAt === null)
              return { kind: "unchanged", account: record(row) } as const;
            const [updated] = yield* db
              .update(boatAccounts)
              .set({ organizationChangeRequestedAt: null, organizationChangeTarget: null })
              .where(eq(boatAccounts.id, id))
              .returning();
            if (updated === undefined)
              return yield* Effect.fail(new BoatAccountStoreError("unavailable"));
            return { kind: "unchanged", account: record(updated) } as const;
          }
          if (input.sameWallet === true) {
            const [updated] = yield* switchOrganization(id, input.organization);
            if (updated === undefined)
              return yield* Effect.fail(new BoatAccountStoreError("unavailable"));
            return { kind: "changed", account: record(updated) } as const;
          }
          const held = yield* holdings(row);
          const live =
            input.unsettled.length === 0
              ? []
              : yield* db
                  .select({ runId: boatRuns.runId })
                  .from(boatRuns)
                  .where(
                    and(
                      eq(boatRuns.accountId, id),
                      isNull(boatRuns.absentAt),
                      inArray(boatRuns.runId, [...input.unsettled]),
                    ),
                  );
          const unsettledRuns = input.unsettled.length - live.length;
          if (held.liveRuns > 0 || unsettledRuns > 0 || held.buildsInFlight > 0 || held.proofs > 0)
            return {
              kind: "in-use",
              liveRuns: held.liveRuns,
              unsettledRuns,
              buildsInFlight: held.buildsInFlight,
              proofs: held.proofs,
            } as const;
          if (held.images === 0) {
            const [updated] = yield* switchOrganization(id, input.organization);
            if (updated === undefined)
              return yield* Effect.fail(new BoatAccountStoreError("unavailable"));
            return { kind: "changed", account: record(updated) } as const;
          }
          const [updated] = yield* db
            .update(boatAccounts)
            .set({
              organizationChangeTarget: input.organization,
              // A change under way that is pointed elsewhere keeps when it was first asked.
              organizationChangeRequestedAt: sql`coalesce(${boatAccounts.organizationChangeRequestedAt}, now())`,
            })
            .where(eq(boatAccounts.id, id))
            .returning();
          if (updated === undefined)
            return yield* Effect.fail(new BoatAccountStoreError("unavailable"));
          return { kind: "pending", account: record(updated), imagesLeft: held.images } as const;
        }),
      );
    },
  );
  const finishOrganizationChange = Effect.fn("BoatAccountRepo.finishOrganizationChange")(function* (
    id: string,
  ) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select()
          .from(boatAccounts)
          .where(eq(boatAccounts.id, id))
          .for("update");
        if (
          row === undefined ||
          row.removedAt !== null ||
          row.organizationChangeRequestedAt === null
        )
          return "none" as const;
        const held = yield* holdings(row);
        if (held.liveRuns > 0 || held.buildsInFlight > 0 || held.images > 0 || held.proofs > 0)
          return "held" as const;
        yield* switchOrganization(id, row.organizationChangeTarget);
        return "changed" as const;
      }),
    );
  });
  const listChangingOrganization = Effect.fn("BoatAccountRepo.listChangingOrganization")(
    function* () {
      const rows = yield* db
        .select()
        .from(boatAccounts)
        .where(
          and(
            isNotNull(boatAccounts.organizationChangeRequestedAt),
            isNull(boatAccounts.removedAt),
          ),
        )
        .orderBy(asc(boatAccounts.id));
      return rows.map(record);
    },
  );
  const heldImageCount = Effect.fn("BoatAccountRepo.heldImageCount")(function* (id: string) {
    const [row] = yield* db
      .select({ value: count() })
      .from(nativePublications)
      .innerJoin(boatAccounts, eq(boatAccounts.deploymentId, nativePublications.deploymentId))
      .where(and(eq(boatAccounts.id, id), heldImage));
    return row?.value ?? 0;
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
        const [proofs] = yield* db
          .select({ value: count() })
          .from(boatKeyProofs)
          .where(
            and(
              eq(boatKeyProofs.account, id),
              or(isNull(boatKeyProofs.finishedAt), eq(boatKeyProofs.cleanupPending, true)),
            ),
          );
        // Boat may still hold something under the key: it is not erased.
        if ((runs?.value ?? 0) > 0 || (images?.value ?? 0) > 0 || (proofs?.value ?? 0) > 0)
          return "held" as const;
        yield* db
          .update(boatAccounts)
          .set({ removedAt: sql`now()`, sealedKey: null, keyId: null })
          .where(eq(boatAccounts.id, id));
        return "removed" as const;
      }),
    );
  });
  const saveReport = Effect.fn("BoatAccountRepo.saveReport")(function* (
    input: BoatKeyReportRecord,
  ) {
    yield* db
      .insert(boatKeyReports)
      .values({ account: input.account, report: input.report, observedAt: input.observedAt })
      .onConflictDoUpdate({
        target: boatKeyReports.account,
        set: { report: input.report, observedAt: input.observedAt },
      });
  });
  const reports = Effect.fn("BoatAccountRepo.reports")(function* () {
    const rows = yield* db.select().from(boatKeyReports);
    return new Map(rows.map((row) => [row.account, row]));
  });
  const installDeployment = Effect.fn("BoatAccountRepo.installDeployment")(function* (
    preferred: string | undefined,
  ) {
    const [row] = yield* db
      .insert(boatInstall)
      .values({ id: "install", deploymentId: preferred ?? `sealant-install-${randomUUID()}` })
      .onConflictDoUpdate({
        target: boatInstall.id,
        set: { deploymentId: sql`coalesce(${boatInstall.deploymentId}, excluded.deployment_id)` },
      })
      .returning({ value: boatInstall.deploymentId });
    if (row?.value == null) return yield* Effect.fail(new BoatAccountStoreError("unavailable"));
    return row.value;
  });
  const installBuilderOwner = Effect.fn("BoatAccountRepo.installBuilderOwner")(function* (
    preferred: string | undefined,
  ) {
    const [row] = yield* db
      .insert(boatInstall)
      .values({ id: "install", builderOwner: preferred ?? randomUUID() })
      .onConflictDoUpdate({
        target: boatInstall.id,
        set: { builderOwner: sql`coalesce(${boatInstall.builderOwner}, excluded.builder_owner)` },
      })
      .returning({ value: boatInstall.builderOwner });
    if (row?.value == null) return yield* Effect.fail(new BoatAccountStoreError("unavailable"));
    return row.value;
  });
  const reportLaunch = Effect.fn("BoatAccountRepo.reportLaunch")(function* (
    input: Omit<BoatLaunchReportRecord, "observedAt"> & { readonly observedAt?: Date },
  ) {
    const values = {
      launches: input.launches,
      defaultAccount: input.defaultAccount,
      resourceGateway: input.resourceGateway,
      observedAt: input.observedAt ?? sql`now()`,
    };
    yield* db
      .insert(boatLaunchReports)
      .values({ worker: input.worker, ...values })
      .onConflictDoUpdate({ target: boatLaunchReports.worker, set: values });
    yield* db
      .delete(boatLaunchReports)
      .where(lt(boatLaunchReports.observedAt, sql`now() - interval '1 day'`));
  });
  const launchReports = Effect.fn("BoatAccountRepo.launchReports")(function* (withinMs: number) {
    const rows = yield* db
      .select()
      .from(boatLaunchReports)
      .where(
        gte(
          boatLaunchReports.observedAt,
          sql`now() - (${Math.max(0, Math.round(withinMs))} * interval '1 millisecond')`,
        ),
      )
      .orderBy(sql`${boatLaunchReports.observedAt} desc`);
    return rows.map(
      (row): BoatLaunchReportRecord => ({
        worker: row.worker,
        launches: row.launches,
        defaultAccount: row.defaultAccount,
        resourceGateway: row.resourceGateway,
        observedAt: row.observedAt,
      }),
    );
  });
  const reopenQuarantined = Effect.fn("BoatAccountRepo.reopenQuarantined")(function* (input: {
    readonly deploymentId: string;
    readonly at: Date;
    readonly reasons?: readonly (typeof NATIVE_REOPEN_BOAT_FAILURES)[number][];
  }) {
    const reasons = input.reasons ?? NATIVE_REOPEN_BOAT_FAILURES;
    if (reasons.length === 0) return 0;
    const rows = yield* db
      .update(nativePublications)
      .set({ reopenedAt: input.at })
      .where(
        and(
          eq(nativePublications.deploymentId, input.deploymentId),
          eq(nativePublications.state, "quarantined"),
          isNull(nativePublications.publication),
          isNull(nativePublications.claimToken),
          isNull(nativePublications.reopenedAt),
          // A build whose cleanup is still pending for the same cause is marked too: once its
          // sweep finishes the cleanup, the reason is the plain kind and the next launch builds.
          inArray(nativePublications.reason, [
            ...reasons,
            ...reasons.map((reason) => `native-cleanup-pending-${reason.slice("native-".length)}`),
          ]),
        ),
      )
      .returning({ id: nativePublications.id });
    return rows.length;
  });
  return BoatAccountRepo.of({
    create: (input) => boundary(create(input)),
    reopenQuarantined: (input) => boundary(reopenQuarantined(input)),
    installDeployment: (preferred) => boundary(installDeployment(preferred)),
    installBuilderOwner: (preferred) => boundary(installBuilderOwner(preferred)),
    reportLaunch: (input) => boundary(reportLaunch(input)),
    launchReports: (withinMs) => boundary(launchReports(withinMs)),
    saveReport: (input) => boundary(saveReport(input)),
    reports: () => boundary(reports()),
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
    requestOrganizationChange: (id, input) => boundary(requestOrganizationChange(id, input)),
    finishOrganizationChange: (id) => boundary(finishOrganizationChange(id)),
    listChangingOrganization: () => boundary(listChangingOrganization()),
    heldImageCount: (id) => boundary(heldImageCount(id)),
    listWithRuns: () => boundary(listWithRuns()),
    finishRemoval: (id) => boundary(finishRemoval(id)),
  });
});

/** Owns database statements and their guards. */
export const BoatAccountRepoLive: Layer.Layer<BoatAccountRepo, never, SealantDB> = Layer.effect(
  BoatAccountRepo,
  make,
);
