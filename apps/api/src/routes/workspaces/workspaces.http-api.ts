import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  listWorkspaceCredentials,
  putWorkspaceCredentials,
  releaseWorkspaceCredentials,
} from "./workspace-credentials.js";
import { applyWorkspaceDotfiles } from "./workspace-dotfiles.js";
import {
  inspectWorkspaceImage,
  bindWorkspace,
  cancelWorkspaceCreate,
  createWorkspace,
  execWorkspace,
  expireWorkspace,
  flushWorkspaceCapture,
  getWorkspace,
  getWorkspaceCaptureStatus,
  getWorkspaceCreate,
  getWorkspaceSshTarget,
  listWorkspaceAttempts,
  listWorkspaceEvents,
  listWorkspaces,
  renameWorkspace,
  clearWorkspaceSshUser,
  replanWorkspaceCapture,
  recoverWorkspace,
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
      .handle("getWorkspaceCreate", ({ params, query }) =>
        getWorkspaceCreate({
          idempotencyKey: params.idempotencyKey,
          ownerUserId: query.ownerUserId,
        }),
      )
      .handle("cancelWorkspaceCreate", ({ params, payload }) =>
        cancelWorkspaceCreate({
          idempotencyKey: params.idempotencyKey,
          payload,
        }),
      )
      .handle("execWorkspace", ({ params, payload }) =>
        execWorkspace({
          workspaceId: params.workspaceId,
          payload,
        }),
      )
      .handle("execWorkspaceAsUser", ({ params, payload }) =>
        execWorkspace({
          workspaceId: params.workspaceId,
          payload,
          asUser: true,
        }),
      )
      .handle("applyWorkspaceDotfiles", ({ params, payload }) =>
        applyWorkspaceDotfiles({
          workspaceId: params.workspaceId,
          payload,
        }),
      )
      .handle("bindWorkspace", ({ params, payload }) =>
        bindWorkspace({
          workspaceId: params.workspaceId,
          payload,
        }),
      )
      .handle("flushWorkspaceCapture", ({ params, payload }) =>
        flushWorkspaceCapture({
          workspaceId: params.workspaceId,
          payload,
        }),
      )
      .handle("getWorkspaceCaptureStatus", ({ params, query }) =>
        getWorkspaceCaptureStatus({
          workspaceId: params.workspaceId,
          query,
        }),
      )
      .handle("replanWorkspaceCapture", ({ params, payload }) =>
        replanWorkspaceCapture({
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
      .handle("recoverWorkspace", ({ params, payload }) =>
        recoverWorkspace({
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
      .handle("inspectWorkspaceImage", ({ payload }) => inspectWorkspaceImage({ payload }))
      .handle("putWorkspaceCredentials", ({ params, payload }) =>
        putWorkspaceCredentials({ workspaceId: params.workspaceId, payload }),
      )
      .handle("releaseWorkspaceCredentials", ({ params, query }) =>
        releaseWorkspaceCredentials({ workspaceId: params.workspaceId, query }),
      )
      .handle("listWorkspaceCredentials", ({ params, query }) =>
        listWorkspaceCredentials({ workspaceId: params.workspaceId, query }),
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
      .handle("clearWorkspaceSshUser", ({ params, query }) =>
        clearWorkspaceSshUser({
          workspaceId: params.workspaceId,
          query,
        }),
      )
      .handle("listWorkspaces", ({ query }) => listWorkspaces(query))
      .handle("getWorkspace", ({ params, query }) =>
        getWorkspace(params.workspaceId, query.ownerUserId),
      )
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
