import { z } from "zod";

// This schema mirrors the current Nix-facing spec consumed by the existing
// builder. It is intentionally separate from the shared WorkspaceBlueprint so we
// can translate the OS-agnostic contract into the specific shape the Nix backend
// already understands today.

const nonEmptyStringSchema = z.string().trim().min(1);

// The Nix executor supports the same harness set as the current Nix builder.
// Keeping this explicit here lets the mapper fail early before anything reaches
// Nix evaluation.
export const nixExecutorHarnessSchema = z.enum(["opencode", "codex", "claude-code"]);

// Home Manager and pinned config repo wiring are still Nix-specific concerns.
// They remain optional here because the minimal wrapper path intentionally does
// not produce them yet, but the schema keeps room for the existing builder shape.
export const nixExecutorConfigSchema = z.strictObject({
  repoUrl: z.string().url(),
  repoRef: nonEmptyStringSchema.default("main"),
  repoRev: nonEmptyStringSchema,
  homeManagerModules: z.array(nonEmptyStringSchema).default([]),
});

// This is the concrete spec that the current Nix builder consumes.
export const nixExecutorSpecSchema = z.strictObject({
  harness: nixExecutorHarnessSchema,
  imageName: nonEmptyStringSchema.default("sealant-workspace-demo"),
  repoUrl: z.string().url(),
  repoRef: nonEmptyStringSchema.default("main"),
  extraPackages: z.array(nonEmptyStringSchema).default([]),
  env: z.record(z.string()).default({}),
  nixConfig: nixExecutorConfigSchema.nullable().optional(),
});

export const parseNixExecutorSpec = (input: unknown): NixExecutorSpec =>
  nixExecutorSpecSchema.parse(input);

export type NixExecutorHarness = z.infer<typeof nixExecutorHarnessSchema>;

export type NixExecutorConfig = z.infer<typeof nixExecutorConfigSchema>;

export type NixExecutorSpec = z.infer<typeof nixExecutorSpecSchema>;
