import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { boatExecutions } from "./boat-executions.js";

/** Reservations survive worker loss and cannot disappear with generic run cleanup. */
export const boatTunnels = snakeCase.table(
  "boat_tunnels",
  {
    runtimeInstanceId: text()
      .primaryKey()
      .references(() => boatExecutions.runtimeInstanceId, { onDelete: "restrict" }),
    gatewayHostId: uuid().notNull(),
    listenPort: integer().notNull(),
    reservationId: uuid().notNull().unique(),
    record: jsonb().$type<unknown>().notNull(),
    releasedAt: timestamp({ mode: "date", withTimezone: true }),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("boat_tunnels_host_port")
      .on(table.gatewayHostId, table.listenPort)
      .where(sql`${table.releasedAt} is null`),
    check(
      "boat_tunnels_release",
      sql`coalesce(${table.record}->'released', 'false'::jsonb) = to_jsonb(${table.releasedAt} is not null)`,
    ),
    // The allocator's range, and the sixteen ports of the first one (`BOAT_TUNNEL_LEGACY_PORTS`),
    // which reservations made before the range moved still hold.
    check(
      "boat_tunnels_port",
      sql`${table.listenPort} between 61000 and 61511 or ${table.listenPort} between 40000 and 40015`,
    ),
    check(
      "boat_tunnels_identity",
      sql`coalesce(${table.record}->'binding'->'target'->>'runtimeInstanceId' = ${table.runtimeInstanceId} and ${table.record}->'binding'->>'gatewayHostId' = ${table.gatewayHostId}::text and ${table.record}->>'reservationId' = ${table.reservationId}::text and (${table.record}->>'listenPort')::integer = ${table.listenPort}, false)`,
    ),
  ],
);
