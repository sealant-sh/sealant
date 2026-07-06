import { createInsertSchema, createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import {
  githubAppInstallations,
  githubInstallationRepositories,
  githubWebhookDeliveries,
  profileStatusValues,
  workspaceAttempts,
  workspaceAttemptStatusValues,
  workspaceAttemptTriggerTypeValues,
  workspaces,
  workspaceStatusValues,
  workspaceBuildJobs,
} from "./schema.js";

export const githubAppInstallationSelectSchema = createSelectSchema(githubAppInstallations);

export const githubAppInstallationInsertSchema = createInsertSchema(githubAppInstallations);

export const githubInstallationRepositorySelectSchema = createSelectSchema(
  githubInstallationRepositories,
);

export const githubInstallationRepositoryInsertSchema = createInsertSchema(
  githubInstallationRepositories,
);

export const githubWebhookDeliverySelectSchema = createSelectSchema(githubWebhookDeliveries);

export const githubWebhookDeliveryInsertSchema = createInsertSchema(githubWebhookDeliveries);

export const workspaceBuildJobSelectSchema = createSelectSchema(workspaceBuildJobs);

export const workspaceBuildJobInsertSchema = createInsertSchema(workspaceBuildJobs);

export const workspaceBuildJobStatusSchema = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export const workspaceAttemptSelectSchema = createSelectSchema(workspaceAttempts);

export const workspaceAttemptInsertSchema = createInsertSchema(workspaceAttempts);

export const workspaceAttemptStatusSchema = Schema.Literals(workspaceAttemptStatusValues);

export const workspaceAttemptTriggerTypeSchema = Schema.Literals(workspaceAttemptTriggerTypeValues);

export const workspaceSelectSchema = createSelectSchema(workspaces);

export const workspaceInsertSchema = createInsertSchema(workspaces);

export const workspaceStatusSchema = Schema.Literals(workspaceStatusValues);

export const profileStatusSchema = Schema.Literals(profileStatusValues);
