import { sql } from "drizzle-orm";
import { check, jsonb, snakeCase, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { workspaceAttempts } from "./control-plane.js";

/** Sealed exchange and invocation ownership. A run cannot silently allocate a replacement disk. */
export const boatExecutions = snakeCase.table(
  "boat_executions",
  {
    runtimeInstanceId: text()
      .primaryKey()
      .references(() => workspaceAttempts.id, { onDelete: "restrict" }),
    deploymentId: text().notNull(),
    sandboxId: text().notNull(),
    diskLineage: text().notNull(),
    record: jsonb().$type<unknown>().notNull(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("boat_executions_sandbox").on(table.deploymentId, table.sandboxId),
    uniqueIndex("boat_executions_disk").on(table.deploymentId, table.diskLineage),
    check(
      "boat_executions_identity",
      sql`${table.record}->'target'->>'runtimeInstanceId' = ${table.runtimeInstanceId} and ${table.record}->'target'->>'deploymentId' = ${table.deploymentId} and ${table.record}->'target'->>'sandboxId' = ${table.sandboxId} and ${table.record}->'target'->>'diskLineage' = ${table.diskLineage}`,
    ),
  ],
);
