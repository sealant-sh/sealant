import {
  workspaceBuildJobRequestPayloadSchema,
  workspaceBuildJobResultPayloadSchema,
  workspaceBuildJobStatusSchema,
} from "@sealant/db";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";

import { messageResponseSchema } from "../../lib/schemas.js";

const tags = ["Internal Diagnostics"];

export const workspaceBuildJobIdParamsSchema = z.object({
  jobId: z.string().trim().min(1),
});

export const createWorkspaceBuildJobRequestSchema = z.object({
  ownerUserId: z.string().trim().min(1),
  registryId: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  tag: z.string().trim().min(1),
  spec: workspaceBuildJobRequestPayloadSchema,
});

export const createWorkspaceBuildJobResponseSchema = z.object({
  jobId: z.string(),
  runId: z.string(),
  status: workspaceBuildJobStatusSchema,
  registryId: z.string(),
  repository: z.string(),
  tag: z.string(),
});

export const publishedImageSchema = z.object({
  reference: z.string(),
  digestReference: z.string(),
  digest: z.string(),
});

export const workspaceBuildJobErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

export const workspaceBuildJobDetailsSchema = z.object({
  jobId: z.string(),
  runId: z.string().optional(),
  status: workspaceBuildJobStatusSchema,
  registryId: z.string(),
  repository: z.string(),
  tag: z.string(),
  spec: workspaceBuildJobRequestPayloadSchema,
  executorId: z.string().optional(),
  result: workspaceBuildJobResultPayloadSchema.optional(),
  publishedImage: publishedImageSchema.optional(),
  error: workspaceBuildJobErrorSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});

export const workspaceBuildJobIdValidator = validator("param", workspaceBuildJobIdParamsSchema);
export const createWorkspaceBuildJobValidator = validator(
  "json",
  createWorkspaceBuildJobRequestSchema,
);

export const createWorkspaceBuildJobRoute = describeRoute({
  tags,
  description: "Internal route: queue a low-level OCI image build and publish job.",
  responses: {
    202: {
      description: "Workspace build job queued",
      content: {
        "application/json": {
          schema: resolver(createWorkspaceBuildJobResponseSchema),
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
      description: "Failed to enqueue workspace build job",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const getWorkspaceBuildJobRoute = describeRoute({
  tags,
  description: "Internal route: get low-level durable state for an OCI image build job.",
  responses: {
    200: {
      description: "Workspace build job details",
      content: {
        "application/json": {
          schema: resolver(workspaceBuildJobDetailsSchema),
        },
      },
    },
    404: {
      description: "Workspace build job not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});
