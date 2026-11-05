import { sql } from "drizzle-orm";
import {
  check,
  index,
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
  },
  (table) => [
    uniqueIndex("native_publications_key_active")
      .on(table.keyHash)
      .where(sql`${table.state} <> 'removed'`),
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
      sql`${table.state} in ('reserved','building','ready','retiring','removed','quarantined')`,
    ),
    check("native_publications_generation", sql`${table.generation} >= 0`),
    check(
      "native_publications_claim",
      sql`(${table.claimToken} is null and ${table.claimUntil} is null and ${table.claimPurpose} is null) or (${table.claimToken} is not null and ${table.claimUntil} is not null and ${table.claimPurpose} is not null and ${table.claimPurpose} in ('build','reconcile','remove'))`,
    ),
    check("native_publications_scope", sql`${table.scopeKind} in ('owner','resource-domain')`),
    check(
      "native_publications_payload",
      sql`(${table.state} in ('reserved','building') and ${table.publication} is null) or (${table.state} in ('ready','retiring','removed') and ${table.publication} is not null) or ${table.state} = 'quarantined'`,
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
