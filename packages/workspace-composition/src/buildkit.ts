import { z } from "zod";

import { workspaceBlueprintSchema, workspaceCustomizationSchema } from "./blueprint.js";
import {
  concreteWorkspaceTargetOsFamilySchema,
  osExecutorCompileInputSchema,
  osExecutorCompileResultSchema,
  type OsExecutor,
  type OsExecutorCompileInput,
} from "./executor.js";

const nonEmptyStringSchema = z.string().trim().min(1);

// BuildKit is the first concrete image-build path we want to model. It targets
// the concrete distro families that can be compiled into OCI images.
export const buildkitTargetOsFamilySchema = concreteWorkspaceTargetOsFamilySchema;

export const buildkitPackageManagerSchema = z.enum(["dnf", "pacman", "nix"]);

// Secret refs stay opaque to the composition layer. Executors know how to turn
// a ref into a mounted secret, but the shared plan only tracks when and why a
// secret is needed.
export const buildkitSecretUsePhaseSchema = z.enum(["build", "runtime"]);
export const buildkitSecretKindSchema = z.enum(["secret", "ssh-key", "ssh-known-hosts"]);

export const buildkitSecretSchema = z.strictObject({
  id: nonEmptyStringSchema,
  kind: buildkitSecretKindSchema.default("secret"),
  phase: buildkitSecretUsePhaseSchema,
  sourceRef: nonEmptyStringSchema,
});

// Package requests remain symbolic in the blueprint, but BuildKit needs fully
// resolved distro package names before it can render a Containerfile.
export const resolvedImagePackageSchema = z.strictObject({
  requestId: nonEmptyStringSchema,
  requestedVersion: nonEmptyStringSchema.optional(),
  installPackages: z.array(nonEmptyStringSchema).min(1),
});

export const resolvedDotfilesPlanSchema = z.strictObject({
  sourceId: nonEmptyStringSchema,
  manager: z.literal("chezmoi"),
  url: z.string().url(),
  ref: nonEmptyStringSchema,
  authSecretId: nonEmptyStringSchema.optional(),
});

// `ResolvedImagePlan` is the bridge between an OS-agnostic workspace blueprint
// and a concrete BuildKit render. Everything here is resolved enough to render a
// Containerfile without further product- or UI-level lookups.
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
  imageEnv: z.record(z.string()).default({}),
  runtimeEnv: z.record(z.string()).default({}),
});

// The BuildKit spec is the concrete handoff to a builder service: a generated
// build context, the Containerfile path, resolved secret mounts, and the output
// image reference to push.
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
  buildArgs: z.record(z.string()).default({}),
});

export const buildkitOsExecutorCompileInputSchema = osExecutorCompileInputSchema;

export const buildkitOsExecutorCompileResultSchema = osExecutorCompileResultSchema.extend({
  buildkit: z.strictObject({
    imagePlan: resolvedImagePlanSchema,
    spec: buildkitBuildSpecSchema,
  }),
});

export const parseBuildkitBuildSpec = (input: unknown): BuildkitBuildSpec =>
  buildkitBuildSpecSchema.parse(input);

export const parseResolvedImagePlan = (input: unknown): ResolvedImagePlan =>
  resolvedImagePlanSchema.parse(input);

export const parseBuildkitOsExecutorCompileInput = (
  input: unknown,
): BuildkitOsExecutorCompileInput => buildkitOsExecutorCompileInputSchema.parse(input);

export const parseBuildkitOsExecutorCompileResult = (
  input: unknown,
): BuildkitOsExecutorCompileResult => buildkitOsExecutorCompileResultSchema.parse(input);

export type BuildkitTargetOsFamily = z.infer<typeof buildkitTargetOsFamilySchema>;

export type BuildkitPackageManager = z.infer<typeof buildkitPackageManagerSchema>;

export type BuildkitSecretUsePhase = z.infer<typeof buildkitSecretUsePhaseSchema>;

export type BuildkitSecretKind = z.infer<typeof buildkitSecretKindSchema>;

export type BuildkitSecret = z.infer<typeof buildkitSecretSchema>;

export type ResolvedImagePackage = z.infer<typeof resolvedImagePackageSchema>;

export type ResolvedDotfilesPlan = z.infer<typeof resolvedDotfilesPlanSchema>;

export type ResolvedImagePlan = z.infer<typeof resolvedImagePlanSchema>;

export type BuildkitBuildSpec = z.infer<typeof buildkitBuildSpecSchema>;

export type BuildkitOsExecutorCompileInput = z.infer<typeof buildkitOsExecutorCompileInputSchema>;

export type BuildkitOsExecutorCompileResult = z.infer<typeof buildkitOsExecutorCompileResultSchema>;

// `BuildkitOsExecutor.compile()` is the concrete contract for backends that turn
// a normalized workspace blueprint into both standard artifacts and a BuildKit
// handoff spec.
export interface BuildkitOsExecutor extends OsExecutor {
  readonly buildTool: "buildkit";
  readonly osFamily: BuildkitTargetOsFamily;

  compile(input: OsExecutorCompileInput): Promise<BuildkitOsExecutorCompileResult>;
}
