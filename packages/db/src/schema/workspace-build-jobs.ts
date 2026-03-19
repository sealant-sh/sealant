import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import type {
  WorkspaceBuildJobRequestPayload,
  WorkspaceBuildJobResultPayload,
} from "../payloads.js";

export const workspaceBuildJobStatusValues = ["queued", "running", "succeeded", "failed"] as const;

export type WorkspaceBuildJobStatus = (typeof workspaceBuildJobStatusValues)[number];

export const workspaceBuildJobs = sqliteTable(
  "workspace_build_jobs",
  {
    id: text().primaryKey(),
    status: text({ enum: workspaceBuildJobStatusValues }).notNull().default("queued"),
    registryId: text().notNull(),
    repository: text().notNull(),
    tag: text().notNull(),
    requestPayload: text("request_payload", { mode: "json" })
      .$type<WorkspaceBuildJobRequestPayload>()
      .notNull(),
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
    executorId: text(),
    resultPayload: text("result_payload", { mode: "json" }).$type<WorkspaceBuildJobResultPayload>(),
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
    index("workspace_build_jobs_status_available_at_idx").on(table.status, table.availableAt),
    index("workspace_build_jobs_status_claimed_at_idx").on(table.status, table.claimedAt),
    index("workspace_build_jobs_created_at_idx").on(table.createdAt),
    uniqueIndex("workspace_build_jobs_idempotency_key_idx").on(table.idempotencyKey),
  ],
);

export type WorkspaceBuildJob = typeof workspaceBuildJobs.$inferSelect;
export type NewWorkspaceBuildJob = typeof workspaceBuildJobs.$inferInsert;
