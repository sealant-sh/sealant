import { sql } from "drizzle-orm";
import { check, snakeCase, text, timestamp } from "drizzle-orm/pg-core";

import { workspaceAttempts } from "./control-plane.js";

/**
 * What Boat itself last said about one launch's VM, kept apart from desired state (the runtime's
 * stop reason), launch outcome (the attempt and its error code) and capture durability (the drain).
 * Only the observer writes it. `absent` is terminal: a VM Boat positively no longer has never comes
 * back, so its execution has ended whatever the guest records say. No row, or a stale `present`,
 * is unknown: a timeout or an unreadable reply is never absence.
 */
export const boatObservations = snakeCase.table(
  "boat_observations",
  {
    runtimeInstanceId: text()
      .primaryKey()
      .references(() => workspaceAttempts.id, { onDelete: "restrict" }),
    deploymentId: text().notNull(),
    /** Null only when no VM was ever created for the launch (`not-discovered`). */
    sandboxId: text(),
    presence: text().$type<"present" | "absent">().notNull(),
    /**
     * `read`: Boat returned the exact labelled VM. `not-found`: a typed 404 after Boat had reported
     * the VM's creation finished. `deletion-completed`: Boat's deletion operation for it completed.
     * `not-discovered`: no VM carries the launch's labels (reserved for label discovery).
     */
    basis: text().$type<"read" | "not-found" | "deletion-completed" | "not-discovered">().notNull(),
    /** Boat's own state at the last `read`. */
    providerState: text(),
    /**
     * When Boat first reported the VM past creation (a state after `cloning`). Until then a 404 may
     * be Boat not yet able to read a VM it accepted, so it is never absence.
     */
    createdObservedAt: timestamp({ mode: "date", withTimezone: true }),
    observedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "boat_observations_shape",
      sql`(${table.presence} = 'present' and ${table.basis} = 'read' and ${table.sandboxId} is not null)
        or (${table.presence} = 'absent' and ${table.basis} = 'not-found' and ${table.sandboxId} is not null and ${table.createdObservedAt} is not null)
        or (${table.presence} = 'absent' and ${table.basis} = 'deletion-completed' and ${table.sandboxId} is not null)
        or (${table.presence} = 'absent' and ${table.basis} = 'not-discovered' and ${table.sandboxId} is null)`,
    ),
  ],
);

export type BoatObservation = typeof boatObservations.$inferSelect;
