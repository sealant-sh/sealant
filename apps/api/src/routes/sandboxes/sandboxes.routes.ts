import {
  sandboxAttemptTriggerTypeValues,
  workspaceBuildJobRequestPayloadSchema,
} from "@sealant/db";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";

import { messageResponseSchema } from "../../lib/schemas.js";

const tags = ["Sandboxes"];

export const sandboxStatusSchema = z.enum(["queued", "running", "ready", "failed", "cancelled"]);

export const sandboxIdParamsSchema = z.object({
  sandboxId: z.string().trim().min(1),
});

export const createSandboxRequestSchema = z.object({
  ownerUserId: z.string().trim().min(1),
  registryId: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  tag: z.string().trim().min(1),
  spec: workspaceBuildJobRequestPayloadSchema,
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
  status: sandboxStatusSchema,
  registryId: z.string(),
  repository: z.string(),
  tag: z.string(),
});

export const sandboxSummarySchema = z.object({
  sandboxId: z.string(),
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

export const createSandboxValidator = validator("json", createSandboxRequestSchema);
export const sandboxIdValidator = validator("param", sandboxIdParamsSchema);
export const listSandboxesQueryValidator = validator("query", listSandboxesQuerySchema);
export const listSandboxAttemptsQueryValidator = validator("query", listSandboxAttemptsQuerySchema);
export const listSandboxEventsQueryValidator = validator("query", listSandboxEventsQuerySchema);

export const createSandboxRoute = describeRoute({
  tags,
  description: "Create and queue a sandbox launch request for a user workspace spec.",
  responses: {
    202: {
      description: "Sandbox creation accepted and queued",
      content: {
        "application/json": {
          schema: resolver(createSandboxResponseSchema),
        },
      },
    },
    404: {
      description: "Unknown registry id or owner user",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    502: {
      description: "Failed to enqueue sandbox build request",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const listSandboxesRoute = describeRoute({
  tags,
  description: "List sandboxes for a specific owner user id.",
  responses: {
    200: {
      description: "Sandbox list",
      content: {
        "application/json": {
          schema: resolver(listSandboxesResponseSchema),
        },
      },
    },
  },
});

export const getSandboxRoute = describeRoute({
  tags,
  description: "Get consolidated sandbox lifecycle details by sandbox id.",
  responses: {
    200: {
      description: "Sandbox lifecycle details",
      content: {
        "application/json": {
          schema: resolver(sandboxDetailsSchema),
        },
      },
    },
    404: {
      description: "Sandbox not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const listSandboxAttemptsRoute = describeRoute({
  tags,
  description: "List sandbox attempts linked to a sandbox id, ordered by most recent link first.",
  responses: {
    200: {
      description: "Sandbox attempts list",
      content: {
        "application/json": {
          schema: resolver(listSandboxAttemptsResponseSchema),
        },
      },
    },
    404: {
      description: "Sandbox not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const listSandboxEventsRoute = describeRoute({
  tags,
  description:
    "List sandbox lifecycle events synthesized from sandbox attempts and runtime records.",
  responses: {
    200: {
      description: "Sandbox event timeline",
      content: {
        "application/json": {
          schema: resolver(listSandboxEventsResponseSchema),
        },
      },
    },
    404: {
      description: "Sandbox not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});
