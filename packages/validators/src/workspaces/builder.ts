import { z } from "zod";

import { workspaceBlueprintSchema, workspaceTargetOsFamilySchema } from "./workspace-blueprint.js";

export const osBuilderIdSchema = z.enum(["nix", "fedora", "arch"]);

export const concreteWorkspaceTargetOsFamilySchema = workspaceTargetOsFamilySchema.exclude([
  "auto",
]);

export const osBuilderSupportFailureReasonSchema = z.enum([
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

export const osBuilderSupportSchema = z.discriminatedUnion("supported", [
  z.strictObject({
    supported: z.literal(true),
  }),
  z.strictObject({
    supported: z.literal(false),
    reason: osBuilderSupportFailureReasonSchema,
    message: z.string().trim().min(1),
  }),
]);

export const osBuilderCompileInputSchema = z.strictObject({
  blueprint: workspaceBlueprintSchema,
});

export const osBuilderCompileMetadataSchema = z.strictObject({
  defaultArtifactName: z.string().trim().min(1).optional(),
  notes: z.array(z.string().trim().min(1)).default([]),
});

export const osBuilderCompileResultSchema = z.strictObject({
  builder: z.strictObject({
    id: osBuilderIdSchema,
    osFamily: concreteWorkspaceTargetOsFamilySchema,
  }),
  artifacts: z.array(buildArtifactSchema).min(1),
  metadata: osBuilderCompileMetadataSchema.optional(),
});

export const parseBuildArtifact = (input: unknown): BuildArtifact => {
  return buildArtifactSchema.parse(input);
};

export const parseOsBuilderSupport = (input: unknown): OsBuilderSupport => {
  return osBuilderSupportSchema.parse(input);
};

export const parseOsBuilderCompileInput = (input: unknown): OsBuilderCompileInput => {
  return osBuilderCompileInputSchema.parse(input);
};

export const parseOsBuilderCompileResult = (input: unknown): OsBuilderCompileResult => {
  return osBuilderCompileResultSchema.parse(input);
};

export type OsBuilderId = z.infer<typeof osBuilderIdSchema>;

export type ConcreteWorkspaceTargetOsFamily = z.infer<typeof concreteWorkspaceTargetOsFamilySchema>;

export type OsBuilderSupportFailureReason = z.infer<typeof osBuilderSupportFailureReasonSchema>;

export type OciImageBuildArtifact = z.infer<typeof ociImageBuildArtifactSchema>;

export type FilesystemClosureBuildArtifact = z.infer<typeof filesystemClosureBuildArtifactSchema>;

export type ManifestBuildArtifact = z.infer<typeof manifestBuildArtifactSchema>;

export type MetadataBuildArtifact = z.infer<typeof metadataBuildArtifactSchema>;

export type BuildArtifact = z.infer<typeof buildArtifactSchema>;

export type OsBuilderSupport = z.infer<typeof osBuilderSupportSchema>;

export type OsBuilderCompileInput = z.infer<typeof osBuilderCompileInputSchema>;

export type OsBuilderCompileMetadata = z.infer<typeof osBuilderCompileMetadataSchema>;

export type OsBuilderCompileResult = z.infer<typeof osBuilderCompileResultSchema>;

export interface OsBuilder {
  readonly id: OsBuilderId;
  readonly osFamily: ConcreteWorkspaceTargetOsFamily;

  supports(input: OsBuilderCompileInput): OsBuilderSupport;
  compile(input: OsBuilderCompileInput): Promise<OsBuilderCompileResult>;
}
