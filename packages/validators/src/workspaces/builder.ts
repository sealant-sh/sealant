import { z } from "zod";

import { workspaceBlueprintSchema, workspaceTargetOsFamilySchema } from "./workspace-blueprint.js";

export const osBuilderIdSchema = z.enum(["nix", "fedora", "arch", "ubuntu", "custom"]);

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
  loader: z.enum(["docker-load", "docker-engine", "registry"]).optional(),
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

/**
 * What the image probe found inside a built workspace image: whether it can run one Linux user per
 * person (Mend's ADR 0016). The image writes it to `/etc/sealant/image-probe.json` in its last
 * filesystem step; the builder that can read it back records it on the build. Facts only: the
 * verdict is derived from them (`imagePersonLayoutSupport` in `@sealant/workspaces`), and runtime
 * facts such as ACL support on `/workspace` are not in it.
 */
export const workspaceImageProbeSchema = z.object({
  version: z.literal(1),
  tools: z.object({
    sudo: z.boolean(),
    /** `sudo` carries its setuid bit (the nix store cannot hold one). */
    sudoSetuid: z.boolean(),
    useradd: z.boolean(),
    groupadd: z.boolean(),
    setfacl: z.boolean(),
    getfacl: z.boolean(),
    setpriv: z.boolean(),
    /** Absent from images probed before it was recorded: unknown. */
    flock: z.boolean().optional(),
  }),
  /** `/etc/sudoers.d/mend` exists: the `mend` group's passwordless rule. */
  sudoersMend: z.boolean(),
  /** `/etc/sudoers` reads `/etc/sudoers.d`, so a rule can be added there. */
  sudoersIncludesDir: z.boolean(),
  /**
   * The probe ran under `no_new_privs`, where `sudo` cannot raise a person's privileges. Always
   * false at build; a probe run at prepare sees the runtime's (Kubernetes pods set it).
   */
  noNewPrivileges: z.boolean(),
  /** `/etc/passwd` is a regular, writable file (on nix it links into the read-only store). */
  passwdWritable: z.boolean(),
  /** The `mend` group: gid 40000, missing, or the name or the gid taken by something else. */
  mendGroup: z.enum(["present", "absent", "conflict"]),
  /** Users and groups other than `mend` in the reserved id range 40000–49999, as `user:name:id`. */
  reservedIdsInUse: z.array(z.string()),
  /** `/etc/sealant/person-env` exists: the environment of a process run as a person. */
  personEnv: z.boolean(),
  /** The shared toolchain and cache directories the image names, for the default ACL at boot. */
  sharedDirs: z.array(z.string()),
  /**
   * What `sealantd capabilities --json` printed: null when that sealantd has no such command,
   * `"unreadable"` when it answered with something other than a JSON object.
   */
  sealantd: z.union([z.record(z.string(), z.unknown()), z.literal("unreadable")]).nullable(),
});

export const osBuilderCompileMetadataSchema = z.strictObject({
  defaultArtifactName: z.string().trim().min(1).optional(),
  notes: z.array(z.string().trim().min(1)).default([]),
  /**
   * Content hash of the resolved build inputs (the rendered Containerfile). Two compiles with the
   * same hash produce identical image content, so a publish whose hash matches an already-published
   * image can be skipped entirely.
   */
  planHash: z.string().trim().min(1).optional(),
  /**
   * The image probe's answer, read back from the built image. Absent for images built before the
   * probe, and for builders that cannot read the image back (they leave the answer in the image).
   */
  imageProbe: workspaceImageProbeSchema.optional(),
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

export const parseWorkspaceImageProbe = (input: unknown): WorkspaceImageProbe => {
  return workspaceImageProbeSchema.parse(input);
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

export type WorkspaceImageProbe = z.infer<typeof workspaceImageProbeSchema>;

export type OsBuilderCompileResult = z.infer<typeof osBuilderCompileResultSchema>;

export interface OsBuilder {
  readonly id: OsBuilderId;
  readonly osFamily: ConcreteWorkspaceTargetOsFamily;

  supports(input: OsBuilderCompileInput): OsBuilderSupport;
  compile(input: OsBuilderCompileInput): Promise<OsBuilderCompileResult>;
}
