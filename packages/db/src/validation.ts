import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

import {
  issueStateValues,
  profileStatusValues,
  pullRequestStateValues,
  workspaceBuildJobs,
  workspaceRunStatusValues,
  workspaceRuns,
  workspaceRunTriggerTypeValues,
} from "./schema.js";

export const workspaceBuildJobSelectSchema = createSelectSchema(workspaceBuildJobs);

export const workspaceBuildJobInsertSchema = createInsertSchema(workspaceBuildJobs);

export const workspaceBuildJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);

export const workspaceRunSelectSchema = createSelectSchema(workspaceRuns);

export const workspaceRunInsertSchema = createInsertSchema(workspaceRuns);

export const workspaceRunStatusSchema = z.enum(workspaceRunStatusValues);

export const workspaceRunTriggerTypeSchema = z.enum(workspaceRunTriggerTypeValues);

export const profileStatusSchema = z.enum(profileStatusValues);

export const issueStateSchema = z.enum(issueStateValues);

export const pullRequestStateSchema = z.enum(pullRequestStateValues);
