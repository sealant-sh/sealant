import type { NewWorkspace, WorkspaceBuild } from "@sealant/validators";
import {
  index,
  integer,
  jsonb,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Client-level `casing: "snake_case"` no longer exists, so re-apply snake_case at the
// table level to keep implicit column names mapping to snake_case db columns.
const pgTable = snakeCase.table;

import { workspaceAttempts } from "./control-plane.js";

export const ociImageBuildJobStatusValues = ["queued", "running", "succeeded", "failed"] as const;

export type OciImageBuildJobStatus = (typeof ociImageBuildJobStatusValues)[number];

export const workspaceRuntimeInstanceStatusValues = [
  "pending",
  // "running": legacy — the container is up but its control socket may not be accepting yet. Retained
  // for rows written before the readiness probe landed; the launch path no longer emits it.
  "running",
  // "ready": the control socket is accepting (readiness probe passed). This is the honest "reachable"
  // signal the SDK gates on — see resolveWorkspaceStatus + DockerRuntimeAdapter.launch.
  "ready",
  "failed",
  "stopped",
] as const;

export type WorkspaceRuntimeInstanceStatus = (typeof workspaceRuntimeInstanceStatusValues)[number];

// Why a runtime instance was stopped: an explicit user/API stop, TTL expiry (reaper), or a stop
// taken as part of a failure path. Workspaces are ephemeral, so "stopped" is terminal.
export const workspaceRuntimeInstanceStopReasonValues = ["user", "expired", "failed"] as const;

export type WorkspaceRuntimeInstanceStopReason =
  (typeof workspaceRuntimeInstanceStopReasonValues)[number];

export const ociImageBuildJobs = pgTable(
  "oci_image_build_jobs",
  {
    id: text().primaryKey(),
    runId: text("run_id").references(() => workspaceAttempts.id, { onDelete: "set null" }),
    status: text({ enum: ociImageBuildJobStatusValues }).notNull().default("queued"),
    registryId: text().notNull(),
    repository: text().notNull(),
    tag: text().notNull(),
    requestPayload: jsonb("request_payload").$type<NewWorkspace>().notNull(),
    idempotencyKey: text(),
    attemptCount: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(3),
    availableAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    claimedAt: timestamp({ mode: "date", withTimezone: true }),
    leaseExpiresAt: timestamp({ mode: "date", withTimezone: true }),
    workerId: text(),
    startedAt: timestamp({ mode: "date", withTimezone: true }),
    finishedAt: timestamp({ mode: "date", withTimezone: true }),
    builderId: text(),
    resultPayload: jsonb("result_payload").$type<WorkspaceBuild>(),
    publishedReference: text(),
    publishedDigestReference: text(),
    publishedDigest: text(),
    errorCode: text(),
    errorMessage: text(),
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("oci_image_build_jobs_status_available_at_idx").on(table.status, table.availableAt),
    index("oci_image_build_jobs_status_claimed_at_idx").on(table.status, table.claimedAt),
    index("oci_image_build_jobs_created_at_idx").on(table.createdAt),
    index("oci_image_build_jobs_run_id_idx").on(table.runId),
    uniqueIndex("oci_image_build_jobs_idempotency_key_idx").on(table.idempotencyKey),
  ],
);

/**
 * How one connected-account credential was ACTUALLY injected at this instance's launch. Recorded
 * so post-run sync-backs can trust launch-time truth instead of the account row's CURRENT payload
 * shape (which a reconnect may have switched while the workspace was alive) — e.g. a claude
 * account reconnected token→session-file mid-run must NOT have this env-injected workspace's
 * harness-written credentials file synced back over the fresh paste.
 */
export interface WorkspaceLaunchCredentialInjection {
  readonly provider: string;
  readonly connectedAccountId: string;
  readonly injection: "env" | "file";
}

export const workspaceRuntimeInstances = pgTable(
  "workspace_runtime_instances",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => workspaceAttempts.id, { onDelete: "cascade" }),
    status: text({ enum: workspaceRuntimeInstanceStatusValues }).notNull().default("pending"),
    adapter: text({ enum: ["docker", "k8s", "k3s"] }),
    resourceId: text("resource_id"),
    // Null on rows written before this column existed (or before launch succeeded): sync-backs
    // treat null as "no credential was file-injected here".
    launchCredentialInjections: jsonb("launch_credential_injections").$type<
      readonly WorkspaceLaunchCredentialInjection[]
    >(),
    reference: text(),
    endpoint: text(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    stopReason: text("stop_reason", { enum: workspaceRuntimeInstanceStopReasonValues }),
    launchedAt: timestamp("launched_at", { mode: "date", withTimezone: true }),
    finishedAt: timestamp("finished_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("workspace_runtime_instances_status_updated_at_idx").on(table.status, table.updatedAt),
    index("workspace_runtime_instances_adapter_status_idx").on(table.adapter, table.status),
  ],
);

export type OciImageBuildJob = typeof ociImageBuildJobs.$inferSelect;
export type NewOciImageBuildJob = typeof ociImageBuildJobs.$inferInsert;

export type WorkspaceRuntimeInstance = typeof workspaceRuntimeInstances.$inferSelect;
export type NewWorkspaceRuntimeInstance = typeof workspaceRuntimeInstances.$inferInsert;

// Compatibility exports while the rest of the codebase migrates away from
// workspace_build_jobs naming.
export const workspaceBuildJobStatusValues = ociImageBuildJobStatusValues;

export type WorkspaceBuildJobStatus = OciImageBuildJobStatus;

export type WorkspaceBuildJob = OciImageBuildJob;
export type NewWorkspaceBuildJob = NewOciImageBuildJob;
