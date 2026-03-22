import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";

import { messageResponseSchema } from "../../lib/schemas.js";
import {
  sandboxErrorSchema,
  sandboxPublishedImageSchema,
  sandboxRuntimeSchema,
  sandboxStatusSchema,
} from "../sandboxes/sandboxes.routes.js";

const tags = ["Runs"];

export const runIdParamsSchema = z.object({
  runId: z.string().trim().min(1),
});

export const runRecordSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  triggerType: z.enum(["manual", "issue", "schedule", "api", "retry"]),
  triggerRef: z.string().nullable(),
  requestedByUserId: z.string().nullable(),
  cancelReason: z.string().nullable(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const runInputSnapshotSchema = z.object({
  userSpecPayload: z.unknown(),
  resolvedSpecPayload: z.unknown(),
  blueprintPayload: z.unknown(),
  profileConfigSnapshot: z.unknown().nullable(),
  repositoryProfileConfigSnapshot: z.unknown().nullable(),
  createdAt: z.string().datetime(),
});

export const runSummarySchema = z.object({
  objective: z.string().nullable(),
  linkedIssueRef: z.string().nullable(),
  filesChanged: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
  summaryMarkdown: z.string().nullable(),
  generatedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const runEventSchema = z.object({
  id: z.string(),
  sequence: z.number().int(),
  phase: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  eventType: z.string(),
  message: z.string(),
  payload: z.unknown().nullable(),
  occurredAt: z.string().datetime(),
});

export const runValidationResultSchema = z.object({
  id: z.string(),
  checkKey: z.string(),
  status: z.enum(["pass", "warn", "fail", "skip"]),
  durationMs: z.number().int().nullable(),
  message: z.string().nullable(),
  details: z.unknown().nullable(),
  createdAt: z.string().datetime(),
});

export const runDiffFileSchema = z.object({
  id: z.string(),
  changeType: z.enum(["added", "modified", "deleted", "renamed"]),
  path: z.string(),
  oldPath: z.string().nullable(),
  additions: z.number().int(),
  deletions: z.number().int(),
  isBinary: z.boolean(),
  patchArtifactId: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const runArtifactSchema = z.object({
  id: z.string(),
  kind: z.string(),
  storageBackend: z.string(),
  storageKey: z.string().nullable(),
  contentType: z.string().nullable(),
  byteSize: z.number().int().nullable(),
  checksum: z.string().nullable(),
  inlineJson: z.unknown().nullable(),
  createdAt: z.string().datetime(),
});

export const runSandboxSchema = z.object({
  sandboxId: z.string(),
  jobId: z.string().optional(),
  status: sandboxStatusSchema,
  runStatus: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  jobStatus: z.enum(["queued", "running", "succeeded", "failed"]).optional(),
  registryId: z.string().optional(),
  repository: z.string().optional(),
  tag: z.string().optional(),
  runtime: sandboxRuntimeSchema.optional(),
  publishedImage: sandboxPublishedImageSchema.optional(),
  error: sandboxErrorSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});

export const runDetailsResponseSchema = z.object({
  run: runRecordSchema,
  sandbox: runSandboxSchema,
  inputSnapshot: runInputSnapshotSchema.nullable(),
  summary: runSummarySchema.nullable(),
  events: z.array(runEventSchema),
  validationResults: z.array(runValidationResultSchema),
  diffFiles: z.array(runDiffFileSchema),
  artifacts: z.array(runArtifactSchema),
});

export const runIdValidator = validator("param", runIdParamsSchema);

export const getRunRoute = describeRoute({
  tags,
  description: "Get consolidated run details used by the run detail UI surfaces.",
  responses: {
    200: {
      description: "Run details",
      content: {
        "application/json": {
          schema: resolver(runDetailsResponseSchema),
        },
      },
    },
    404: {
      description: "Run not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});
