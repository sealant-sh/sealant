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

export const newSandboxSchema = sandboxBuildSpecSchema;

export const sandboxLaunchSchema = z.strictObject({
  compile: osBuilderCompileResultSchema,
  runtime: runtimeAdapterLaunchResultSchema,
});

export const sandboxBuildSchema = osBuilderCompileResultSchema;

export type NewSandbox = SandboxBuildSpec;

export type SandboxLaunch = {
  compile: OsBuilderCompileResult;
  runtime: z.infer<typeof runtimeAdapterLaunchResultSchema>;
};

export type SandboxBuild = OsBuilderCompileResult;
