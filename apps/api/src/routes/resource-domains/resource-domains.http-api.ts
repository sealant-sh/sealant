import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/http-api";

import { ensureResourceDomain, getResourceDomain } from "./resource-domains.module.js";

export const ResourceDomainsHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "resourceDomains",
  (handlers) =>
    handlers
      .handle("ensureResourceDomain", ({ payload }) => ensureResourceDomain(payload))
      .handle("getResourceDomain", ({ params }) => getResourceDomain(params.resourceDomainId)),
);
