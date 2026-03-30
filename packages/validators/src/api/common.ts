import { z } from "zod";

export const messageResponseSchema = z.object({
  message: z.string(),
});

export const registryIdParamsSchema = z.object({
  registryId: z.string().trim().min(1),
});
