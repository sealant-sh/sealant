import { sql } from "drizzle-orm";
import { check, integer, snakeCase, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
