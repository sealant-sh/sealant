import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  createWorkspace,
  execWorkspace,
  expireWorkspace,
  getWorkspace,
  getWorkspaceSshTarget,
  listWorkspaceAttempts,
  listWorkspaceEvents,
  listWorkspaces,
  renameWorkspace,
  restartWorkspace,
  stopWorkspace,
} from "./workspaces.module.js";

export const WorkspacesHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "workspaces",
  (handlers) => {
    return handlers
      .handle("createWorkspace", ({ headers, payload }) =>
        createWorkspace({
          headers,
          payload,
        }),
      )
      .handle("execWorkspace", ({ params, payload }) =>
        execWorkspace({
          workspaceId: params.workspaceId,
          payload,
        }),
      )
      .handle("stopWorkspace", ({ params, payload }) =>
        stopWorkspace({
          workspaceId: params.workspaceId,
          payload,
        }),
      )
      .handle("restartWorkspace", ({ params, payload }) =>
        restartWorkspace({
          workspaceId: params.workspaceId,
          payload,
        }),
      )
      .handle("expireWorkspace", ({ params, payload }) =>
        expireWorkspace({
          workspaceId: params.workspaceId,
          payload,
        }),
      )
      .handle("renameWorkspace", ({ params, payload }) =>
        renameWorkspace({
          workspaceId: params.workspaceId,
          payload,
        }),
      )
      .handle("listWorkspaces", ({ query }) => listWorkspaces(query))
      .handle("getWorkspace", ({ params }) => getWorkspace(params.workspaceId))
      .handle("listWorkspaceAttempts", ({ params, query }) =>
        listWorkspaceAttempts({
          workspaceId: params.workspaceId,
          query,
        }),
      )
      .handle("listWorkspaceEvents", ({ params, query }) =>
        listWorkspaceEvents({
          workspaceId: params.workspaceId,
          query,
        }),
      )
      .handle("getWorkspaceSshTarget", ({ params, headers }) =>
        getWorkspaceSshTarget({
          workspaceId: params.workspaceId,
          headers,
        }),
      );
  },
);
