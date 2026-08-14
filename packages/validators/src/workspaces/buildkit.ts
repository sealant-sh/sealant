import { z } from "zod";

import {
  concreteWorkspaceTargetOsFamilySchema,
  osBuilderCompileInputSchema,
  osBuilderCompileResultSchema,
  type OsBuilder,
  type OsBuilderCompileInput,
} from "./builder.js";
import { workspaceBlueprintSchema, workspaceCustomizationSchema } from "./workspace-blueprint.js";

const nonEmptyStringSchema = z.string().trim().min(1);

export const buildkitTargetOsFamilySchema = concreteWorkspaceTargetOsFamilySchema;

/**
 * The managed distro families — the subset of target OS families with a distro definition
 * (base image + package manager + package map). "custom" is deliberately NOT here: a custom
 * base image skips distro package installs entirely.
 */
export const buildkitDistroOsFamilySchema = concreteWorkspaceTargetOsFamilySchema.exclude([
  "custom",
]);

// "none" is the custom-base mode: no distro package manager — requested packages install through
// the base image's own detected package manager (apt/apk/dnf/pacman) or fail readable.
export const buildkitPackageManagerSchema = z.enum(["dnf", "pacman", "nix", "apt", "none"]);

export const buildkitSecretUsePhaseSchema = z.enum(["build", "runtime"]);
export const buildkitSecretKindSchema = z.enum(["secret", "ssh-key", "ssh-known-hosts"]);

export const buildkitSecretSchema = z.strictObject({
  id: nonEmptyStringSchema,
  kind: buildkitSecretKindSchema.default("secret"),
  phase: buildkitSecretUsePhaseSchema,
  sourceRef: nonEmptyStringSchema,
});

export const resolvedImagePackageSchema = z.strictObject({
  requestId: nonEmptyStringSchema,
  requestedVersion: nonEmptyStringSchema.optional(),
  installPackages: z.array(nonEmptyStringSchema).min(1),
});

export const resolvedDotfilesPlanSchema = z.strictObject({
  sourceId: nonEmptyStringSchema,
  manager: z.enum(["auto", "chezmoi", "stow", "copy"]),
  url: z.string().url(),
  // Absent means the remote's default branch — the clone omits `--branch`.
  ref: nonEmptyStringSchema.optional(),
  target: z.enum(["home", "config"]).default("home"),
  bootstrap: z.boolean().default(true),
  bootstrapCommand: nonEmptyStringSchema.optional(),
  applyAt: z.enum(["build", "runtime"]).default("build"),
  authSecretId: nonEmptyStringSchema.optional(),
  githubInstallationRepositoryId: nonEmptyStringSchema.optional(),
});

export const resolvedImagePlanSchema = z.strictObject({
  blueprint: workspaceBlueprintSchema,
  osFamily: buildkitTargetOsFamilySchema,
  baseImage: nonEmptyStringSchema,
  packageManager: buildkitPackageManagerSchema,
  packages: z.array(resolvedImagePackageSchema).default([]),
  customization: workspaceCustomizationSchema,
  dotfiles: resolvedDotfilesPlanSchema.optional(),
  buildSecrets: z.array(buildkitSecretSchema).default([]),
  runtimeSecrets: z.array(buildkitSecretSchema).default([]),
  imageEnv: z.record(z.string(), z.string()).default({}),
  runtimeEnv: z.record(z.string(), z.string()).default({}),
});

export const buildkitBuildSpecSchema = z.strictObject({
  contextDirectory: nonEmptyStringSchema,
  containerfilePath: nonEmptyStringSchema,
  imageReference: nonEmptyStringSchema,
  push: z.boolean().default(true),
  secrets: z
    .array(
      z.strictObject({
        id: nonEmptyStringSchema,
        sourceRef: nonEmptyStringSchema,
      }),
    )
    .default([]),
  buildArgs: z.record(z.string(), z.string()).default({}),
});

export const buildkitOsBuilderCompileInputSchema = osBuilderCompileInputSchema;

export const buildkitOsBuilderCompileResultSchema = osBuilderCompileResultSchema.extend({
  buildkit: z.strictObject({
    imagePlan: resolvedImagePlanSchema,
    spec: buildkitBuildSpecSchema,
  }),
});

export const parseBuildkitBuildSpec = (input: unknown): BuildkitBuildSpec => {
  return buildkitBuildSpecSchema.parse(input);
};

export const parseResolvedImagePlan = (input: unknown): ResolvedImagePlan => {
  return resolvedImagePlanSchema.parse(input);
};

export const parseBuildkitOsBuilderCompileInput = (
  input: unknown,
): BuildkitOsBuilderCompileInput => {
  return buildkitOsBuilderCompileInputSchema.parse(input);
};

export const parseBuildkitOsBuilderCompileResult = (
  input: unknown,
): BuildkitOsBuilderCompileResult => {
  return buildkitOsBuilderCompileResultSchema.parse(input);
};

export type BuildkitTargetOsFamily = z.infer<typeof buildkitTargetOsFamilySchema>;

export type BuildkitDistroOsFamily = z.infer<typeof buildkitDistroOsFamilySchema>;

export type BuildkitPackageManager = z.infer<typeof buildkitPackageManagerSchema>;

export type BuildkitSecretUsePhase = z.infer<typeof buildkitSecretUsePhaseSchema>;

export type BuildkitSecretKind = z.infer<typeof buildkitSecretKindSchema>;

export type BuildkitSecret = z.infer<typeof buildkitSecretSchema>;

export type ResolvedImagePackage = z.infer<typeof resolvedImagePackageSchema>;

export type ResolvedDotfilesPlan = z.infer<typeof resolvedDotfilesPlanSchema>;

export type ResolvedImagePlan = z.infer<typeof resolvedImagePlanSchema>;

export type BuildkitBuildSpec = z.infer<typeof buildkitBuildSpecSchema>;

export type BuildkitOsBuilderCompileInput = z.infer<typeof buildkitOsBuilderCompileInputSchema>;

export type BuildkitOsBuilderCompileResult = z.infer<typeof buildkitOsBuilderCompileResultSchema>;

export interface BuildkitOsBuilder extends OsBuilder {
  readonly buildTool: "buildkit";
  readonly osFamily: BuildkitTargetOsFamily;

  compile(input: OsBuilderCompileInput): Promise<BuildkitOsBuilderCompileResult>;
}
