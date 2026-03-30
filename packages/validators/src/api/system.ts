import { z } from "zod";

export const indexResponseSchema = z.object({
  name: z.string(),
  version: z.string(),
  docsPath: z.string(),
  openApiPath: z.string(),
});

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});
