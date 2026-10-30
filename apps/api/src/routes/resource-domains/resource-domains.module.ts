/**
 * Resource domain handlers (see the contract's header). A service key manages a domain: the
 * transport refuses every other bearer with `401` before these run. A deployment served without
 * authentication (`SEALANT_ALLOW_OPEN_API`, development only) serves them as it serves every
 * credential route: refusing only these would protect nothing there and keep a developer's
 * loopback control plane from ensuring a domain.
 */
import {
  ResourceDomainForbiddenError,
  ResourceDomainInternalServerError,
  ResourceDomainNotFoundError,
  type EnsureResourceDomainRequest,
  type ResourceDomainWire,
} from "@sealant/api-contracts";
import { ResourceDomainRepo, type ResourceDomainRecord } from "@sealant/db";
import { Effect } from "effect";

import { CurrentPrincipal } from "../../services/service-principals.js";

const requireServiceKey = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  if (principal.kind !== "service" && principal.kind !== "open") {
    return yield* new ResourceDomainForbiddenError({
      message: "A service key is required to manage resource domains.",
    });
  }
});

const toWire = (domain: ResourceDomainRecord): ResourceDomainWire => ({
  resourceDomainId: domain.id,
  key: domain.key,
  createdAt: domain.createdAt.toISOString(),
});

const internal = (message: string) => () => new ResourceDomainInternalServerError({ message });

export const ensureResourceDomain = (payload: EnsureResourceDomainRequest) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const repo = yield* ResourceDomainRepo;
    const { domain, created } = yield* repo
      .ensure(payload.key)
      .pipe(Effect.mapError(internal("Failed to ensure the resource domain.")));
    return { ...toWire(domain), created };
  });

export const getResourceDomain = (resourceDomainId: string) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const repo = yield* ResourceDomainRepo;
    const domain = yield* repo
      .get(resourceDomainId)
      .pipe(Effect.mapError(internal("Failed to load the resource domain.")));
    if (domain === undefined) {
      return yield* new ResourceDomainNotFoundError({ message: "Resource domain not found." });
    }
    return toWire(domain);
  });
