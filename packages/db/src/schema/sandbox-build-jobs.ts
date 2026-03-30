import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import type { NewSandbox, SandboxBuild } from "../payloads.js";
import { sandboxAttempts } from "./control-plane.js";

export const ociImageBuildJobStatusValues = ["queued", "running", "succeeded", "failed"] as const;

export type OciImageBuildJobStatus = (typeof ociImageBuildJobStatusValues)[number];

export const sandboxRuntimeInstanceStatusValues = [
  "pending",
  "running",
  "failed",
  "stopped",
] as const;

export type SandboxRuntimeInstanceStatus = (typeof sandboxRuntimeInstanceStatusValues)[number];

export const ociImageBuildJobs = sqliteTable(
  "oci_image_build_jobs",
  {
    id: text().primaryKey(),
    runId: text("run_id").references(() => sandboxAttempts.id, { onDelete: "set null" }),
    status: text({ enum: ociImageBuildJobStatusValues }).notNull().default("queued"),
    registryId: text().notNull(),
    repository: text().notNull(),
    tag: text().notNull(),
    requestPayload: text("request_payload", { mode: "json" }).$type<NewSandbox>().notNull(),
    idempotencyKey: text(),
    attemptCount: integer({ mode: "number" }).notNull().default(0),
    maxAttempts: integer({ mode: "number" }).notNull().default(3),
    availableAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    claimedAt: integer({ mode: "timestamp_ms" }),
    leaseExpiresAt: integer({ mode: "timestamp_ms" }),
    workerId: text(),
    startedAt: integer({ mode: "timestamp_ms" }),
    finishedAt: integer({ mode: "timestamp_ms" }),
    builderId: text(),
    resultPayload: text("result_payload", { mode: "json" }).$type<SandboxBuild>(),
    publishedReference: text(),
    publishedDigestReference: text(),
    publishedDigest: text(),
    errorCode: text(),
    errorMessage: text(),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
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

export const sandboxRuntimeInstances = sqliteTable(
  "sandbox_runtime_instances",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => sandboxAttempts.id, { onDelete: "cascade" }),
    status: text({ enum: sandboxRuntimeInstanceStatusValues }).notNull().default("pending"),
    adapter: text({ enum: ["docker", "k8s", "k3s"] }),
    resourceId: text("resource_id"),
    reference: text(),
    endpoint: text(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    launchedAt: integer("launched_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("sandbox_runtime_instances_status_updated_at_idx").on(table.status, table.updatedAt),
    index("sandbox_runtime_instances_adapter_status_idx").on(table.adapter, table.status),
  ],
);

export type OciImageBuildJob = typeof ociImageBuildJobs.$inferSelect;
export type NewOciImageBuildJob = typeof ociImageBuildJobs.$inferInsert;

export type SandboxRuntimeInstance = typeof sandboxRuntimeInstances.$inferSelect;
export type NewSandboxRuntimeInstance = typeof sandboxRuntimeInstances.$inferInsert;

// Compatibility exports while the rest of the codebase migrates away from
// sandbox_build_jobs naming.
export const sandboxBuildJobStatusValues = ociImageBuildJobStatusValues;

export type SandboxBuildJobStatus = OciImageBuildJobStatus;

export const sandboxBuildJobs = ociImageBuildJobs;

export type SandboxBuildJob = OciImageBuildJob;
export type NewSandboxBuildJob = NewOciImageBuildJob;
