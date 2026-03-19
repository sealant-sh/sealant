import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";

import { messageResponseSchema, registryIdParamsSchema } from "../../lib/schemas.js";

const tags = ["Registries"];

export const registrySummarySchema = z.object({
  name: z.string(),
  baseUrl: z.string().url(),
  pushRegistry: z.string(),
  hasBasicAuth: z.boolean(),
});

export const registryPingSchema = z.object({
  name: z.string(),
  reachable: z.literal(true),
});

export const extensionSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
  description: z.string().optional(),
  endpoints: z.array(z.string()),
});

export const registryExtensionsSchema = z.object({
  extensions: z.array(extensionSchema),
});

export const tagsQuerySchema = z.object({
  repository: z.string().trim().min(1),
});

export const tagsResponseSchema = z.object({
  repository: z.string(),
  tags: z.array(z.string()),
});

export const manifestQuerySchema = z.object({
  repository: z.string().trim().min(1),
  reference: z.string().trim().min(1),
});

export const manifestResponseSchema = z.object({
  repository: z.string(),
  reference: z.string(),
  digest: z.string().optional(),
  contentType: z.string().nullable(),
  manifest: z.unknown(),
});

export const registryIdValidator = validator("param", registryIdParamsSchema);
export const tagsQueryValidator = validator("query", tagsQuerySchema);
export const manifestQueryValidator = validator("query", manifestQuerySchema);

export const getRegistryRoute = describeRoute({
  tags,
  description: "Return the configured registry connection metadata.",
  responses: {
    200: {
      description: "Configured registry metadata",
      content: {
        "application/json": {
          schema: resolver(registrySummarySchema),
        },
      },
    },
    404: {
      description: "Unknown registry id",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const pingRegistryRoute = describeRoute({
  tags,
  description: "Ping the configured registry via its OCI API root.",
  responses: {
    200: {
      description: "Registry is reachable",
      content: {
        "application/json": {
          schema: resolver(registryPingSchema),
        },
      },
    },
    404: {
      description: "Unknown registry id",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    502: {
      description: "Registry is unavailable",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const listExtensionsRoute = describeRoute({
  tags,
  description: "List registry extensions advertised by the configured registry.",
  responses: {
    200: {
      description: "Registry extensions",
      content: {
        "application/json": {
          schema: resolver(registryExtensionsSchema),
        },
      },
    },
    404: {
      description: "Unknown registry id",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    502: {
      description: "Registry is unavailable",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const listTagsRoute = describeRoute({
  tags,
  description: "List tags for a repository in the configured registry.",
  responses: {
    200: {
      description: "Repository tags",
      content: {
        "application/json": {
          schema: resolver(tagsResponseSchema),
        },
      },
    },
    404: {
      description: "Unknown registry id",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    502: {
      description: "Registry is unavailable",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const getManifestRoute = describeRoute({
  tags,
  description: "Fetch a manifest from the configured registry by repository and reference.",
  responses: {
    200: {
      description: "Resolved manifest",
      content: {
        "application/json": {
          schema: resolver(manifestResponseSchema),
        },
      },
    },
    404: {
      description: "Registry id or manifest not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    502: {
      description: "Registry is unavailable",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});
