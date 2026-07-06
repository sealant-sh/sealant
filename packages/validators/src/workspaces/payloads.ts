import { z } from "zod";

import { osBuilderCompileResultSchema, type OsBuilderCompileResult } from "./builder.js";
import { workspaceBlueprintSchema, type WorkspaceBlueprint } from "./workspace-blueprint.js";

const runtimeAdapterLaunchResultSchema = z.strictObject({
  adapter: z.enum(["docker", "k8s", "k3s"]),
  resourceId: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  status: z.enum(["pending", "running"]),
  endpoint: z.string().trim().min(1).optional(),
});

export const workspaceBuildSpecSchema = workspaceBlueprintSchema;

export type WorkspaceBuildSpec = WorkspaceBlueprint;

// Connected-account selection for workspace creation: account ids (or per-provider account names).
// Resolved by the workspaces module into blueprint runtime `credentialRefs`; never carries secret
// material. Explicit per-provider entries win over the profile's bindings.
export const newWorkspaceCredentialsSchema = z.object({
  profileId: z.string().trim().min(1).optional(),
  claude: z.string().trim().min(1).optional(),
  codex: z.string().trim().min(1).optional(),
  github: z.string().trim().min(1).optional(),
});

export const newWorkspaceSchema = workspaceBuildSpecSchema.extend({
  credentials: newWorkspaceCredentialsSchema.optional(),
});

export const workspaceLaunchSchema = z.strictObject({
  compile: osBuilderCompileResultSchema,
  runtime: runtimeAdapterLaunchResultSchema,
});

export const workspaceBuildSchema = osBuilderCompileResultSchema;

export type NewWorkspaceCredentials = z.infer<typeof newWorkspaceCredentialsSchema>;

export type NewWorkspace = z.infer<typeof newWorkspaceSchema>;

export type WorkspaceLaunch = {
  compile: OsBuilderCompileResult;
  runtime: z.infer<typeof runtimeAdapterLaunchResultSchema>;
};

export type WorkspaceBuild = OsBuilderCompileResult;
