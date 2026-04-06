import type { NewSandbox, SandboxBuild } from "@sealant/validators";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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

export const ociImageBuildJobs = pgTable(
  "oci_image_build_jobs",
  {
    id: text().primaryKey(),
    runId: text("run_id").references(() => sandboxAttempts.id, { onDelete: "set null" }),
    status: text({ enum: ociImageBuildJobStatusValues }).notNull().default("queued"),
    registryId: text().notNull(),
    repository: text().notNull(),
    tag: text().notNull(),
    requestPayload: jsonb("request_payload").$type<NewSandbox>().notNull(),
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
    resultPayload: jsonb("result_payload").$type<SandboxBuild>(),
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

export const sandboxRuntimeInstances = pgTable(
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

export type SandboxBuildJob = OciImageBuildJob;
export type NewSandboxBuildJob = NewOciImageBuildJob;
