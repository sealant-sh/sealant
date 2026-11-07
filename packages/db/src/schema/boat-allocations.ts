import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { workspaceAttempts } from "./control-plane.js";
import { nativePublications } from "./native-publications.js";

/** An unresolved allocation outlives job claims and prevents release of its publication pin. */
export const boatAllocations = snakeCase.table(
  "boat_allocations",
  {
    runtimeInstanceId: text()
      .primaryKey()
      .references(() => workspaceAttempts.id, { onDelete: "restrict" }),
    deploymentId: text().notNull(),
    publicationId: uuid()
      .notNull()
      .references(() => nativePublications.id, { onDelete: "restrict" }),
    idempotencyKey: uuid().notNull().unique(),
    diskLineage: uuid().notNull().unique(),
    sandboxId: text(),
    record: jsonb().$type<unknown>().notNull(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("boat_allocations_sandbox").on(table.deploymentId, table.sandboxId),
    index("boat_allocations_reconcile").on(table.deploymentId, table.runtimeInstanceId),
    check(
      "boat_allocations_identity",
      sql`${table.record}->'input'->'consumer'->>'runtimeInstanceId' = ${table.runtimeInstanceId} and ${table.record}->'input'->>'deploymentId' = ${table.deploymentId} and ${table.record}->'input'->'publication'->>'publicationId' = ${table.publicationId}::text and ${table.record}->>'idempotencyKey' = ${table.idempotencyKey}::text and ${table.record}->>'diskLineage' = ${table.diskLineage}::text and (${table.record}->>'sandboxId') is not distinct from ${table.sandboxId}`,
    ),
  ],
);
