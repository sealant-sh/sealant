import { z } from "zod";

import { workspaceBlueprintSchema, workspaceTargetOsFamilySchema } from "./blueprint.js";

// Executor ids are the stable composition-layer names for concrete OS backends.
// We keep them small and explicit so selection logic can reason about available
// backends without importing package-specific implementation details.
export const osExecutorIdSchema = z.enum(["nix", "fedora", "arch"]);

// Once an executor is selected it must represent a concrete OS family. `auto`
// is valid user intent in the blueprint, but it is not a valid identity for a
// backend that is actually compiling artifacts.
export const concreteWorkspaceTargetOsFamilySchema = workspaceTargetOsFamilySchema.exclude(["auto"]);

// Support failures are normalized because the composition layer needs a uniform
// way to explain why a backend cannot handle a blueprint. That lets selection,
// diagnostics, and UI messaging all work from the same vocabulary.
export const osExecutorSupportFailureReasonSchema = z.enum([
  "unsupported-os",
  "unsupported-harness",
  "unsupported-package",
  "unsupported-access-mode",
  "unsupported-runtime-requirement",
]);

// OCI images are a first-class artifact kind because some runtimes want a
// container image as the handoff boundary. We model the reference and loading
// mode here so runtime adapters can consume the result without guessing how the
// image should be made available.
export const ociImageBuildArtifactSchema = z.strictObject({
  kind: z.literal("oci-image"),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1).optional(),
  reference: z.string().trim().min(1).optional(),
  loader: z.enum(["docker-load", "registry"]).optional(),
});

// Some OS backends may produce a filesystem closure or unpacked root instead of
// a container image. This artifact kind preserves that possibility while still
// giving the composition layer a typed, standardized result.
export const filesystemClosureBuildArtifactSchema = z.strictObject({
  kind: z.literal("filesystem-closure"),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1),
});

// Manifest artifacts cover backend outputs such as deployment descriptors or
// machine-readable launch documents. They are separate from metadata because a
// manifest is intended to be consumed operationally by another system.
export const manifestBuildArtifactSchema = z.strictObject({
  kind: z.literal("manifest"),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1),
  format: z.enum(["json", "yaml"]),
});

// Metadata artifacts are for auxiliary machine-readable outputs such as the
// compiled spec, build info, or other executor-emitted context that should move
// alongside the main artifact set.
export const metadataBuildArtifactSchema = z.strictObject({
  kind: z.literal("metadata"),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1),
  format: z.literal("json"),
});

// A discriminated union gives every executor one shared artifact vocabulary. OS
// backends can differ in what they produce, but the composition layer and later
// runtime adapters can still consume the results through one contract.
export const buildArtifactSchema = z.discriminatedUnion("kind", [
  ociImageBuildArtifactSchema,
  filesystemClosureBuildArtifactSchema,
  manifestBuildArtifactSchema,
  metadataBuildArtifactSchema,
]);

// Support checks are a dedicated object because executor selection happens
// before compilation. The composition layer needs a cheap, uniform answer to
// "can you handle this blueprint?" before it calls `compile`.
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

// Compile input is intentionally tiny today: executors consume the normalized
// blueprint and nothing more. Keeping this small prevents backend-specific
// parameters from leaking upward into the composition layer too early.
export const osExecutorCompileInputSchema = z.strictObject({
  blueprint: workspaceBlueprintSchema,
});

// Compile metadata is optional side-channel information about the result set.
// It exists so executors can nominate a default artifact or attach notes without
// polluting the primary artifact contract itself.
export const osExecutorCompileMetadataSchema = z.strictObject({
  defaultArtifactName: z.string().trim().min(1).optional(),
  notes: z.array(z.string().trim().min(1)).default([]),
});

// The compile result is the core handoff between composition and the rest of the
// system. It records which concrete executor ran, what OS family it represents,
// and which standardized artifacts came out of compilation.
export const osExecutorCompileResultSchema = z.strictObject({
  executor: z.strictObject({
    id: osExecutorIdSchema,
    osFamily: concreteWorkspaceTargetOsFamilySchema,
  }),
  artifacts: z.array(buildArtifactSchema).min(1),
  metadata: osExecutorCompileMetadataSchema.optional(),
});

// Parse helpers exist so callers can validate unknown data at the boundaries of
// the system instead of manually invoking `.parse(...)` throughout the codebase.
export const parseBuildArtifact = (input: unknown): BuildArtifact => buildArtifactSchema.parse(input);

export const parseOsExecutorSupport = (input: unknown): OsExecutorSupport =>
  osExecutorSupportSchema.parse(input);

export const parseOsExecutorCompileInput = (input: unknown): OsExecutorCompileInput =>
  osExecutorCompileInputSchema.parse(input);

export const parseOsExecutorCompileResult = (input: unknown): OsExecutorCompileResult =>
  osExecutorCompileResultSchema.parse(input);

export type OsExecutorId = z.infer<typeof osExecutorIdSchema>;

export type ConcreteWorkspaceTargetOsFamily = z.infer<typeof concreteWorkspaceTargetOsFamilySchema>;

export type OsExecutorSupportFailureReason = z.infer<
  typeof osExecutorSupportFailureReasonSchema
>;

export type OciImageBuildArtifact = z.infer<typeof ociImageBuildArtifactSchema>;

export type FilesystemClosureBuildArtifact = z.infer<typeof filesystemClosureBuildArtifactSchema>;

export type ManifestBuildArtifact = z.infer<typeof manifestBuildArtifactSchema>;

export type MetadataBuildArtifact = z.infer<typeof metadataBuildArtifactSchema>;

export type BuildArtifact = z.infer<typeof buildArtifactSchema>;

export type OsExecutorSupport = z.infer<typeof osExecutorSupportSchema>;

export type OsExecutorCompileInput = z.infer<typeof osExecutorCompileInputSchema>;

export type OsExecutorCompileMetadata = z.infer<typeof osExecutorCompileMetadataSchema>;

export type OsExecutorCompileResult = z.infer<typeof osExecutorCompileResultSchema>;

// `OsExecutor` is the behavioral contract OS backends implement. We keep the
// interface next to the schemas so the data contracts and the runtime behavior
// contract stay defined in one place.
export interface OsExecutor {
  readonly id: OsExecutorId;
  readonly osFamily: ConcreteWorkspaceTargetOsFamily;

  supports(input: OsExecutorCompileInput): OsExecutorSupport;
  compile(input: OsExecutorCompileInput): Promise<OsExecutorCompileResult>;
}
