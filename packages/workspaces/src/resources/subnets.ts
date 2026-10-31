import { parseSubnetPool, type ResourceInstanceRepoService, type SubnetPool } from "@sealant/db";
import { Effect } from "effect";

import type { ResourceSubnets } from "./docker-resource-runtime.js";

/** A reach network holds an executor and its instances; an egress network one instance. */
const REACH_PREFIX = 27;
const EGRESS_PREFIX = 28;

export interface ResourceSubnetPools {
  readonly reach: SubnetPool;
  readonly egress: SubnetPool;
}

/** The configured ranges (`SEALANT_RESOURCE_*_SUBNETS`), carved; throws on a range that is not one. */
export const resourceSubnetPools = (ranges: {
  readonly reach: string;
  readonly egress: string;
}): ResourceSubnetPools => ({
  reach: parseSubnetPool(ranges.reach, REACH_PREFIX),
  egress: parseSubnetPool(ranges.egress, EGRESS_PREFIX),
});

/** The runtime's subnets, held in Core's table by the repository. */
export const repositorySubnets = (
  repo: ResourceInstanceRepoService,
  pools: ResourceSubnetPools,
): ResourceSubnets => ({
  allocate: async ({ name, kind, owner }) => {
    const allocation = await Effect.runPromise(
      repo.allocateNetwork({ name, kind, owner, pool: pools[kind] }),
    );
    if (allocation.kind === "pool-exhausted") {
      throw new Error(
        `Every ${kind} subnet of SEALANT_RESOURCE_${kind.toUpperCase()}_SUBNETS is in use: widen the range.`,
      );
    }
    return allocation.subnet;
  },
  release: (name) => Effect.runPromise(repo.releaseNetwork(name)),
});
