import { z } from "zod";

import {
  concreteSandboxTargetOsFamilySchema,
  osBuilderCompileInputSchema,
  osBuilderCompileResultSchema,
  type OsBuilder,
  type OsBuilderCompileInput,
} from "./builder.js";
import { sandboxBlueprintSchema, sandboxCustomizationSchema } from "./sandbox-blueprint.js";

const nonEmptyStringSchema = z.string().trim().min(1);

export const buildkitTargetOsFamilySchema = concreteSandboxTargetOsFamilySchema;

export const buildkitPackageManagerSchema = z.enum(["dnf", "pacman", "nix"]);

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
  ref: nonEmptyStringSchema,
  target: z.enum(["home", "config"]).default("home"),
  bootstrap: z.boolean().default(true),
  bootstrapCommand: nonEmptyStringSchema.optional(),
  applyAt: z.enum(["build", "runtime"]).default("build"),
  authSecretId: nonEmptyStringSchema.optional(),
  githubInstallationRepositoryId: nonEmptyStringSchema.optional(),
});

export const resolvedImagePlanSchema = z.strictObject({
  blueprint: sandboxBlueprintSchema,
  osFamily: buildkitTargetOsFamilySchema,
  baseImage: nonEmptyStringSchema,
  packageManager: buildkitPackageManagerSchema,
  packages: z.array(resolvedImagePackageSchema).default([]),
  customization: sandboxCustomizationSchema,
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
