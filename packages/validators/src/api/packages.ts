import { packageResolutionSchema, packageTargetOsSchema } from "@sealant/package-standardization";
import { z } from "zod";

export const resolvePackageQuerySchema = z.object({
  query: z.string().trim().min(1),
  targetOs: packageTargetOsSchema.default("fedora"),
});

export const resolvePackageResponseSchema = packageResolutionSchema;
