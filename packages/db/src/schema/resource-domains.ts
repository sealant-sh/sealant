import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  primaryKey,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
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
    /**
     * The budget: ceilings on what its held allocations may add up to, not measurements. Zero
     * admits nothing; there is no unlimited. `budgetRevision` rises with every change, which only
     * a caller naming the revision it read may make.
     */
    cpuMillicores: bigint({ mode: "number" }).notNull().default(0),
    memoryBytes: bigint({ mode: "number" }).notNull().default(0),
    storageBytes: bigint({ mode: "number" }).notNull().default(0),
    budgetRevision: bigint({ mode: "number" }).notNull().default(1),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("resource_domains_key_idx").on(table.key),
    check(
      "resource_domains_budget",
      sql`${table.cpuMillicores} between 0 and 9007199254740991 and ${table.memoryBytes} between 0 and 9007199254740991 and ${table.storageBytes} between 0 and 9007199254740991 and ${table.budgetRevision} between 1 and 9007199254740991`,
    ),
    check(
      "resource_domains_id_is_rdm_uuid",
      sql`${table.id} ~ '^rdm:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
  ],
);

export const resourceDomainMemberStateValues = ["member", "revoked"] as const;
export type ResourceDomainMemberState = (typeof resourceDomainMemberStateValues)[number];

/**
 * The application's latest decision about one person in a domain, under the application's own
 * version for it, which rises with each decision it makes (its record's revision, say). A decision
 * is written only over a lower version. The same version with the same state is a repeat and leaves
 * the row as it is; the same version with the other state, or a lower one, is stale and changes
 * nothing. So a delayed grant never undoes a newer revoke, whatever order decisions arrive in, and
 * the application never reads before it writes. A revoke keeps its row as that version's record.
 * `ResourceDomainRepo` enforces this rule.
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

export const resourceDomainAllocationUseValues = ["compute", "volume", "protection"] as const;
export type ResourceDomainAllocationUse = (typeof resourceDomainAllocationUseValues)[number];
export const resourceDomainAllocationStateValues = [
  "reserved",
  "in-use",
  "archived",
  "released",
] as const;
export type ResourceDomainAllocationState = (typeof resourceDomainAllocationStateValues)[number];

/**
 * What a domain's objects hold of its budget, one row an admission. These rows, not a counter,
 * are the charge: the rows that are not `released` add up to it (`ResourceDomainRepo.getBudget`).
 *
 * - `compute` holds CPU and memory for a workload.
 * - `volume` holds its data bytes (`storageBytes`) and a reserve for its backups and snapshots
 *   (`protectionBytes`). Its storage charge is the data plus the part of the reserve no live
 *   backup of it holds, so a backup inside the reserve charges nothing more.
 * - `protection` holds one backup or snapshot of the volume allocation `sourceAllocationId`, all
 *   its bytes, until that backup is purged. Purging the volume leaves it charged.
 *
 * A row is `reserved` from admission until its object's creation is confirmed (`in-use`), an
 * uncertain outcome included. Only a volume is `archived`. A row's `operationKey` admits it once.
 */
export const resourceDomainAllocations = pgTable(
  "resource_domain_allocations",
  {
    id: text().primaryKey(),
    resourceDomainId: text()
      .notNull()
      .references(() => resourceDomains.id, { onDelete: "restrict" }),
    use: text({ enum: resourceDomainAllocationUseValues }).notNull(),
    objectKey: text().notNull(),
    sourceAllocationId: text().references((): AnyPgColumn => resourceDomainAllocations.id, {
      onDelete: "restrict",
    }),
    operationKey: text().notNull(),
    cpuMillicores: bigint({ mode: "number" }).notNull().default(0),
    memoryBytes: bigint({ mode: "number" }).notNull().default(0),
    storageBytes: bigint({ mode: "number" }).notNull().default(0),
    protectionBytes: bigint({ mode: "number" }).notNull().default(0),
    state: text({ enum: resourceDomainAllocationStateValues }).notNull().default("reserved"),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("resource_domain_allocations_operation_idx").on(
      table.resourceDomainId,
      table.operationKey,
    ),
    // One live hold an object; a stopped workload's next start is a new admission.
    uniqueIndex("resource_domain_allocations_live_object_idx")
      .on(table.resourceDomainId, table.use, table.objectKey)
      .where(sql`state <> 'released'`),
    // A volume's live backups, which its unused reserve is read from.
    index("resource_domain_allocations_source_idx")
      .on(table.sourceAllocationId)
      .where(sql`state <> 'released'`),
    check(
      "resource_domain_allocations_state",
      sql`${table.state} in ('reserved', 'in-use', 'archived', 'released') and (${table.state} <> 'archived' or ${table.use} = 'volume')`,
    ),
    check(
      "resource_domain_allocations_shape",
      sql`(${table.use} = 'compute' and ${table.cpuMillicores} > 0 and ${table.memoryBytes} > 0 and ${table.storageBytes} = 0 and ${table.protectionBytes} = 0 and ${table.sourceAllocationId} is null)
      or (${table.use} = 'volume' and ${table.cpuMillicores} = 0 and ${table.memoryBytes} = 0 and ${table.storageBytes} > 0 and ${table.protectionBytes} >= 0 and ${table.sourceAllocationId} is null)
      or (${table.use} = 'protection' and ${table.cpuMillicores} = 0 and ${table.memoryBytes} = 0 and ${table.storageBytes} = 0 and ${table.protectionBytes} > 0 and ${table.sourceAllocationId} is not null)`,
    ),
    check(
      "resource_domain_allocations_range",
      sql`${table.cpuMillicores} <= 9007199254740991 and ${table.memoryBytes} <= 9007199254740991 and ${table.storageBytes} <= 9007199254740991 and ${table.protectionBytes} <= 9007199254740991`,
    ),
  ],
);

export type ResourceDomain = typeof resourceDomains.$inferSelect;
export type ResourceDomainAllocation = typeof resourceDomainAllocations.$inferSelect;
export type ResourceDomainMember = typeof resourceDomainMembers.$inferSelect;
