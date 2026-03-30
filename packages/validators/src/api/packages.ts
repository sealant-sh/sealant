import { z } from "zod";

export const packageTargetOsSchema = z.enum(["arch", "fedora", "nix"]);

export const packageResolutionStatusSchema = z.enum([
  "resolved",
  "ambiguous",
  "unsupported",
  "not-found",
  "invalid",
]);

export const packageResolutionSourceSchema = z.enum(["cache", "repology", "override"]);

export const packageOsSupportSchema = z.strictObject({
  supported: z.boolean(),
  repo: z.string().trim().min(1).optional(),
  packageName: z.string().trim().min(1).optional(),
  projectName: z.string().trim().min(1).optional(),
  version: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
});

export const packageResolutionAlternativeSchema = z.strictObject({
  projectName: z.string().trim().min(1),
});

export const packageResolutionSchema = z.strictObject({
  requested: z.string().trim().min(1),
  normalized: z.string().trim().min(1),
  status: packageResolutionStatusSchema,
  source: packageResolutionSourceSchema,
  canonicalId: z.string().trim().min(1).optional(),
  selectedProject: z.string().trim().min(1).optional(),
  osSupport: z.strictObject({
    arch: packageOsSupportSchema,
    fedora: packageOsSupportSchema,
    nix: packageOsSupportSchema,
  }),
  alternatives: z.array(packageResolutionAlternativeSchema).default([]),
  fetchedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type PackageTargetOs = z.infer<typeof packageTargetOsSchema>;
export type PackageResolutionStatus = z.infer<typeof packageResolutionStatusSchema>;
export type PackageResolution = z.infer<typeof packageResolutionSchema>;

export const resolvePackageQuerySchema = z.object({
  query: z.string().trim().min(1),
  targetOs: packageTargetOsSchema.default("fedora"),
});

export const resolvePackageResponseSchema = packageResolutionSchema;
