import { z } from "zod";

import { osBuilderCompileResultSchema, type OsBuilderCompileResult } from "./builder.js";
import { sandboxBlueprintSchema, type SandboxBlueprint } from "./sandbox-blueprint.js";

const runtimeAdapterLaunchResultSchema = z.strictObject({
  adapter: z.enum(["docker", "k8s", "k3s"]),
  resourceId: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  status: z.enum(["pending", "running"]),
  endpoint: z.string().trim().min(1).optional(),
});

export const sandboxBuildSpecSchema = sandboxBlueprintSchema;

export type SandboxBuildSpec = SandboxBlueprint;

// Connected-account selection for sandbox creation: account ids (or per-provider account names).
// Resolved by the sandboxes module into blueprint runtime `credentialRefs`; never carries secret
// material. Explicit per-provider entries win over the profile's bindings.
export const newSandboxCredentialsSchema = z.object({
  profileId: z.string().trim().min(1).optional(),
  claude: z.string().trim().min(1).optional(),
  codex: z.string().trim().min(1).optional(),
  github: z.string().trim().min(1).optional(),
});

export const newSandboxSchema = sandboxBuildSpecSchema.extend({
  credentials: newSandboxCredentialsSchema.optional(),
});

export const sandboxLaunchSchema = z.strictObject({
  compile: osBuilderCompileResultSchema,
  runtime: runtimeAdapterLaunchResultSchema,
});

export const sandboxBuildSchema = osBuilderCompileResultSchema;

export type NewSandboxCredentials = z.infer<typeof newSandboxCredentialsSchema>;

export type NewSandbox = z.infer<typeof newSandboxSchema>;

export type SandboxLaunch = {
  compile: OsBuilderCompileResult;
  runtime: z.infer<typeof runtimeAdapterLaunchResultSchema>;
};

export type SandboxBuild = OsBuilderCompileResult;
