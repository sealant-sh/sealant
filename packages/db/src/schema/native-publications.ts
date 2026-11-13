import { sql } from "drizzle-orm";
import {
  check,
  index,
  foreignKey,
  integer,
  jsonb,
  primaryKey,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { workspaceAttempts } from "./control-plane.js";

/** Native-only ownership. OCI and MicroVM publication owners remain separate. */
export const nativePublications = snakeCase.table(
  "native_publications",
  {
    id: uuid().primaryKey(),
    buildId: uuid().notNull().unique(),
    buildAttempt: integer().notNull().default(1),
    replacesPublicationId: uuid().unique(),
    keyHash: text().notNull(),
    keyPayload: jsonb().$type<unknown>().notNull(),
    deploymentId: text().notNull(),
    scopeKind: text().notNull(),
    scopeId: text().notNull(),
    recipeHash: text().notNull(),
    state: text().notNull().default("reserved"),
    generation: integer().notNull().default(0),
    claimToken: uuid(),
    claimPurpose: text(),
    claimUntil: timestamp({ mode: "date", withTimezone: true }),
    publication: jsonb().$type<unknown>(),
    reason: text(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp({ mode: "date", withTimezone: true }),
    /**
     * Set on a quarantine whose Boat reason a person may have fixed, once the cause may have
     * cleared (a key rotation, a check that can start): the next launch replaces it with one build.
     */
    reopenedAt: timestamp({ mode: "date", withTimezone: true }),
    /**
     * The Boat wallet it was created in, named (`X-Boat-Org`) on every later request about it: an
     * organization's id or name, or `personal`; null with `boatWalletState` `known`: the key's only
     * wallet (an organization's key), named by no header. See `boatWalletState`.
     */
    boatWallet: text(),
    /**
     * `known`: `boatWallet` is where it is. `unknown`: made before sealant recorded wallets, by an
     * account with no pin; no request about it is made until sealant has found it. `unreachable`: sealant
     * looked under every wallet the key can bill and Boat has it in none: never removed or used.
     */
    boatWalletState: text().notNull().default("unknown"),
  },
  (table) => [
    // One image of a recipe per wallet: a launch uses only the one in the account's wallet, and
    // builds there when there is none. One sealant cannot reach is recorded, and in nobody's way;
    // so is one being removed (a duplicate an old image's location left, `locateImage`).
    uniqueIndex("native_publications_key_active")
      .on(table.keyHash, sql`coalesce(${table.boatWallet}, '')`)
      .where(
        sql`${table.state} not in ('removed','superseded','retiring') and ${table.boatWalletState} <> 'unreachable'`,
      ),
    check(
      "native_publications_wallet",
      sql`${table.boatWalletState} in ('known','unknown','unreachable') and (${table.boatWalletState} = 'known' or ${table.boatWallet} is null)`,
    ),
    index("native_publications_scope_retention").on(
      table.deploymentId,
      table.scopeKind,
      table.scopeId,
      table.state,
      table.createdAt,
    ),
    index("native_publications_reconcile").on(table.state, table.claimUntil),
    check(
      "native_publications_state",
      sql`${table.state} in ('reserved','building','ready','retiring','removed','quarantined','superseded')`,
    ),
    foreignKey({ columns: [table.replacesPublicationId], foreignColumns: [table.id] }),
    check(
      "native_publications_build_attempt",
      sql`(${table.buildAttempt} = 1 and ${table.replacesPublicationId} is null) or (${table.buildAttempt} = 2 and ${table.replacesPublicationId} is not null and ${table.replacesPublicationId} <> ${table.id})`,
    ),
    check("native_publications_generation", sql`${table.generation} >= 0`),
    check(
      "native_publications_claim",
      sql`(${table.claimToken} is null and ${table.claimUntil} is null and ${table.claimPurpose} is null) or (${table.claimToken} is not null and ${table.claimUntil} is not null and ${table.claimPurpose} is not null and ${table.claimPurpose} in ('build','reconcile','remove'))`,
    ),
    check("native_publications_scope", sql`${table.scopeKind} in ('owner','resource-domain')`),
    check(
      "native_publications_payload",
      sql`(${table.state} in ('reserved','building','superseded') and ${table.publication} is null) or (${table.state} in ('ready','retiring','removed') and ${table.publication} is not null) or ${table.state} = 'quarantined'`,
    ),
  ],
);

/** Release is explicit; deleting a run cannot silently discard its artifact pin. */
export const nativePublicationConsumers = snakeCase.table(
  "native_publication_consumers",
  {
    runId: text()
      .notNull()
      .references(() => workspaceAttempts.id, { onDelete: "restrict" }),
    runtimeInstanceId: text().notNull(),
    publicationId: uuid()
      .notNull()
      .references(() => nativePublications.id, { onDelete: "restrict" }),
    state: text().notNull().default("pending"),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp({ mode: "date", withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.runtimeInstanceId] }),
    index("native_publication_consumers_pin").on(table.publicationId, table.state),
    // The pins still held, by run: what Boat's convergence sweep reads to find a run whose pin is
    // not released, whatever the number of released ones.
    index("native_publication_consumers_held")
      .on(table.runId)
      .where(sql`${table.state} <> 'released'`),
    check(
      "native_publication_consumers_state",
      sql`${table.state} in ('pending','live','retained','unknown','released')`,
    ),
    check(
      "native_publication_consumers_instance",
      sql`${table.runId} = ${table.runtimeInstanceId}`,
    ),
    check(
      "native_publication_consumers_release",
      sql`(${table.state} = 'released') = (${table.releasedAt} is not null)`,
    ),
  ],
);
