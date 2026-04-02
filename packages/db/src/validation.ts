import { createInsertSchema, createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import {
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

export const sandboxBuildJobSelectSchema = createSelectSchema(sandboxBuildJobs);

export const sandboxBuildJobInsertSchema = createInsertSchema(sandboxBuildJobs);

export const sandboxBuildJobStatusSchema = Schema.Literal(
  "queued",
  "running",
  "succeeded",
  "failed",
);

export const sandboxAttemptSelectSchema = createSelectSchema(sandboxAttempts);

export const sandboxAttemptInsertSchema = createInsertSchema(sandboxAttempts);

export const sandboxAttemptStatusSchema = Schema.Literal(...sandboxAttemptStatusValues);

export const sandboxAttemptTriggerTypeSchema = Schema.Literal(...sandboxAttemptTriggerTypeValues);

export const sandboxSelectSchema = createSelectSchema(sandboxes);

export const sandboxInsertSchema = createInsertSchema(sandboxes);

export const sandboxStatusSchema = Schema.Literal(...sandboxStatusValues);

export const issueWorkflowSelectSchema = createSelectSchema(issueWorkflows);

export const issueWorkflowInsertSchema = createInsertSchema(issueWorkflows);

export const issueWorkflowStatusSchema = Schema.Literal(...issueWorkflowStatusValues);

export const issueWorkflowExecutionSelectSchema = createSelectSchema(issueWorkflowExecutions);

export const issueWorkflowExecutionInsertSchema = createInsertSchema(issueWorkflowExecutions);

export const issueWorkflowExecutionStatusSchema = Schema.Literal(
  ...issueWorkflowExecutionStatusValues,
);

export const issueWorkflowExecutionTriggerTypeSchema = Schema.Literal(
  ...issueWorkflowExecutionTriggerTypeValues,
);

export const profileStatusSchema = Schema.Literal(...profileStatusValues);

export const issueStateSchema = Schema.Literal(...issueStateValues);

export const pullRequestStateSchema = Schema.Literal(...pullRequestStateValues);
