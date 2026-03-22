import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

import {
  issueStateValues,
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

export const profileStatusSchema = z.enum(profileStatusValues);

export const issueStateSchema = z.enum(issueStateValues);

export const pullRequestStateSchema = z.enum(pullRequestStateValues);
