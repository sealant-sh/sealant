import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/http-api";

import {
  decideResourceDomainMember,
  ensureResourceDomain,
  getResourceDomain,
  listResourceDomainMembers,
} from "./resource-domains.module.js";

export const ResourceDomainsHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "resourceDomains",
  (handlers) =>
    handlers
      .handle("ensureResourceDomain", ({ payload }) => ensureResourceDomain(payload))
      .handle("getResourceDomain", ({ params }) => getResourceDomain(params.resourceDomainId))
      .handle("grantResourceDomainMember", ({ params, payload }) =>
        decideResourceDomainMember(params, "member", payload.expectedVersion),
      )
      .handle("revokeResourceDomainMember", ({ params, payload }) =>
        decideResourceDomainMember(params, "revoked", payload.expectedVersion),
      )
      .handle("listResourceDomainMembers", ({ params }) =>
        listResourceDomainMembers(params.resourceDomainId),
      ),
);
