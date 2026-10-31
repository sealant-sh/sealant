/**
 * The runtime that runs a resource domain's instances, or the name of the runtime this Sealant
 * runs instead. Resource instances run on Docker only: a deployment whose workspaces run anywhere
 * else refuses every route that would touch one, by its runtime's name.
 */
import { ResourceInstanceRepo } from "@sealant/db";
import {
  DockerResourceRuntime,
  repositorySubnets,
  resourceSubnetPools,
  type ResourceRuntime,
} from "@sealant/workspaces";
import { Context, Effect, Layer } from "effect";

import { env } from "../runtime-env.js";

export type ResourceRuntimeHostShape =
  | { readonly kind: "docker"; readonly runtime: ResourceRuntime }
  | { readonly kind: "unsupported"; readonly runtime: string };

export class ResourceRuntimeHost extends Context.Service<
  ResourceRuntimeHost,
  ResourceRuntimeHostShape
>()("@sealant/api/ResourceRuntimeHost") {}

export const ResourceRuntimeHostLive: Layer.Layer<
  ResourceRuntimeHost,
  never,
  ResourceInstanceRepo
> = Layer.effect(
  ResourceRuntimeHost,
  Effect.gen(function* () {
    if (env.DEFAULT_RUNTIME_ADAPTER !== "docker") {
      return { kind: "unsupported", runtime: env.DEFAULT_RUNTIME_ADAPTER } as const;
    }
    const repo = yield* ResourceInstanceRepo;
    const pools = resourceSubnetPools({
      reach: env.SEALANT_RESOURCE_REACH_SUBNETS,
      egress: env.SEALANT_RESOURCE_EGRESS_SUBNETS,
    });
    return {
      kind: "docker",
      runtime: new DockerResourceRuntime({
        subnets: repositorySubnets(repo, pools),
        dockerSocketPath: env.DOCKER_SOCKET_PATH,
        ...(env.SEALANT_DOCKER_NETWORK_GUARD_IMAGE === undefined
          ? {}
          : { guardImage: env.SEALANT_DOCKER_NETWORK_GUARD_IMAGE }),
      }),
    } as const;
  }),
);
