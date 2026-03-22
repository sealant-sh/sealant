import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

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
  workspaceBuildJobs,
} from "./schema.js";

export const workspaceBuildJobSelectSchema = createSelectSchema(workspaceBuildJobs);

export const workspaceBuildJobInsertSchema = createInsertSchema(workspaceBuildJobs);

export const workspaceBuildJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);

export const sandboxAttemptSelectSchema = createSelectSchema(sandboxAttempts);

export const sandboxAttemptInsertSchema = createInsertSchema(sandboxAttempts);

export const sandboxAttemptStatusSchema = z.enum(sandboxAttemptStatusValues);

export const sandboxAttemptTriggerTypeSchema = z.enum(sandboxAttemptTriggerTypeValues);

export const sandboxSelectSchema = createSelectSchema(sandboxes);

export const sandboxInsertSchema = createInsertSchema(sandboxes);

export const sandboxStatusSchema = z.enum(sandboxStatusValues);

export const issueWorkflowSelectSchema = createSelectSchema(issueWorkflows);

export const issueWorkflowInsertSchema = createInsertSchema(issueWorkflows);

export const issueWorkflowStatusSchema = z.enum(issueWorkflowStatusValues);

export const issueWorkflowExecutionSelectSchema = createSelectSchema(issueWorkflowExecutions);

export const issueWorkflowExecutionInsertSchema = createInsertSchema(issueWorkflowExecutions);

export const issueWorkflowExecutionStatusSchema = z.enum(issueWorkflowExecutionStatusValues);

export const issueWorkflowExecutionTriggerTypeSchema = z.enum(
  issueWorkflowExecutionTriggerTypeValues,
);

export const profileStatusSchema = z.enum(profileStatusValues);

export const issueStateSchema = z.enum(issueStateValues);

export const pullRequestStateSchema = z.enum(pullRequestStateValues);
