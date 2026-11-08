import { index, jsonb, snakeCase, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { boatExecutions } from "./boat-executions.js";

/** Short-lived, sealed replies let API processes reach Boat without the provider credential. */
export const boatControlRequests = snakeCase.table(
  "boat_control_requests",
  {
    id: uuid().primaryKey(),
    runtimeInstanceId: text()
      .notNull()
      .references(() => boatExecutions.runtimeInstanceId, { onDelete: "cascade" }),
    target: jsonb().$type<unknown>().notNull(),
    expiresAt: timestamp({ mode: "date", withTimezone: true }).notNull(),
    sealedAccess: text(),
  },
  (table) => [index("boat_control_requests_expiry").on(table.expiresAt)],
);
