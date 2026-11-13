import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const instant = () => timestamp({ mode: "date", withTimezone: true });

/**
 * A Boat account an install stores beside its default one (the env key): a Boat API key, sealed at
 * rest, and the two names Core gives everything it makes in that account. Mend maps one to each
 * of its organizations; Core has no notion of organizations and knows only the account.
 *
 * `deployment_id` and `builder_owner` are derived from the account's id when it is stored and
 * never change: every VM and saved image Core makes under the key carries them, so two accounts
 * stored over the same real Boat account still never read each other's VMs.
 *
 * The key is never returned by any read. `key_revision` grows by one with every rotation, which is
 * how a process holding a client for the account learns that its key changed. Removal is two
 * steps: `removal_requested_at` stops every new use of the account, and once the worker has deleted
 * the saved images Core built in it, `removed_at` is set and the sealed key erased.
 */
export const boatAccounts = snakeCase.table(
  "boat_accounts",
  {
    id: uuid().primaryKey(),
    label: text().notNull(),
    deploymentId: text().notNull().unique(),
    builderOwner: uuid().notNull().unique(),
    /** `CredentialCipher` ciphertext of the Boat API key; null once the account is removed. */
    sealedKey: text(),
    keyId: text(),
    keyRevision: integer().notNull().default(1),
    /**
     * The Boat organization the account bills (its id or name, or `personal`), sent as
     * `X-Boat-Org` on every request for it; null: none named, so a personal key bills its active
     * wallet. Set when the account is stored, and changed only once the account holds nothing in
     * the wallet it billed (see `organization_change_requested_at`); every change bumps
     * `key_revision`, so every holder of a client opens one that names the new wallet.
     */
    boatOrganization: text(),
    /**
     * A change of `boat_organization` to `organization_change_target` (null: none named) was
     * asked and is not finished: the worker is deleting the account's saved images from the wallet
     * it bills now, with requests that still name it, and switches once none is left. Null: no
     * change is under way.
     */
    organizationChangeRequestedAt: instant(),
    organizationChangeTarget: text(),
    createdAt: instant().notNull().defaultNow(),
    keyRotatedAt: instant(),
    removalRequestedAt: instant(),
    removedAt: instant(),
  },
  (table) => [
    check(
      "boat_accounts_key",
      sql`(${table.removedAt} is null) = (${table.sealedKey} is not null and ${table.keyId} is not null)`,
    ),
    check(
      "boat_accounts_removal",
      sql`${table.removedAt} is null or ${table.removalRequestedAt} is not null`,
    ),
    check("boat_accounts_label", sql`length(${table.label}) between 1 and 200`),
    check(
      "boat_accounts_organization_change",
      sql`${table.organizationChangeTarget} is null or ${table.organizationChangeRequestedAt} is not null`,
    ),
  ],
);

export type BoatAccountRow = typeof boatAccounts.$inferSelect;

/**
 * The last report of each Boat key's check against Boat: a stored account's (`account` its id) or
 * the install's own env key's (`account` `default`). One row per key, replaced by every check. The
 * report holds only what Boat showed of the key, never the key or any part of it.
 */
export const boatKeyReports = snakeCase.table(
  "boat_key_reports",
  {
    account: text().primaryKey(),
    report: jsonb().notNull(),
    observedAt: instant().notNull(),
  },
  (table) => [
    check(
      "boat_key_reports_account",
      sql`${table.account} = 'default' or ${table.account} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
  ],
);

/**
 * The names Core gives everything it makes in the install's own Boat account (the env key's): the
 * `sealant-deployment` label and the `sealant-owner` of its saved images. One row (`id` is
 * `install`). Each name is set the first time a process needs it and never changes: to the value
 * the operator set (`SEALANT_BOAT_DEPLOYMENT_ID`, `SEALANT_BOAT_BUILDER_OWNER`) when there is one,
 * so an install that set them keeps them even after the settings are dropped, otherwise to one Core
 * makes. The API and the worker read the same row, so they always agree.
 */
export const boatInstall = snakeCase.table(
  "boat_install",
  {
    id: text().primaryKey(),
    deploymentId: text(),
    builderOwner: uuid(),
    createdAt: instant().notNull().defaultNow(),
  },
  (table) => [check("boat_install_one", sql`${table.id} = 'install'`)],
);

/**
 * What each worker says it does for Boat, written when it starts and again every minute: whether
 * it launches Boat workspaces, whether it has the install's own key (so a workspace that names no
 * stored account can run), and whether it has the resource gateway. The API answers "can this
 * install launch Boat" from the reports observed recently, so the two never disagree.
 */
export const boatLaunchReports = snakeCase.table("boat_launch_reports", {
  worker: text().primaryKey(),
  launches: boolean().notNull(),
  defaultAccount: boolean().notNull(),
  resourceGateway: boolean().notNull(),
  observedAt: instant().notNull(),
});

/**
 * Each full check of a Boat key (`prove`): a throwaway VM, a command, a published port and a saved
 * snapshot, all deleted again. The row is written before anything is created in Boat and names
 * what may be created (the VM's idempotency key and label, the snapshot's name), so whatever an
 * interrupted check made is found and deleted by the worker's sweep. `claimed_until`: while it is
 * ahead, the check is running and a second one of the same account is refused; once it has passed,
 * the sweep takes the check over. `cleanup_pending`: Boat may still hold the VM or the snapshot; a
 * second check of the account is refused until the sweep has removed them.
 */
export const boatKeyProofs = snakeCase.table(
  "boat_key_proofs",
  {
    id: uuid().primaryKey(),
    /** A stored account's id, or `default` for the install's own key. */
    account: text().notNull(),
    /** The `Idempotency-Key` of the VM create, and the value of its `sealant-key-proof` label. */
    createKey: uuid().notNull(),
    snapshotName: text().notNull(),
    startedAt: instant().notNull(),
    claimedUntil: instant().notNull(),
    /** Set just before the VM create is sent: from then on Boat may hold a VM of this check. */
    createIssuedAt: instant(),
    sandboxId: text(),
    /** Set just before the snapshot save is sent: from then on Boat may hold the snapshot. */
    saveIssuedAt: instant(),
    vmDeletedAt: instant(),
    snapshotDeletedAt: instant(),
    finishedAt: instant(),
    cleanupPending: boolean().notNull().default(false),
    result: jsonb(),
  },
  (table) => [
    uniqueIndex("boat_key_proofs_one_running")
      .on(table.account)
      .where(sql`${table.finishedAt} is null or ${table.cleanupPending}`),
  ],
);
