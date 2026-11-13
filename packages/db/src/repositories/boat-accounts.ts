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
  ne,
  or,
  sql,
  type SQL,
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
import { createWalletOf, inOtherWallet, inWallet } from "./boat-wallets.js";

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
  /** The `sealant-deployment` label of every VM and saved image sealant makes under the key. */
  readonly deploymentId: string;
  /** The `sealant-owner` of every saved image sealant builds under the key. */
  readonly builderOwner: string;
  readonly keyRevision: number;
  /** The Boat organization the account bills (`X-Boat-Org`); null: none named. */
  readonly organization: string | null;
  /**
   * What the key is, as a check observed it: `personal` (always pinned once resolved),
   * `organization` (one wallet: no pin), or null: not observed.
   */
  readonly keyKind: "personal" | "organization" | null;
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
  /** What the key is (`personal`, `organization`), or null: not observed. */
  readonly keyKind: string | null;
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
      /** Saved images sealant is building in the account right now. */
      readonly buildsInFlight: number;
    };

/**
 * What a request to change the organization an account bills found. `unchanged`: it names that
 * one already. `changed`: it names the new one from now on; its saved images stay recorded in the
 * wallet they were made in, and the worker removes them there. `in-use`: it has a run whose VM Boat
 * may hold, a run still being settled, an image build in flight or being cleaned up, or a full
 * check Boat may hold something of, each in the wallet it names now; nothing was changed.
 */
/** `account`: the stored account as it is now; absent for the install's own key. */
export type BoatAccountOrganizationChange = {
  readonly kind: "unchanged" | "changed";
  readonly account?: BoatAccountRecord;
};

/**
 * Whose objects: a stored account's, or the install's own key's (runs with no account, images of
 * its deployment, full checks of `default`).
 */
export type BoatWalletOwner =
  | { readonly accountId: string }
  | { readonly install: { readonly deploymentId: string } };

/**
 * One thing sealant made in Boat, as a request about it names it: a VM, a saved image, a VM's
 * deletion, a run (its create, before its VM is on record), or an image build.
 */
export type BoatObjectRef =
  | { readonly sandbox: string }
  | { readonly snapshot: string }
  | { readonly deletion: string }
  | { readonly run: string }
  | { readonly publication: string };

/**
 * The wallet a request about an object names: the one recorded for it (`known`; null: none, the
 * key's only wallet), not known yet (`unknown`: made before sealant recorded wallets), in none of
 * the wallets the key can bill (`unreachable`: never asked about again), or nothing of the owner's
 * names it (`unrecorded`: it is asked about in the wallet the owner creates in now).
 */
export type BoatObjectWallet =
  | { readonly kind: "known"; readonly wallet: string | null }
  | { readonly kind: "unknown" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "unrecorded" };

/** What an owner made in Boat that is in none of the wallets its key can bill. */
export interface BoatUnreachableObjects {
  readonly savedImages: readonly string[];
  readonly runs: readonly string[];
  readonly builds: readonly string[];
}

/**
 * What an owner may hold in Boat whose wallet sealant does not know, and what an earlier build
 * recorded unreachable that Boat's answers can settle now (`relook`).
 */
export interface BoatUnknownObjects {
  /** Runs Boat may hold a VM for; `sandboxId` null: a create whose VM is not on record yet. */
  readonly liveRuns: readonly { readonly runId: string; readonly sandboxId: string | null }[];
  /** Saved images, by snapshot name. */
  readonly images: readonly { readonly publicationId: string; readonly name: string }[];
  /** Image builds in flight or being cleaned up, by publication id. */
  readonly builds: readonly string[];
  /** Full checks Boat may hold a VM (by id, when known) or a snapshot of. */
  readonly proofs: readonly {
    readonly id: string;
    readonly sandboxId: string | null;
    readonly snapshotName: string | null;
  }[];
  /**
   * Rows recorded unreachable, looked at again under a complete wallet list: saved images not
   * removed, image builds Boat may still hold something of, and runs whose VM Boat had reported
   * past creation (a 404 for one never reported is not absence, `boat_runs`).
   */
  readonly relook: {
    readonly images: readonly { readonly publicationId: string; readonly name: string }[];
    readonly builds: readonly string[];
    readonly runs: readonly { readonly runId: string; readonly sandboxId: string }[];
  };
}

/**
 * Where sealant found an owner's objects, and the pin to give it. `wallet` null with `found`: the key's
 * only wallet. `unreachable`: Boat's answer placed it in none of the key's wallets without proving it
 * gone. `gone`: a key of the account that made it read it by id under every wallet of a complete
 * list and Boat has it under none, which proves it gone, since Boat answers a read by id whichever
 * wallet is named: an image is then recorded removed, and a run recorded unreachable is recorded
 * not found (`relook`).
 */
