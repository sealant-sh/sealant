import {
  osExecutorCompileResultSchema,
  userWorkspaceSpecSchema,
  type OsExecutorCompileResult,
  type UserWorkspaceSpec,
} from "@sealant/workspace-composition";
import { z } from "zod";

const runtimeAdapterLaunchResultSchema = z.strictObject({
  adapter: z.enum(["docker", "k8s", "k3s"]),
  resourceId: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  status: z.enum(["pending", "running"]),
  endpoint: z.string().trim().min(1).optional(),
});

export const workspaceBuildJobRequestPayloadSchema = userWorkspaceSpecSchema;

export const workspaceBuildJobRuntimeResultPayloadSchema = z.strictObject({
  compile: osExecutorCompileResultSchema,
  runtime: runtimeAdapterLaunchResultSchema,
});

export const workspaceBuildJobResultPayloadSchema = z.union([
  osExecutorCompileResultSchema,
  workspaceBuildJobRuntimeResultPayloadSchema,
]);

export type WorkspaceBuildJobRequestPayload = UserWorkspaceSpec;

export type WorkspaceBuildJobRuntimeResultPayload = {
  compile: OsExecutorCompileResult;
  runtime: z.infer<typeof runtimeAdapterLaunchResultSchema>;
};

export type WorkspaceBuildJobResultPayload =
  | OsExecutorCompileResult
  | WorkspaceBuildJobRuntimeResultPayload;
