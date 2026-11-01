import type {
  ResourceInstanceSpec,
  ResourceInstanceState,
  ResourceInstanceStopReason,
  ResourceInstanceVolume,
  ResourceReachLevel,
} from "@sealant/api-contracts";
import { sql } from "drizzle-orm";
import {
  check,
  cidr,
  index,
  jsonb,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { workspaces } from "./control-plane.js";
import { resourceDomains } from "./resource-domains.js";

const pgTable = snakeCase.table;

export const resourceInstanceDesiredValues = ["running", "stopped", "archived"] as const;
export type ResourceInstanceDesired = (typeof resourceInstanceDesiredValues)[number];

/**
 * A long-running container a resource domain runs (`@sealant/api-contracts`
 * `resource-instances.ts`). `desired` is what was asked of it and `observed` what Core last saw.
 * Its volumes outlive it: archiving removes the container and keeps every volume, and nothing in
 * Core deletes one.
 */
export const resourceInstances = pgTable(
  "resource_instances",
  {
    id: text().primaryKey(),
    resourceDomainId: text()
      .notNull()
      .references(() => resourceDomains.id, { onDelete: "restrict" }),
    key: text().notNull(),
    /** The spec's alias and worktree key, as columns so one reach network holds each name once. */
    alias: text().notNull(),
    worktreeKey: text(),
    spec: jsonb().$type<ResourceInstanceSpec>().notNull(),
    specDigest: text().notNull(),
    desired: text({ enum: resourceInstanceDesiredValues }).notNull().default("running"),
    /** Why it is stopped, while `desired` is `stopped`. A person's stop holds against `use`. */
    stopReason: jsonb().$type<ResourceInstanceStopReason>(),
    observed: jsonb().$type<ResourceInstanceState>().notNull().default({ kind: "not-started" }),
    observedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    /** Every volume the container mounts: the spec's and those covering the image's `VOLUME`s. */
    volumes: jsonb().$type<ReadonlyArray<ResourceInstanceVolume>>().notNull().default([]),
    /** The last start that answered its ready check: the idle clock starts here. */
    startedAt: timestamp({ mode: "date", withTimezone: true }),
    /** The last time a live linked executor reached it, or an exec ran in it. */
    lastReachedAt: timestamp({ mode: "date", withTimezone: true }),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ mode: "date", withTimezone: true }),
  },
  (table) => [
    uniqueIndex("resource_instances_key_idx").on(table.resourceDomainId, table.key),
    // A reach network holds each short name once, among the instances that are not archived.
    uniqueIndex("resource_instances_alias_idx")
      .on(table.resourceDomainId, table.alias, sql`coalesce(${table.worktreeKey}, '')`)
      .where(sql`${table.desired} <> 'archived'`),
    index("resource_instances_live_idx")
      .on(table.resourceDomainId)
      .where(sql`${table.desired} <> 'archived'`),
    check(
      "resource_instances_id_is_rin_uuid",
      sql`${table.id} ~ '^rin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      "resource_instances_desired",
      sql`${table.desired} in ('running', 'stopped', 'archived')`,
    ),
    check(
      "resource_instances_stop_reason",
      sql`(${table.desired} = 'stopped') = (${table.stopReason} is not null)`,
    ),
    check(
      "resource_instances_archived_at",
      sql`(${table.desired} = 'archived') = (${table.archivedAt} is not null)`,
    ),
  ],
);

/**
 * A workspace that reaches a domain's instances: those with no worktree key, and those with its
 * own. One domain a workspace; its live executors are read from its runs, never stored here.
 */
export const resourceWorkspaceLinks = pgTable(
  "resource_workspace_links",
  {
    workspaceId: text()
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    resourceDomainId: text()
      .notNull()
      .references(() => resourceDomains.id, { onDelete: "restrict" }),
    worktreeKey: text().notNull(),
    /** Alias to the level reached at; null reaches every project instance and the worktree's own. */
    aliases: jsonb().$type<Readonly<Record<string, ResourceReachLevel>>>(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("resource_workspace_links_domain_idx").on(table.resourceDomainId, table.worktreeKey),
  ],
);

export const resourceNetworkKindValues = ["reach", "egress"] as const;
export type ResourceNetworkKind = (typeof resourceNetworkKindValues)[number];

/**
 * The subnets Core hands Docker for the networks it creates for instances, so they never draw on
 * the daemon's default address pools. `reach`: one internal network per linked executor. `egress`:
 * one per instance.
 */
export const resourceNetworks = pgTable(
  "resource_networks",
  {
    name: text().primaryKey(),
    kind: text({ enum: resourceNetworkKindValues }).notNull(),
    subnet: cidr().notNull(),
    /** The executor's container name (reach), or the instance id (egress). */
    owner: text().notNull(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("resource_networks_subnet_idx").on(table.subnet),
    check("resource_networks_kind", sql`${table.kind} in ('reach', 'egress')`),
  ],
);

export type ResourceInstanceRow = typeof resourceInstances.$inferSelect;
export type ResourceWorkspaceLinkRow = typeof resourceWorkspaceLinks.$inferSelect;
export type ResourceNetworkRow = typeof resourceNetworks.$inferSelect;
