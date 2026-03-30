import { z } from "zod";

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
