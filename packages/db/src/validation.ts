import { createInsertSchema, createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import {
  githubAppInstallations,
  githubInstallationRepositories,
  githubWebhookDeliveries,
  issueStateValues,
  issueWorkflowExecutions,
  issueWorkflowExecutionStatusValues,
  issueWorkflowExecutionTriggerTypeValues,
  issueWorkflows,
  issueWorkflowStatusValues,
  profileStatusValues,
  pullRequestStateValues,
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

export const issueWorkflowSelectSchema = createSelectSchema(issueWorkflows);

export const issueWorkflowInsertSchema = createInsertSchema(issueWorkflows);

export const issueWorkflowStatusSchema = Schema.Literals(issueWorkflowStatusValues);

export const issueWorkflowExecutionSelectSchema = createSelectSchema(issueWorkflowExecutions);

export const issueWorkflowExecutionInsertSchema = createInsertSchema(issueWorkflowExecutions);

export const issueWorkflowExecutionStatusSchema = Schema.Literals(issueWorkflowExecutionStatusValues);

export const issueWorkflowExecutionTriggerTypeSchema = Schema.Literals(issueWorkflowExecutionTriggerTypeValues);

export const profileStatusSchema = Schema.Literals(profileStatusValues);

export const issueStateSchema = Schema.Literals(issueStateValues);

export const pullRequestStateSchema = Schema.Literals(pullRequestStateValues);