export interface BoatWalletResolution {
  readonly runs: readonly (
    | { readonly runId: string; readonly wallet: string | null }
    | { readonly runId: string; readonly unreachable: true }
    | { readonly runId: string; readonly gone: true }
  )[];
  readonly images: readonly (
    | { readonly publicationId: string; readonly wallet: string | null }
    | { readonly publicationId: string; readonly unreachable: true }
    | { readonly publicationId: string; readonly gone: true }
  )[];
  /** Image builds recorded unreachable to look at again: their wallet becomes unknown. */
  readonly builds?: readonly string[];
  readonly proofs: readonly (
    | { readonly id: string; readonly wallet: string | null }
    | { readonly id: string; readonly unreachable: true }
  )[];
  /**
   * The pin: an organization's id or `personal` for a personal key, null for an organization's.
   * Given only when every run Boat may hold a VM for was found in that wallet.
   */
  readonly pin?: {
    readonly organization: string | null;
    /** What the key is; null: Boat did not show it (the pin stands for either). */
    readonly keyKind: "personal" | "organization" | null;
  };
}

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
    /**
     * The wallet every request for the account names: an organization's id or `personal`; absent
     * for an organization's key. A personal key is always stored with one.
     */
    readonly organization?: string;
    /** What the key is, as its check observed it; null: not observed (then it is pinned). */
    readonly keyKind: "personal" | "organization" | null;
  }) => Failing<BoatAccountRecord>;
  /** Replaces the key's last check report (`account`: an account id, or `default`). */
  readonly saveReport: (input: BoatKeyReportRecord) => Failing<void>;
  /**
   * The `sealant-deployment` label of the install's own account. Set once, the first time it is
   * asked for: to `preferred` (the operator's setting) when given, otherwise to a name sealant
   * makes. Never changed afterwards; a caller with a setting uses its setting.
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
  /**
   * The VMs of the account's runs that Boat may still have: no absence committed, a VM on record,
   * with the wallet each was made in (undefined: not known).
   */
  readonly liveSandboxes: (id: string) => Failing<
    readonly {
      readonly runId: string;
      readonly sandboxId: string;
      readonly wallet: string | null | undefined;
    }[]
  >;
  /**
   * The names of the saved images sealant built in the account that Boat may still hold: the ones
   * launches use, and the ones retiring or whose removal is pending.
   */
  readonly heldImages: (id: string) => Failing<
    readonly {
      readonly name: string;
      /** The wallet it was made in (null: the key's only one); undefined: not known. */
      readonly wallet: string | null | undefined;
    }[]
  >;
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
  /** Records what the key is, as a check observed it. */
  readonly setKeyKind: (id: string, keyKind: "personal" | "organization") => Failing<void>;
  /**
   * Points the account at `organization`, as one statement under its row, guarded on the
   * organization the caller checked against (`expected`): what it makes from then on is made there,
   * and its key revision grows. Nothing it made before moves or waits: each VM, image, build and
   * full check stays recorded in the wallet it was made in, and every request about it names that
   * wallet. `install`: the same for the install's own key (`SEALANT_BOAT_ORGANIZATION` changed).
   */
  readonly changeOrganization: (
    owner: BoatWalletOwner,
    input: { readonly organization: string; readonly expected: string | null },
  ) => Failing<BoatAccountOrganizationChange>;
  /**
   * Image builds not finished (queued, building, or their cleanup pending) recorded in a wallet
   * other than the one the owner creates in now: reconciled with requests that name their own.
   */
  readonly buildsElsewhere: (
    owner: BoatWalletOwner,
  ) => Failing<readonly { readonly publicationId: string; readonly wallet: string | null }[]>;
  /**
   * Saved images recorded in a wallet other than the one the owner creates in now (ready,
   * retiring, or a removal pending): removed with requests that name their own wallet.
   */
  readonly imagesElsewhere: (owner: BoatWalletOwner) => Failing<
    readonly {
      readonly publicationId: string;
      readonly name: string;
      readonly wallet: string | null;
    }[]
  >;
  /**
   * What Boat has in none of the wallets the key can bill: saved images by snapshot name, runs by id,
   * image builds by publication id.
   */
  readonly unreachable: (owner: BoatWalletOwner) => Failing<BoatUnreachableObjects>;
  /** The install's own key's pin and kind; undefined before any process made its row. */
  readonly installWallet: () => Failing<
    { readonly organization: string | null; readonly keyKind: string | null } | undefined
  >;
  /**
   * Accounts the worker resolves: not removed, with no pin and a key not known to be an
   * organization's, or with objects whose wallet sealant does not know.
   */
  readonly listUnresolved: () => Failing<readonly BoatAccountRecord[]>;
  /** What the owner may hold in Boat whose wallet sealant does not know. */
  readonly unknownObjects: (owner: BoatWalletOwner) => Failing<BoatUnknownObjects>;
  /** The wallet a request about one of the owner's objects names (`BoatObjectWallet`). */
  readonly objectWallet: (owner: BoatWalletOwner, ref: BoatObjectRef) => Failing<BoatObjectWallet>;
  /**
   * Records where an object of unknown wallet was found, or that Boat has it in none of the wallets
   * the key can bill (`unreachable`: a run's VM is then absent on that basis, and nothing waits on
   * it), or that Boat's answers prove a saved image gone (`gone`: recorded removed). Only rows whose
   * wallet is still unknown change.
   */
  readonly recordObjectWallet: (
    owner: BoatWalletOwner,
    ref: BoatObjectRef,
    found: { readonly wallet: string | null } | "unreachable" | "gone",
  ) => Failing<void>;
  /**
   * Records where sealant found the owner's objects and, with `pin`, pins an owner not pinned yet,
   * as one statement under its row. The pin is for what the owner makes from then on: it waits for
   * nothing the owner made before, which keeps its own wallet, known or not.
   */
  readonly resolveWallets: (
    owner: BoatWalletOwner,
    resolution: BoatWalletResolution,
  ) => Failing<"pinned" | "recorded">;
  /** The accounts not removed that have ever had a run: the ones Boat's sweeps visit. */
  readonly listWithRuns: () => Failing<readonly BoatAccountRecord[]>;
  /**
   * The removal's end: the sealed key is erased. Only for an account whose removal was asked, and
   * only once Boat holds nothing sealant made under the key, as one statement under the account's
   * row reads it: no run whose VM's absence is not committed, no image reserved, building, held or
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
  keyKind: row.keyKind === "personal" || row.keyKind === "organization" ? row.keyKind : null,
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
  sql`select 1 from ${boatKeyProofs} where ${boatKeyProofs.account} = ${id} and (${boatKeyProofs.finishedAt} is null or ${boatKeyProofs.cleanupPending}) and ${boatKeyProofs.boatWalletState} <> 'unreachable'`;

/** Saved images Boat may hold of a deployment: in use, retiring, or their removal pending. */
const heldImage = sql`(${nativePublications.state} in ('ready','retiring') or (${nativePublications.state} = 'quarantined' and ${nativePublications.reason} = 'native-removal-pending'))`;
/** Image builds Boat may hold a VM or a save of: queued, building, or their cleanup pending. */
const imageBuildInFlight = sql`(${nativePublications.state} in ('reserved','building') or (${nativePublications.state} = 'quarantined' and ${nativePublications.reason} like 'native-cleanup-pending-%')) and ${nativePublications.boatWalletState} <> 'unreachable'`;

