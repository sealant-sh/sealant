import {
  osExecutorCompileResultSchema,
  userWorkspaceSpecSchema,
  type OsExecutorCompileResult,
  type UserWorkspaceSpec,
} from "@sealant/workspace-composition";

export const workspaceBuildJobRequestPayloadSchema = userWorkspaceSpecSchema;

export const workspaceBuildJobResultPayloadSchema = osExecutorCompileResultSchema;

export type WorkspaceBuildJobRequestPayload = UserWorkspaceSpec;

export type WorkspaceBuildJobResultPayload = OsExecutorCompileResult;
