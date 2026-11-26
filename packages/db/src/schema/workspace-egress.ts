/**
 * A workspace's network policy, its durable revocations, and the egress proxy (`<name>-proxy`) of
 * each run that has one (workspace isolation architecture §7.3).
 *
 * - The policy and its brokered secrets are pinned per workspace: a restart launches with them,
 *   and "Apply updated policy" replaces them. The brokered secrets' values are sealed with the
 *   credential key and reach only the proxy.
 * - Revocations are per workspace and monotonic: each takes the next revocation watermark and
 *   overrides any policy, on every proxy boot, lease renewal and live update, restarts included.
 * - Each run with a proxy has one executor CA. Its private key is sealed with the credential key,
 *   kept for the run's life so a restarted proxy gets the same CA, and never reaches the
 *   workspace.
 */
import type { BrokeredSecret, NetworkPolicy } from "@sealant/api-contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  jsonb,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { workspaceAttempts, workspaces } from "./control-plane.js";

export const workspaceEgressRevocationKindValues = ["secret", "host", "all"] as const;
export type WorkspaceEgressRevocationKind = (typeof workspaceEgressRevocationKindValues)[number];

export const workspaceEgressPolicies = snakeCase.table("workspace_egress_policies", {
  workspaceId: text()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Null for a workspace that has only revocations (created without a policy). */
  networkPolicy: jsonb().$type<NetworkPolicy>(),
  brokeredSecrets: jsonb().$type<readonly BrokeredSecret[]>().notNull().default([]),
  /** `{ [secretRef]: value }`, sealed with the credential key. Null when there are no secrets. */
  brokeredValuesSealed: text(),
  encryptionKeyId: text(),
  /** The newest revocation's watermark; 0 before the first. Only ever grows. */
  revocationWatermark: bigint({ mode: "number" }).notNull().default(0),
  /**
   * Bumped by every write of the policy, a rotation of only a secret's value included (which
   * leaves `policyHash` as it was): a proxy that confirmed an older revision is pushed again.
   */
  policyRevision: bigint({ mode: "number" }).notNull().default(0),
  createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ mode: "date", withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type WorkspaceEgressPolicy = typeof workspaceEgressPolicies.$inferSelect;

export const workspaceEgressRevocations = snakeCase.table(
  "workspace_egress_revocations",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    revocationWatermark: bigint({ mode: "number" }).notNull(),
    kind: text({ enum: workspaceEgressRevocationKindValues }).notNull(),
    /** The secret id or the host; null for `all`. */
    target: text(),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("workspace_egress_revocations_workspace_idx").on(
      table.workspaceId,
      table.revocationWatermark,
    ),
    uniqueIndex("workspace_egress_revocations_once").on(
      table.workspaceId,
      table.revocationWatermark,
      table.kind,
      sql`coalesce(${table.target}, '')`,
    ),
    check(
      "workspace_egress_revocations_target",
      sql`(${table.kind} = 'all') = (${table.target} is null)`,
    ),
  ],
);

export type WorkspaceEgressRevocation = typeof workspaceEgressRevocations.$inferSelect;

/** What the launch measured of the host for the proxy's policy, kept so any writer rebuilds it. */
export interface WorkspaceEgressProxyNetwork {
  readonly proxyIp: string;
  readonly operatorAllowedPrivateCidrs: readonly string[];
  readonly hostPublicIps: readonly string[];
  readonly blockedCidrs: readonly string[];
  /** The operator's mirror hosts on the proxy's network: the only mirrors a policy may grant. */
  readonly mirrorHosts?: readonly string[];
  /** Resource hosts the workspace is authorized to reach through its proxy. */
  readonly resourceHosts?: readonly string[];
  /** The deployment's telemetry hosts (the daemon's Sentry), granted on 443 under any policy. */
  readonly telemetryHosts?: readonly string[];
}

export const workspaceEgressProxies = snakeCase.table(
  "workspace_egress_proxies",
  {
    runId: text()
      .primaryKey()
      .references(() => workspaceAttempts.id, { onDelete: "cascade" }),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The proxy container's name (`<workspace container>-proxy`). */
    proxyContainer: text().notNull(),
    /** Its admin socket on the control directory every control-plane process mounts. */
    adminSocketPath: text().notNull(),
    caCertPem: text().notNull(),
    caKeySealed: text().notNull(),
    encryptionKeyId: text().notNull(),
    caNotAfter: timestamp({ mode: "date", withTimezone: true }).notNull(),
    /** Null until the launch has measured it (before the proxy first starts). */
    network: jsonb().$type<WorkspaceEgressProxyNetwork>(),
    /** What the proxy last confirmed taking (`PUT /v1/policy`, `POST /v1/revoke`). */
    confirmedPolicyHash: text(),
    confirmedRevocationWatermark: bigint({ mode: "number" }),
    /** The policy revision the proxy last confirmed (`workspace_egress_policies.policy_revision`). */
    confirmedPolicyRevision: bigint({ mode: "number" }),
    createdAt: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("workspace_egress_proxies_workspace_idx").on(table.workspaceId)],
);

export type WorkspaceEgressProxy = typeof workspaceEgressProxies.$inferSelect;
