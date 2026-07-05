import { createInsertSchema, createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import {
  githubAppInstallations,
  githubInstallationRepositories,
  githubWebhookDeliveries,
  profileStatusValues,
  sandboxAttempts,
  sandboxAttemptStatusValues,
  sandboxAttemptTriggerTypeValues,
  sandboxes,
  sandboxStatusValues,
  sandboxBuildJobs,
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

export const sandboxBuildJobSelectSchema = createSelectSchema(sandboxBuildJobs);

export const sandboxBuildJobInsertSchema = createInsertSchema(sandboxBuildJobs);

export const sandboxBuildJobStatusSchema = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export const sandboxAttemptSelectSchema = createSelectSchema(sandboxAttempts);

export const sandboxAttemptInsertSchema = createInsertSchema(sandboxAttempts);

export const sandboxAttemptStatusSchema = Schema.Literals(sandboxAttemptStatusValues);

export const sandboxAttemptTriggerTypeSchema = Schema.Literals(sandboxAttemptTriggerTypeValues);

export const sandboxSelectSchema = createSelectSchema(sandboxes);

export const sandboxInsertSchema = createInsertSchema(sandboxes);

export const sandboxStatusSchema = Schema.Literals(sandboxStatusValues);

export const profileStatusSchema = Schema.Literals(profileStatusValues);
