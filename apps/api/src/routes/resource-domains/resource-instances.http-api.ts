import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/http-api";

import {
  archiveResourceDomain,
  archiveResourceInstance,
  getResourceInstance,
  linkResourceWorkspace,
  listResourceInstances,
  stopResourceInstance,
  upResourceInstance,
} from "./resource-instances.module.js";

export const ResourceInstancesHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "resourceInstances",
  (handlers) =>
    handlers
      .handle("upResourceInstance", ({ params, payload }) =>
        upResourceInstance(params.resourceDomainId, params.key, payload),
      )
      .handle("listResourceInstances", ({ params, query }) =>
        listResourceInstances(params.resourceDomainId, query.archived === "true"),
      )
      .handle("getResourceInstance", ({ params }) =>
        getResourceInstance(params.resourceDomainId, params.key),
      )
      .handle("stopResourceInstance", ({ params, payload }) =>
        stopResourceInstance(params.resourceDomainId, params.key, payload.by),
      )
      .handle("archiveResourceInstance", ({ params }) =>
        archiveResourceInstance(params.resourceDomainId, params.key),
      )
      .handle("linkResourceWorkspace", ({ params, payload }) =>
        linkResourceWorkspace(
          params.resourceDomainId,
          params.workspaceId,
          payload.worktreeKey,
          payload.aliases ?? null,
        ),
      )
      .handle("archiveResourceDomain", ({ params }) =>
        archiveResourceDomain(params.resourceDomainId),
      ),
);
