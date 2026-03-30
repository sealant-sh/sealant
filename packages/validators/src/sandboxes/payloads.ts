import { z } from "zod";

import { osExecutorCompileResultSchema, type OsExecutorCompileResult } from "./executor.js";
import { workspaceBlueprintSchema, type WorkspaceBlueprint } from "./workspace-blueprint.js";

const runtimeAdapterLaunchResultSchema = z.strictObject({
  adapter: z.enum(["docker", "k8s", "k3s"]),
  resourceId: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  status: z.enum(["pending", "running"]),
  endpoint: z.string().trim().min(1).optional(),
});

export const sandboxBuildSpecSchema = workspaceBlueprintSchema;

export type SandboxBuildSpec = WorkspaceBlueprint;

export const workspaceBuildJobRequestPayloadSchema = sandboxBuildSpecSchema;

export const workspaceBuildJobRuntimeResultPayloadSchema = z.strictObject({
  compile: osExecutorCompileResultSchema,
  runtime: runtimeAdapterLaunchResultSchema,
});

export const workspaceBuildJobResultPayloadSchema = osExecutorCompileResultSchema;

export type WorkspaceBuildJobRequestPayload = SandboxBuildSpec;

export type WorkspaceBuildJobRuntimeResultPayload = {
  compile: OsExecutorCompileResult;
  runtime: z.infer<typeof runtimeAdapterLaunchResultSchema>;
};

export type WorkspaceBuildJobResultPayload = OsExecutorCompileResult;
