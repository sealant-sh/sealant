import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

import { workspaceBuildJobs } from "./schema.js";

export const workspaceBuildJobSelectSchema = createSelectSchema(workspaceBuildJobs);

export const workspaceBuildJobInsertSchema = createInsertSchema(workspaceBuildJobs);

export const workspaceBuildJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
