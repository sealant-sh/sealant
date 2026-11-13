import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  snakeCase,
  text,
  timestamp,
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
     * The Boat organization the account bills (its id or name), sent as `X-Boat-Org` on every
     * request for it; null: none named, so a personal key bills its active wallet. Set when the
     * account is stored and never changed.
     */
    boatOrganization: text(),
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
