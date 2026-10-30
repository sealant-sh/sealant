import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  primaryKey,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";

const pgTable = snakeCase.table;

/**
 * An owner that is a project, not a person (`@sealant/api-contracts` `resource-domains.ts`). It
 * has no owner of its own and nothing cascades into it: whatever comes to belong to a domain
 * references it with ON DELETE RESTRICT. Its id is `rdm:<uuid>`, a spelling no `user.id` may have
 * (`user_id_not_resource_domain`), so the two id spaces never meet.
 */
export const resourceDomains = pgTable(
  "resource_domains",
  {
    id: text().primaryKey(),
    /** `<application>:<name>`, unique across every application. */
    key: text().notNull(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("resource_domains_key_idx").on(table.key),
    check(
      "resource_domains_id_is_rdm_uuid",
      sql`${table.id} ~ '^rdm:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
  ],
);

export const resourceDomainMemberStateValues = ["member", "revoked"] as const;
export type ResourceDomainMemberState = (typeof resourceDomainMemberStateValues)[number];

/**
 * The application's latest decision about one person in a domain, and its version. Each grant or
 * revoke names the version it replaces (0 when there is no row) and writes the next one; any other
 * expected version is refused, except a repeat of the decision that wrote the current version (same
 * state, one above), which answers the row unchanged. Versions only rise, so a delayed grant never
 * undoes a revoke. A revoke keeps its row as that version's record. `ResourceDomainRepo` enforces
 * this rule.
 */
export const resourceDomainMembers = pgTable(
  "resource_domain_members",
  {
    resourceDomainId: text()
      .notNull()
      .references(() => resourceDomains.id, { onDelete: "restrict" }),
    // A person's decisions go with them; the domain outlives every person.
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    state: text({ enum: resourceDomainMemberStateValues }).notNull(),
    version: bigint({ mode: "number" }).notNull(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.resourceDomainId, table.userId] }),
    check("resource_domain_members_state", sql`${table.state} in ('member', 'revoked')`),
    check("resource_domain_members_version", sql`${table.version} between 1 and 9007199254740991`),
  ],
);

export type ResourceDomain = typeof resourceDomains.$inferSelect;
export type ResourceDomainMember = typeof resourceDomainMembers.$inferSelect;