/** A saved image recorded unreachable that Boat may still hold: looked at again (`relook`). */
const unreachableImage = sql`${nativePublications.boatWalletState} = 'unreachable' and ${nativePublications.state} not in ('removed','superseded')`;
/** An image build recorded unreachable whose VM or save Boat may still hold. */
const unreachableBuild = sql`${nativePublications.boatWalletState} = 'unreachable' and (${nativePublications.state} in ('reserved','building') or (${nativePublications.state} = 'quarantined' and ${nativePublications.reason} like 'native-cleanup-pending-%'))`;
/**
 * A run recorded unreachable whose VM Boat had reported past creation: a 404 for it under every
 * wallet is Boat's word that the VM is gone (`boat_runs`).
 */
const unreachableSeenRun = sql`${boatRuns.absentBasis} = 'unreachable' and ${boatRuns.sandboxId} is not null and ${boatRuns.createdSeenAt} is not null`;
/** A saved image Boat's answers prove gone: recorded removed, wherever its wallet stood. */
const goneImage = {
  state: "removed",
  generation: sql`${nativePublications.generation} + 1`,
  claimToken: null,
  claimUntil: null,
  claimPurpose: null,
} as const;
/** The rows a gone image's record changes: a saved image Boat may have held. */
const goneImageRow = sql`${nativePublications.publication} is not null and ${nativePublications.state} in ('ready','retiring','quarantined')`;

/** The runs of an owner: a stored account's, or the install's own (no account). */
const ownedRuns = (owner: BoatWalletOwner) =>
  "accountId" in owner ? eq(boatRuns.accountId, owner.accountId) : isNull(boatRuns.accountId);
/** The account a full check of the owner's key is recorded under. */
const proofAccount = (owner: BoatWalletOwner) =>
  "accountId" in owner ? owner.accountId : "default";
/** A run whose VM Boat has in none of the key's wallets: absent on that basis, never asked again. */
const unreachableRun = {
  boatWallet: null,
  boatWalletState: "unreachable",
  absentAt: sql`now()`,
  absentBasis: "unreachable",
  heldReason: null,
  conflictingSandboxes: [],
  sealedLaunch: null,
  sealedExchange: null,
} as const;
/** A saved image's snapshot name, as its publication records it. */
const publicationName = sql<
  string | null
