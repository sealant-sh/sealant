import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/http-api";

import {
  decideResourceDomainMember,
  ensureResourceDomain,
  getResourceDomainMember,
  getResourceDomain,
  getResourceDomainBudget,
  listResourceDomainMembers,
  setResourceDomainBudget,
} from "./resource-domains.module.js";

export const ResourceDomainsHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "resourceDomains",
  (handlers) =>
    handlers
      .handle("ensureResourceDomain", ({ payload }) => ensureResourceDomain(payload))
      .handle("getResourceDomain", ({ params }) => getResourceDomain(params.resourceDomainId))
      .handle("grantResourceDomainMember", ({ params, payload }) =>
        decideResourceDomainMember(params, "member", payload.version),
      )
      .handle("revokeResourceDomainMember", ({ params, payload }) =>
        decideResourceDomainMember(params, "revoked", payload.version),
      )
      .handle("getResourceDomainMember", ({ params }) => getResourceDomainMember(params))
      .handle("listResourceDomainMembers", ({ params, query }) =>
        listResourceDomainMembers(params.resourceDomainId, query),
      )
      .handle("getResourceDomainBudget", ({ params }) =>
        getResourceDomainBudget(params.resourceDomainId),
      )
      .handle("setResourceDomainBudget", ({ params, payload }) =>
        setResourceDomainBudget(params.resourceDomainId, payload),
      ),
);
