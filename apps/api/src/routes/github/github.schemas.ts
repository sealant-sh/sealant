import { z } from "zod";

export const githubInstallationIdParamsSchema = z.object({
  installationId: z.string().trim().min(1),
});

export const githubInstallationsQuerySchema = z.object({
  userId: z.string().trim().min(1),
});

export const githubInstallationRepositoriesQuerySchema = z.object({
  userId: z.string().trim().min(1),
  search: z.string().trim().min(1).optional(),
});

export const githubInstallationSummarySchema = z.object({
  installationId: z.string(),
  externalInstallationId: z.string(),
  accountLogin: z.string(),
  accountType: z.enum(["organization", "user"]),
  status: z.enum(["active", "suspended", "deleted"]),
  repositorySelection: z.enum(["all", "selected"]),
  lastSyncedAt: z.string().datetime().optional(),
});

export const githubInstallationRepositorySummarySchema = z.object({
  installationRepositoryId: z.string(),
  installationId: z.string(),
  repositoryId: z.string(),
  externalRepositoryId: z.string(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  defaultBranch: z.string(),
  isPrivate: z.boolean(),
  isArchived: z.boolean(),
  lastSyncedAt: z.string().datetime().optional(),
});

export const listGitHubInstallationsResponseSchema = z.object({
  items: z.array(githubInstallationSummarySchema),
});

export const listGitHubInstallationRepositoriesResponseSchema = z.object({
  items: z.array(githubInstallationRepositorySummarySchema),
});

export const syncGitHubInstallationResponseSchema = z.object({
  installationId: z.string(),
  syncedRepositoryCount: z.number().int().nonnegative(),
  syncedAt: z.string().datetime(),
});

export const githubWebhookResponseSchema = z.object({
  deliveryId: z.string(),
  status: z.enum(["received", "processed", "failed", "ignored"]),
});