>`${nativePublications.publication}->'snapshot'->'identity'->>'name'`;

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
        keyKind: input.keyKind,
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
        keyKind: boatAccounts.keyKind,
      })
      .from(boatAccounts)
      .where(and(eq(boatAccounts.id, id), isNull(boatAccounts.removedAt)));
    if (row === undefined || row.sealedKey === null || row.keyId === null) return undefined;
    return {
      sealedKey: row.sealedKey,
      keyId: row.keyId,
      keyRevision: row.keyRevision,
      organization: row.organization,
      keyKind: row.keyKind,
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
      .select({
        runId: boatRuns.runId,
        sandboxId: boatRuns.sandboxId,
        wallet: boatRuns.boatWallet,
        walletState: boatRuns.boatWalletState,
      })
      .from(boatRuns)
      .where(
        and(eq(boatRuns.accountId, id), isNull(boatRuns.absentAt), isNotNull(boatRuns.sandboxId)),
      )
      .orderBy(asc(boatRuns.runId));
    return rows.flatMap((row) =>
      row.sandboxId === null
        ? []
        : [
            {
              runId: row.runId,
              sandboxId: row.sandboxId,
              wallet: row.walletState === "known" ? row.wallet : undefined,
            },
          ],
    );
  });
  const heldImages = Effect.fn("BoatAccountRepo.heldImages")(function* (id: string) {
    const rows = yield* db
      .select({
        name: sql<
          string | null
        >`${nativePublications.publication}->'snapshot'->'identity'->>'name'`,
        wallet: nativePublications.boatWallet,
        walletState: nativePublications.boatWalletState,
      })
      .from(nativePublications)
      .innerJoin(boatAccounts, eq(boatAccounts.deploymentId, nativePublications.deploymentId))
      .where(
        and(
          eq(boatAccounts.id, id),
          isNotNull(nativePublications.publication),
          heldImage,
          // One Boat has in no wallet the key can bill gates nothing (it is reported).
          sql`${nativePublications.boatWalletState} <> 'unreachable'`,
        ),
      )
      .orderBy(asc(nativePublications.id));
    return rows.flatMap((row) =>
      row.name === null
        ? []
        : [{ name: row.name, wallet: row.walletState === "known" ? row.wallet : undefined }],
    );
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
              sql`${nativePublications.boatWalletState} <> 'unreachable'`,
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
  const ownerDeployment = (owner: BoatWalletOwner) =>
    Effect.gen(function* () {
      if ("install" in owner) return owner.install.deploymentId;
      const [row] = yield* db
        .select({ deploymentId: boatAccounts.deploymentId })
        .from(boatAccounts)
        .where(eq(boatAccounts.id, owner.accountId));
      if (row === undefined) return yield* Effect.fail(new BoatAccountStoreError("not-found"));
      return row.deploymentId;
    });
  const outstandingProof = or(
    isNull(boatKeyProofs.finishedAt),
    eq(boatKeyProofs.cleanupPending, true),
  );

  /**
   * The owner's row, locked `for update` (the row a run's or an image's reservation reads `for
   * share`), with the wallet it creates in now.
   */
  const lockOwner = (owner: BoatWalletOwner) =>
    Effect.gen(function* () {
      if ("accountId" in owner) {
        const [row] = yield* db
          .select()
          .from(boatAccounts)
          .where(eq(boatAccounts.id, owner.accountId))
          .for("update");
        if (row === undefined || row.removedAt !== null)
          return yield* Effect.fail(new BoatAccountStoreError("not-found"));
        return { row, organization: row.boatOrganization, keyKind: row.keyKind } as const;
      }
      yield* db.insert(boatInstall).values({ id: "install" }).onConflictDoNothing();
      const [row] = yield* db
        .select()
        .from(boatInstall)
        .where(eq(boatInstall.id, "install"))
        .for("update");
      if (row === undefined) return yield* Effect.fail(new BoatAccountStoreError("unavailable"));
      return { row: undefined, organization: row.organization, keyKind: row.keyKind } as const;
    });

  const setKeyKind = Effect.fn("BoatAccountRepo.setKeyKind")(function* (
    id: string,
    keyKind: "personal" | "organization",
  ) {
    if (id === "default") {
      yield* db
        .insert(boatInstall)
        .values({ id: "install", keyKind })
        .onConflictDoUpdate({ target: boatInstall.id, set: { keyKind } });
      return;
    }
    yield* db.update(boatAccounts).set({ keyKind }).where(eq(boatAccounts.id, id));
  });

  const changeOrganization = Effect.fn("BoatAccountRepo.changeOrganization")(function* (
    owner: BoatWalletOwner,
    input: Parameters<BoatAccountRepoService["changeOrganization"]>[1],
  ) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const locked = yield* lockOwner(owner);
        if (locked.row !== undefined && locked.row.removalRequestedAt !== null)
          return yield* Effect.fail(new BoatAccountStoreError("removing"));
        if (locked.organization !== input.expected)
          return yield* Effect.fail(new BoatAccountStoreError("stale-revision"));
        if (locked.organization === input.organization)
          return locked.row === undefined
            ? ({ kind: "unchanged" } as const)
            : ({ kind: "unchanged", account: record(locked.row) } as const);
        if ("install" in owner) {
          yield* db
            .update(boatInstall)
            .set({ organization: input.organization })
            .where(eq(boatInstall.id, "install"));
          return { kind: "changed" } as const;
        }
        const [updated] = yield* db
          .update(boatAccounts)
          .set({
            boatOrganization: input.organization,
            keyRevision: sql`${boatAccounts.keyRevision} + 1`,
          })
          .where(eq(boatAccounts.id, owner.accountId))
          .returning();
        if (updated === undefined)
          return yield* Effect.fail(new BoatAccountStoreError("unavailable"));
        return { kind: "changed", account: record(updated) } as const;
      }),
    );
  });

  /** The wallet the owner creates in now, read without a lock. */
  const ownerWallet = (owner: BoatWalletOwner) =>
    Effect.gen(function* () {
      if ("accountId" in owner) {
        const [row] = yield* db
          .select({ organization: boatAccounts.boatOrganization, keyKind: boatAccounts.keyKind })
          .from(boatAccounts)
          .where(eq(boatAccounts.id, owner.accountId));
        return row === undefined ? undefined : createWalletOf(row.organization, row.keyKind);
      }
      const [row] = yield* db
        .select({ organization: boatInstall.organization, keyKind: boatInstall.keyKind })
        .from(boatInstall)
        .where(eq(boatInstall.id, "install"));
      return row === undefined ? undefined : createWalletOf(row.organization, row.keyKind);
    });

  const buildsElsewhere = Effect.fn("BoatAccountRepo.buildsElsewhere")(function* (
    owner: BoatWalletOwner,
  ) {
    const current = yield* ownerWallet(owner);
    if (current === undefined || current.kind === "unresolved") return [];
    const deploymentId = yield* ownerDeployment(owner);
    return yield* db
      .select({ publicationId: nativePublications.id, wallet: nativePublications.boatWallet })
      .from(nativePublications)
      .where(
        and(
          eq(nativePublications.deploymentId, deploymentId),
          imageBuildInFlight,
          inOtherWallet(nativePublications, current.wallet),
        ),
      )
      .orderBy(asc(nativePublications.id));
  });

  const imagesElsewhere = Effect.fn("BoatAccountRepo.imagesElsewhere")(function* (
    owner: BoatWalletOwner,
  ) {
    const current = yield* ownerWallet(owner);
    if (current === undefined || current.kind === "unresolved") return [];
    const deploymentId = yield* ownerDeployment(owner);
    const rows = yield* db
      .select({
        publicationId: nativePublications.id,
        name: sql<
          string | null
        >`${nativePublications.publication}->'snapshot'->'identity'->>'name'`,
        wallet: nativePublications.boatWallet,
      })
      .from(nativePublications)
      .where(
        and(
          eq(nativePublications.deploymentId, deploymentId),
          heldImage,
          inOtherWallet(nativePublications, current.wallet),
        ),
      )
      .orderBy(asc(nativePublications.id));
    return rows.flatMap((row) =>
      row.name === null
        ? []
        : [{ publicationId: row.publicationId, name: row.name, wallet: row.wallet }],
    );
  });

  const unreachable = Effect.fn("BoatAccountRepo.unreachable")(function* (owner: BoatWalletOwner) {
    const deploymentId = yield* ownerDeployment(owner);
    const images = yield* db
      .select({ id: nativePublications.id, name: publicationName })
      .from(nativePublications)
      .where(
        and(
          eq(nativePublications.deploymentId, deploymentId),
          eq(nativePublications.boatWalletState, "unreachable"),
          sql`${nativePublications.state} not in ('removed','superseded')`,
        ),
      )
      .orderBy(asc(nativePublications.id));
    const runs = yield* db
      .select({ runId: boatRuns.runId })
      .from(boatRuns)
      .where(and(ownedRuns(owner), eq(boatRuns.absentBasis, "unreachable")))
      .orderBy(asc(boatRuns.runId));
    return {
      savedImages: images.flatMap((row) => (row.name === null ? [] : [row.name])),
      runs: runs.map((row) => row.runId),
      builds: images.flatMap((row) => (row.name === null ? [row.id] : [])),
    } satisfies BoatUnreachableObjects;
  });

  const installWallet = Effect.fn("BoatAccountRepo.installWallet")(function* () {
    const [row] = yield* db
      .select({ organization: boatInstall.organization, keyKind: boatInstall.keyKind })
      .from(boatInstall)
      .where(eq(boatInstall.id, "install"));
    return row;
  });

  /** An owner's objects of unknown wallet that Boat may hold. */
  const unknownObjects = Effect.fn("BoatAccountRepo.unknownObjects")(function* (
    owner: BoatWalletOwner,
  ) {
    const deploymentId = yield* ownerDeployment(owner);
    const runs = yield* db
      .select({ runId: boatRuns.runId, sandboxId: boatRuns.sandboxId })
      .from(boatRuns)
      .where(
        and(ownedRuns(owner), isNull(boatRuns.absentAt), eq(boatRuns.boatWalletState, "unknown")),
      )
      .orderBy(asc(boatRuns.runId));
    const images = yield* db
      .select({
        publicationId: nativePublications.id,
        name: sql<
          string | null
        >`${nativePublications.publication}->'snapshot'->'identity'->>'name'`,
      })
      .from(nativePublications)
      .where(
        and(
          eq(nativePublications.deploymentId, deploymentId),
          eq(nativePublications.boatWalletState, "unknown"),
          isNotNull(nativePublications.publication),
          sql`${nativePublications.state} not in ('removed','superseded')`,
        ),
      )
      .orderBy(asc(nativePublications.id));
    const builds = yield* db
      .select({ id: nativePublications.id })
      .from(nativePublications)
      .where(
        and(
          eq(nativePublications.deploymentId, deploymentId),
          eq(nativePublications.boatWalletState, "unknown"),
          imageBuildInFlight,
        ),
      );
    const proofs = yield* db
      .select({
        id: boatKeyProofs.id,
        sandboxId: boatKeyProofs.sandboxId,
        createIssuedAt: boatKeyProofs.createIssuedAt,
        vmDeletedAt: boatKeyProofs.vmDeletedAt,
        snapshotName: boatKeyProofs.snapshotName,
        saveIssuedAt: boatKeyProofs.saveIssuedAt,
        snapshotDeletedAt: boatKeyProofs.snapshotDeletedAt,
      })
      .from(boatKeyProofs)
      .where(
        and(
          eq(boatKeyProofs.account, proofAccount(owner)),
          eq(boatKeyProofs.boatWalletState, "unknown"),
          outstandingProof,
        ),
      );
    const relookImages = yield* db
      .select({ publicationId: nativePublications.id, name: publicationName })
      .from(nativePublications)
      .where(
        and(
          eq(nativePublications.deploymentId, deploymentId),
          unreachableImage,
          isNotNull(nativePublications.publication),
        ),
      )
      .orderBy(asc(nativePublications.id));
    const relookBuilds = yield* db
      .select({ id: nativePublications.id })
      .from(nativePublications)
      .where(and(eq(nativePublications.deploymentId, deploymentId), unreachableBuild))
      .orderBy(asc(nativePublications.id));
    const relookRuns = yield* db
      .select({ runId: boatRuns.runId, sandboxId: boatRuns.sandboxId })
      .from(boatRuns)
      .where(and(ownedRuns(owner), unreachableSeenRun))
      .orderBy(asc(boatRuns.runId));
    return {
      liveRuns: runs,
      images: images.flatMap((row) =>
        row.name === null ? [] : [{ publicationId: row.publicationId, name: row.name }],
      ),
      relook: {
        images: relookImages.flatMap((row) =>
          row.name === null ? [] : [{ publicationId: row.publicationId, name: row.name }],
        ),
        builds: relookBuilds.map((row) => row.id),
        runs: relookRuns.flatMap((row) =>
          row.sandboxId === null ? [] : [{ runId: row.runId, sandboxId: row.sandboxId }],
        ),
      },
      builds: builds.map((row) => row.id),
      proofs: proofs.map((row) => ({
        id: row.id,
        sandboxId: row.createIssuedAt !== null && row.vmDeletedAt === null ? row.sandboxId : null,
        snapshotName:
          row.saveIssuedAt !== null && row.snapshotDeletedAt === null ? row.snapshotName : null,
      })),
    } satisfies BoatUnknownObjects;
  });

  /**
   * Records the wallet an image of unknown wallet was found in. If its recipe already has an image
   * there (one a launch built after the account was pinned), the found one is a saved image nobody
   * will launch from: it is recorded there as retiring, and removed under that wallet by the
   * removal retention runs. A build found there beside another is left as it is. Run under the
   * owner's row, which a reservation reads `for share`, so no image is reserved meanwhile.
   */
  const locateImage = (
    where: SQL | undefined,
    wallet: string | null,
    from: readonly ("unknown" | "unreachable")[] = ["unknown"],
  ) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          id: nativePublications.id,
          keyHash: nativePublications.keyHash,
          saved: isNotNull(nativePublications.publication),
        })
        .from(nativePublications)
        .where(and(where, inArray(nativePublications.boatWalletState, [...from])));
      for (const row of rows) {
        const [taken] = yield* db
          .select({ id: nativePublications.id })
          .from(nativePublications)
          .where(
            and(
              eq(nativePublications.keyHash, row.keyHash),
              ne(nativePublications.id, row.id),
              sql`${nativePublications.state} not in ('removed','superseded','retiring')`,
              inWallet(nativePublications, wallet),
            ),
          )
          .limit(1);
        if (taken !== undefined && !row.saved) continue;
        yield* db
          .update(nativePublications)
          .set({
            boatWallet: wallet,
            boatWalletState: "known",
            ...(taken === undefined
              ? {}
              : {
                  state: "retiring",
                  generation: sql`${nativePublications.generation} + 1`,
                  claimToken: null,
                  claimUntil: null,
                  claimPurpose: null,
                }),
          })
          .where(
            and(
              eq(nativePublications.id, row.id),
              inArray(nativePublications.boatWalletState, [...from]),
            ),
          );
      }
    });

  /** The rows of the owner's that name an object, per table. */
  const objectRows = (owner: BoatWalletOwner, ref: BoatObjectRef) =>
    Effect.gen(function* () {
      const deploymentId = yield* ownerDeployment(owner);
      const run =
        "sandbox" in ref
          ? eq(boatRuns.sandboxId, ref.sandbox)
          : "deletion" in ref
            ? eq(boatRuns.deletionOperationId, ref.deletion)
            : "run" in ref
              ? eq(boatRuns.runId, ref.run)
              : undefined;
      const proof =
        "sandbox" in ref
          ? eq(boatKeyProofs.sandboxId, ref.sandbox)
          : "snapshot" in ref
            ? eq(boatKeyProofs.snapshotName, ref.snapshot)
            : undefined;
      const image =
        "snapshot" in ref
          ? sql`${publicationName} = ${ref.snapshot}`
          : "publication" in ref
            ? eq(nativePublications.id, ref.publication)
            : undefined;
      return {
        runs: run === undefined ? undefined : and(run, ownedRuns(owner)),
        proofs:
          proof === undefined
            ? undefined
            : and(proof, eq(boatKeyProofs.account, proofAccount(owner))),
        images:
          image === undefined
            ? undefined
            : and(image, eq(nativePublications.deploymentId, deploymentId)),
      };
    });
  const objectWallet = Effect.fn("BoatAccountRepo.objectWallet")(function* (
    owner: BoatWalletOwner,
    ref: BoatObjectRef,
  ) {
    const where = yield* objectRows(owner, ref);
    const states: { readonly wallet: string | null; readonly state: string }[] = [
      ...(where.runs === undefined
        ? []
        : yield* db
            .select({ wallet: boatRuns.boatWallet, state: boatRuns.boatWalletState })
            .from(boatRuns)
            .where(where.runs)),
      ...(where.proofs === undefined
        ? []
        : yield* db
            .select({ wallet: boatKeyProofs.boatWallet, state: boatKeyProofs.boatWalletState })
            .from(boatKeyProofs)
            .where(where.proofs)),
      ...(where.images === undefined
        ? []
        : yield* db
            .select({
              wallet: nativePublications.boatWallet,
              state: nativePublications.boatWalletState,
            })
            .from(nativePublications)
            .where(where.images)),
    ];
    // One object, one wallet: the first row that knows it names it; else any row not knowing it.
    const known = states.find((each) => each.state === "known");
    if (known !== undefined) return { kind: "known", wallet: known.wallet } as const;
    if (states.some((each) => each.state === "unknown")) return { kind: "unknown" } as const;
    if (states.length > 0) return { kind: "unreachable" } as const;
    return { kind: "unrecorded" } as const;
  });
  const recordObjectWallet = Effect.fn("BoatAccountRepo.recordObjectWallet")(function* (
    owner: BoatWalletOwner,
    ref: BoatObjectRef,
    found: { readonly wallet: string | null } | "unreachable" | "gone",
  ) {
    const where = yield* objectRows(owner, ref);
    if (found === "gone") {
      // Only a saved image is recorded gone here; a run's VM is by its own 404 (`boat_runs`).
      if (where.images !== undefined)
        yield* db
          .update(nativePublications)
          .set(goneImage)
          .where(
            and(where.images, goneImageRow, eq(nativePublications.boatWalletState, "unknown")),
          );
      return;
    }
    const known = found === "unreachable" ? undefined : found.wallet;
    const set =
      found === "unreachable"
        ? ({ boatWallet: null, boatWalletState: "unreachable" } as const)
        : ({ boatWallet: known ?? null, boatWalletState: "known" } as const);
    yield* db.transaction(() =>
      Effect.gen(function* () {
        // The row a launch's reservation reads `for share`: no image is reserved meanwhile.
        yield* lockOwner(owner);
        if (where.runs !== undefined)
          yield* db
            .update(boatRuns)
            .set(found === "unreachable" ? unreachableRun : set)
            .where(
              and(
                where.runs,
                eq(boatRuns.boatWalletState, "unknown"),
                ...(found === "unreachable" ? [isNull(boatRuns.absentAt)] : []),
              ),
            );
        if (where.proofs !== undefined)
          yield* db
            .update(boatKeyProofs)
            .set(set)
            .where(and(where.proofs, eq(boatKeyProofs.boatWalletState, "unknown")));
        if (where.images !== undefined)
          yield* found === "unreachable"
            ? db
                .update(nativePublications)
                .set(set)
                .where(and(where.images, eq(nativePublications.boatWalletState, "unknown")))
            : locateImage(where.images, found.wallet);
      }),
    );
  });

  const listUnresolved = Effect.fn("BoatAccountRepo.listUnresolved")(function* () {
    const unknownRun = db
      .select({ one: sql`1` })
      .from(boatRuns)
      .where(
        and(
          eq(boatRuns.accountId, boatAccounts.id),
          isNull(boatRuns.absentAt),
          eq(boatRuns.boatWalletState, "unknown"),
        ),
      );
    const unknownImage = db
      .select({ one: sql`1` })
      .from(nativePublications)
      .where(
        and(
          eq(nativePublications.deploymentId, boatAccounts.deploymentId),
          eq(nativePublications.boatWalletState, "unknown"),
          sql`${nativePublications.state} not in ('removed','superseded')`,
        ),
      );
    const unknownProof = db
      .select({ one: sql`1` })
      .from(boatKeyProofs)
      .where(
        and(
          sql`${boatKeyProofs.account} = ${boatAccounts.id}::text`,
          eq(boatKeyProofs.boatWalletState, "unknown"),
          outstandingProof,
        ),
      );
    const relookImage = db
      .select({ one: sql`1` })
      .from(nativePublications)
      .where(
        and(
          eq(nativePublications.deploymentId, boatAccounts.deploymentId),
          or(unreachableImage, unreachableBuild),
        ),
      );
    const relookRun = db
      .select({ one: sql`1` })
      .from(boatRuns)
      .where(and(eq(boatRuns.accountId, boatAccounts.id), unreachableSeenRun));
    const rows = yield* db
      .select()
      .from(boatAccounts)
      .where(
        and(
          isNull(boatAccounts.removedAt),
          or(
            and(
              isNull(boatAccounts.boatOrganization),
              sql`${boatAccounts.keyKind} is distinct from 'organization'`,
            ),
            exists(unknownRun),
            exists(unknownImage),
            exists(unknownProof),
            exists(relookImage),
            exists(relookRun),
          ),
        ),
      )
      .orderBy(asc(boatAccounts.id));
    return rows.map(record);
  });

  const resolveWallets = Effect.fn("BoatAccountRepo.resolveWallets")(function* (
    owner: BoatWalletOwner,
    resolution: BoatWalletResolution,
  ) {
    const deploymentId = yield* ownerDeployment(owner);
    // Where each was found, onto rows whose wallet is still unknown: each object in a transaction
    // of its own under the owner's row, so one that cannot be recorded leaves the others recorded.
    const each = <A, E, R>(write: Effect.Effect<A, E, R>) =>
      db
        .transaction(() => Effect.flatMap(lockOwner(owner), () => write))
        .pipe(Effect.orElseSucceed(() => undefined));
    for (const run of resolution.runs)
      yield* each(
        "gone" in run
          ? // A VM Boat had reported past creation, read by id under every wallet and found under
            // none: Boat's word that it is gone, as its 404 under the recorded wallet is.
            db
              .update(boatRuns)
              .set({ absentBasis: "not-found" })
              .where(and(eq(boatRuns.runId, run.runId), ownedRuns(owner), unreachableSeenRun))
          : db
              .update(boatRuns)
              .set(
                "unreachable" in run
                  ? unreachableRun
                  : { boatWallet: run.wallet, boatWalletState: "known" },
              )
              .where(
                and(
                  eq(boatRuns.runId, run.runId),
                  ownedRuns(owner),
                  eq(boatRuns.boatWalletState, "unknown"),
                  isNull(boatRuns.absentAt),
                ),
              ),
      );
    for (const image of resolution.images) {
      const where = and(
        eq(nativePublications.id, image.publicationId),
        eq(nativePublications.deploymentId, deploymentId),
      );
      yield* each(
        "unreachable" in image
          ? db
              .update(nativePublications)
              .set({ boatWallet: null, boatWalletState: "unreachable" })
              .where(and(where, eq(nativePublications.boatWalletState, "unknown")))
          : "gone" in image
            ? db
                .update(nativePublications)
                .set(goneImage)
                .where(
                  and(
                    where,
                    goneImageRow,
                    inArray(nativePublications.boatWalletState, ["unknown", "unreachable"]),
                  ),
                )
            : locateImage(where, image.wallet, ["unknown", "unreachable"]),
      );
    }
    // A build recorded unreachable is looked for again, by its own catalog, as one never found.
    for (const publicationId of resolution.builds ?? [])
      yield* each(
        db
          .update(nativePublications)
          .set({ boatWallet: null, boatWalletState: "unknown" })
          .where(
            and(
              eq(nativePublications.id, publicationId),
              eq(nativePublications.deploymentId, deploymentId),
              unreachableBuild,
            ),
          ),
      );
    for (const proof of resolution.proofs)
      yield* each(
        db
          .update(boatKeyProofs)
          .set(
            "unreachable" in proof
              ? { boatWallet: null, boatWalletState: "unreachable" }
              : { boatWallet: proof.wallet, boatWalletState: "known" },
          )
          .where(
            and(
              eq(boatKeyProofs.id, proof.id),
              eq(boatKeyProofs.account, proofAccount(owner)),
              eq(boatKeyProofs.boatWalletState, "unknown"),
            ),
          ),
      );
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const locked = yield* lockOwner(owner);
        const pin = resolution.pin;
        if (pin === undefined) return "recorded" as const;
        if (createWalletOf(locked.organization, locked.keyKind).kind === "known")
          return "recorded" as const;
        // The pin is for what the account makes from now on. What it made before keeps its own
        // wallet, known or not, and is found one object at a time.
        if ("accountId" in owner)
          yield* db
            .update(boatAccounts)
            .set({
              boatOrganization: pin.organization,
              ...(pin.keyKind === null ? {} : { keyKind: pin.keyKind }),
              keyRevision: sql`${boatAccounts.keyRevision} + 1`,
            })
            .where(eq(boatAccounts.id, owner.accountId));
        else
          yield* db
            .update(boatInstall)
            .set({
              organization: pin.organization,
              ...(pin.keyKind === null ? {} : { keyKind: pin.keyKind }),
            })
            .where(eq(boatInstall.id, "install"));
        return "pinned" as const;
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
              // One Boat has in none of the key's wallets cannot be removed by sealant; it is reported,
              // and does not hold the removal.
              sql`${nativePublications.boatWalletState} <> 'unreachable'`,
            ),
          );
        const [proofs] = yield* db
          .select({ value: count() })
          .from(boatKeyProofs)
          .where(
            and(
              eq(boatKeyProofs.account, id),
              or(isNull(boatKeyProofs.finishedAt), eq(boatKeyProofs.cleanupPending, true)),
              ne(boatKeyProofs.boatWalletState, "unreachable"),
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
    setKeyKind: (id, keyKind) => boundary(setKeyKind(id, keyKind)),
    changeOrganization: (owner, input) => boundary(changeOrganization(owner, input)),
    buildsElsewhere: (owner) => boundary(buildsElsewhere(owner)),
    imagesElsewhere: (owner) => boundary(imagesElsewhere(owner)),
    unreachable: (owner) => boundary(unreachable(owner)),
    installWallet: () => boundary(installWallet()),
    listUnresolved: () => boundary(listUnresolved()),
    unknownObjects: (owner) => boundary(unknownObjects(owner)),
    objectWallet: (owner, ref) => boundary(objectWallet(owner, ref)),
    recordObjectWallet: (owner, ref, found) => boundary(recordObjectWallet(owner, ref, found)),
    resolveWallets: (owner, resolution) => boundary(resolveWallets(owner, resolution)),
    listWithRuns: () => boundary(listWithRuns()),
    finishRemoval: (id) => boundary(finishRemoval(id)),
  });
});

/** Owns database statements and their guards. */
export const BoatAccountRepoLive: Layer.Layer<BoatAccountRepo, never, SealantDB> = Layer.effect(
  BoatAccountRepo,
  make,
);
