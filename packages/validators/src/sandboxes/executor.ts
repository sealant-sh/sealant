import { z } from "zod";

import { workspaceBlueprintSchema, workspaceTargetOsFamilySchema } from "./workspace-blueprint.js";

export const osExecutorIdSchema = z.enum(["nix", "fedora", "arch"]);

export const concreteWorkspaceTargetOsFamilySchema = workspaceTargetOsFamilySchema.exclude([
  "auto",
]);

export const osExecutorSupportFailureReasonSchema = z.enum([
  "unsupported-os",
  "unsupported-harness",
  "unsupported-package",
  "unsupported-access-mode",
  "unsupported-runtime-requirement",
]);

export const ociImageBuildArtifactSchema = z.strictObject({
  kind: z.literal("oci-image"),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1).optional(),
  reference: z.string().trim().min(1).optional(),
  loader: z.enum(["docker-load", "registry"]).optional(),
});

export const filesystemClosureBuildArtifactSchema = z.strictObject({
  kind: z.literal("filesystem-closure"),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1),
});

export const manifestBuildArtifactSchema = z.strictObject({
  kind: z.literal("manifest"),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1),
  format: z.enum(["json", "yaml"]),
});

export const metadataBuildArtifactSchema = z.strictObject({
  kind: z.literal("metadata"),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1),
  format: z.literal("json"),
});

export const buildArtifactSchema = z.discriminatedUnion("kind", [
  ociImageBuildArtifactSchema,
  filesystemClosureBuildArtifactSchema,
  manifestBuildArtifactSchema,
  metadataBuildArtifactSchema,
]);

export const osExecutorSupportSchema = z.discriminatedUnion("supported", [
  z.strictObject({
    supported: z.literal(true),
  }),
  z.strictObject({
    supported: z.literal(false),
    reason: osExecutorSupportFailureReasonSchema,
    message: z.string().trim().min(1),
  }),
]);

export const osExecutorCompileInputSchema = z.strictObject({
  blueprint: workspaceBlueprintSchema,
});

export const osExecutorCompileMetadataSchema = z.strictObject({
  defaultArtifactName: z.string().trim().min(1).optional(),
  notes: z.array(z.string().trim().min(1)).default([]),
});

export const osExecutorCompileResultSchema = z.strictObject({
  executor: z.strictObject({
    id: osExecutorIdSchema,
    osFamily: concreteWorkspaceTargetOsFamilySchema,
  }),
  artifacts: z.array(buildArtifactSchema).min(1),
  metadata: osExecutorCompileMetadataSchema.optional(),
});

export const parseBuildArtifact = (input: unknown): BuildArtifact => {
  return buildArtifactSchema.parse(input);
};

export const parseOsExecutorSupport = (input: unknown): OsExecutorSupport => {
  return osExecutorSupportSchema.parse(input);
};

export const parseOsExecutorCompileInput = (input: unknown): OsExecutorCompileInput => {
  return osExecutorCompileInputSchema.parse(input);
};

export const parseOsExecutorCompileResult = (input: unknown): OsExecutorCompileResult => {
  return osExecutorCompileResultSchema.parse(input);
};

export type OsExecutorId = z.infer<typeof osExecutorIdSchema>;

export type ConcreteWorkspaceTargetOsFamily = z.infer<typeof concreteWorkspaceTargetOsFamilySchema>;

export type OsExecutorSupportFailureReason = z.infer<typeof osExecutorSupportFailureReasonSchema>;

export type OciImageBuildArtifact = z.infer<typeof ociImageBuildArtifactSchema>;

export type FilesystemClosureBuildArtifact = z.infer<typeof filesystemClosureBuildArtifactSchema>;

export type ManifestBuildArtifact = z.infer<typeof manifestBuildArtifactSchema>;

export type MetadataBuildArtifact = z.infer<typeof metadataBuildArtifactSchema>;

export type BuildArtifact = z.infer<typeof buildArtifactSchema>;

export type OsExecutorSupport = z.infer<typeof osExecutorSupportSchema>;

export type OsExecutorCompileInput = z.infer<typeof osExecutorCompileInputSchema>;

export type OsExecutorCompileMetadata = z.infer<typeof osExecutorCompileMetadataSchema>;

export type OsExecutorCompileResult = z.infer<typeof osExecutorCompileResultSchema>;

export interface OsExecutor {
  readonly id: OsExecutorId;
  readonly osFamily: ConcreteWorkspaceTargetOsFamily;

  supports(input: OsExecutorCompileInput): OsExecutorSupport;
  compile(input: OsExecutorCompileInput): Promise<OsExecutorCompileResult>;
}
