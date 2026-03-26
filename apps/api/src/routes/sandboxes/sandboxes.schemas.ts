import {
  sandboxAttemptTriggerTypeValues,
  workspaceBuildJobRequestPayloadSchema,
} from "@sealant/db";
import { workspaceBlueprintSchema } from "@sealant/workspace-composition";
import { z } from "zod";

export const sandboxStatusSchema = z.enum(["queued", "running", "ready", "failed", "cancelled"]);

export const sandboxIdParamsSchema = z.object({
  sandboxId: z.string().trim().min(1),
});

export const githubSandboxSourceSelectionSchema = z.strictObject({
  provider: z.literal("github"),
  installationId: z.string().trim().min(1),
  installationRepositoryId: z.string().trim().min(1),
  ref: z.string().trim().min(1).optional(),
});

export const createSandboxRequestSchema = z.object({
  ownerUserId: z.string().trim().min(1),
  registryId: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  tag: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  sourceSelection: githubSandboxSourceSelectionSchema.optional(),
  dotfilesSelection: githubSandboxSourceSelectionSchema.optional(),
  spec: workspaceBuildJobRequestPayloadSchema,
});

export const renameSandboxRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const sandboxRuntimeSchema = z.object({
  adapter: z.enum(["docker", "k8s", "k3s"]),
  resourceId: z.string(),
  reference: z.string(),
  status: z.enum(["pending", "running", "failed", "stopped"]),
  endpoint: z.string().optional(),
});

export const sandboxPublishedImageSchema = z.object({
  reference: z.string(),
  digestReference: z.string(),
  digest: z.string(),
});

export const sandboxErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

export const createSandboxResponseSchema = z.object({
  sandboxId: z.string(),
  name: z.string(),
  status: sandboxStatusSchema,
  registryId: z.string(),
  repository: z.string(),
  tag: z.string(),
});

export const renameSandboxResponseSchema = z.object({
  sandboxId: z.string(),
  name: z.string(),
  updatedAt: z.string().datetime(),
});

export const sandboxSummarySchema = z.object({
  sandboxId: z.string(),
  name: z.string(),
  ownerUserId: z.string(),
  status: sandboxStatusSchema,
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

export const sandboxDetailsSchema = sandboxSummarySchema.extend({
  spec: workspaceBuildJobRequestPayloadSchema.optional(),
  blueprint: workspaceBlueprintSchema.optional(),
});

export const listSandboxesQuerySchema = z.object({
  ownerUserId: z.string().trim().min(1),
  status: sandboxStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const listSandboxAttemptsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const listSandboxEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const sandboxAttemptRelationSchema = z.enum(["launch", "rebuild", "retry", "resume"]);

export const sandboxAttemptSummarySchema = z.object({
  attemptId: z.string(),
  relation: sandboxAttemptRelationSchema,
  status: sandboxStatusSchema,
  triggerType: z.enum(sandboxAttemptTriggerTypeValues),
  triggerRef: z.string().optional(),
  runtime: sandboxRuntimeSchema.optional(),
  publishedImage: sandboxPublishedImageSchema.optional(),
  error: sandboxErrorSchema.optional(),
  spec: workspaceBuildJobRequestPayloadSchema.optional(),
  queuedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  linkedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const listSandboxAttemptsResponseSchema = z.object({
  items: z.array(sandboxAttemptSummarySchema),
});

export const sandboxEventTypeSchema = z.enum([
  "sandbox.created",
  "attempt.queued",
  "attempt.running",
  "attempt.succeeded",
  "attempt.failed",
  "attempt.cancelled",
  "image.published",
  "runtime.pending",
  "runtime.running",
  "runtime.failed",
  "runtime.stopped",
]);

export const sandboxEventSchema = z.object({
  eventId: z.string(),
  sandboxId: z.string(),
  attemptId: z.string().optional(),
  type: sandboxEventTypeSchema,
  occurredAt: z.string().datetime(),
  message: z.string().optional(),
  data: z.record(z.unknown()).optional(),
});

export const listSandboxEventsResponseSchema = z.object({
  items: z.array(sandboxEventSchema),
});

export const listSandboxesResponseSchema = z.object({
  items: z.array(sandboxSummarySchema),
});
