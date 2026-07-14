import { z } from "zod";

import { newWorkspaceSchema } from "../workspaces/payloads.js";

export const workspaceAttemptTriggerTypeValues = ["manual", "schedule", "api", "retry"] as const;

export const workspaceStatusSchema = z.enum([
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
  "stopped",
]);

export const workspaceIdParamsSchema = z.object({
  workspaceId: z.string().trim().min(1),
});

export const githubWorkspaceSourceSelectionSchema = z.strictObject({
  provider: z.literal("github"),
  installationId: z.string().trim().min(1),
  installationRepositoryId: z.string().trim().min(1),
  ref: z.string().trim().min(1).optional(),
});

export const createWorkspaceRequestSchema = z.object({
  ownerUserId: z.string().trim().min(1),
  registryId: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  tag: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  sourceSelection: githubWorkspaceSourceSelectionSchema.optional(),
  dotfilesSelection: githubWorkspaceSourceSelectionSchema.optional(),
  spec: newWorkspaceSchema,
  // Per-create TTL override in seconds; when omitted the server default
  // (SEALANT_WORKSPACE_DEFAULT_TTL_SECONDS) applies. 0/null is not accepted here — "never
  // expires" is expressed by the server default being unset.
  ttlSeconds: z.number().int().positive().optional(),
});

export const renameWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

// Lifecycle actions are owner-scoped like execWorkspace: the ownerUserId rides in the payload and
// a mismatch yields a uniform 404 (existence is not leaked).
export const stopWorkspaceRequestSchema = z.object({
  ownerUserId: z.string().trim().min(1),
});

export const stopWorkspaceResponseSchema = z.object({
  workspaceId: z.string(),
  status: workspaceStatusSchema,
});

export const restartWorkspaceRequestSchema = z.object({
  ownerUserId: z.string().trim().min(1),
});

export const restartWorkspaceResponseSchema = z.object({
  workspaceId: z.string(),
  runId: z.string(),
  status: workspaceStatusSchema,
});

export const workspaceRuntimeSchema = z.object({
  adapter: z.enum(["docker", "k8s", "k3s"]),
  resourceId: z.string(),
  reference: z.string(),
  status: z.enum(["pending", "running", "ready", "failed", "stopped"]),
  endpoint: z.string().optional(),
});

export const workspaceSshTargetSchema = z.object({
  workspaceId: z.string(),
  attemptId: z.string(),
  runtime: z.object({
    adapter: z.enum(["docker", "k8s", "k3s"]),
    resourceId: z.string(),
    reference: z.string(),
    status: z.enum(["pending", "running", "ready", "failed", "stopped"]),
    endpoint: z.string(),
  }),
});

export const workspacePublishedImageSchema = z.object({
  reference: z.string(),
  digestReference: z.string(),
  digest: z.string(),
});

export const workspaceErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

export const createWorkspaceResponseSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  status: workspaceStatusSchema,
  registryId: z.string(),
  repository: z.string(),
  tag: z.string(),
});

export const renameWorkspaceResponseSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  updatedAt: z.string().datetime(),
});

export const workspaceSummarySchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  ownerUserId: z.string(),
  status: workspaceStatusSchema,
  registryId: z.string().optional(),
  repository: z.string().optional(),
  tag: z.string().optional(),
  runtime: workspaceRuntimeSchema.optional(),
  publishedImage: workspacePublishedImageSchema.optional(),
  error: workspaceErrorSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});

export const workspaceDetailsSchema = workspaceSummarySchema.extend({
  spec: newWorkspaceSchema.optional(),
});

export const listWorkspacesQuerySchema = z.object({
  ownerUserId: z.string().trim().min(1),
  status: workspaceStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const listWorkspaceAttemptsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const listWorkspaceEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const workspaceAttemptRelationSchema = z.enum(["launch", "rebuild", "retry", "resume"]);

export const workspaceAttemptSummarySchema = z.object({
  attemptId: z.string(),
  relation: workspaceAttemptRelationSchema,
  status: workspaceStatusSchema,
  triggerType: z.enum(workspaceAttemptTriggerTypeValues),
  triggerRef: z.string().optional(),
  runtime: workspaceRuntimeSchema.optional(),
  publishedImage: workspacePublishedImageSchema.optional(),
  error: workspaceErrorSchema.optional(),
  spec: newWorkspaceSchema.optional(),
  queuedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  linkedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const listWorkspaceAttemptsResponseSchema = z.object({
  items: z.array(workspaceAttemptSummarySchema),
});

export const workspaceEventTypeSchema = z.enum([
  "workspace.created",
  "attempt.queued",
  "attempt.running",
  "attempt.succeeded",
  "attempt.failed",
  "attempt.cancelled",
  "image.published",
  "runtime.pending",
  "runtime.running",
  "runtime.ready",
  "runtime.failed",
  "runtime.stopped",
]);

export const workspaceEventSchema = z.object({
  eventId: z.string(),
  workspaceId: z.string(),
  attemptId: z.string().optional(),
  type: workspaceEventTypeSchema,
  occurredAt: z.string().datetime(),
  message: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const listWorkspaceEventsResponseSchema = z.object({
  items: z.array(workspaceEventSchema),
});

export const listWorkspacesResponseSchema = z.object({
  items: z.array(workspaceSummarySchema),
});
