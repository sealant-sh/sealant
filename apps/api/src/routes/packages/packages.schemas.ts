import { packageResolutionSchema } from "@sealant/package-standardization";
import { z } from "zod";

export const resolvePackageQuerySchema = z.object({
  query: z.string().trim().min(1),
});

export const resolvePackageResponseSchema = packageResolutionSchema;
