/**
 * The runtime that runs a resource domain's instances, or the name of the runtime this Sealant
 * runs instead. Docker supports workspace and caller reach. Kubernetes supports caller reach.
 * Other providers refuse these operations by runtime name.
 */
import { CredentialCipher } from "@sealant/credentials";
import { ResourceInstanceRepo } from "@sealant/db";
import {
  DockerResourceRuntime,
  KubernetesCallerRuntime,
  parseResourceCallers,
  repositorySubnets,
  resourceSubnetPools,
  type ResourceRuntime,
} from "@sealant/workspaces";
import { Context, Effect, Layer } from "effect";

import { env } from "../runtime-env.js";

export type ResourceRuntimeHostShape =
  | {
      readonly kind: "kubernetes";
      readonly runtime: ResourceRuntime;
      readonly secretEnvAvailable?: boolean;
    }
  | {
      readonly kind: "docker";
      readonly runtime: ResourceRuntime;
      readonly secretEnvAvailable?: boolean;
    }
  | { readonly kind: "unsupported"; readonly runtime: string };

export class ResourceRuntimeHost extends Context.Service<
  ResourceRuntimeHost,
  ResourceRuntimeHostShape
>()("@sealant/api/ResourceRuntimeHost") {}

export const ResourceRuntimeHostLive: Layer.Layer<
  ResourceRuntimeHost,
  never,
  ResourceInstanceRepo | CredentialCipher
> = Layer.effect(
  ResourceRuntimeHost,
  Effect.gen(function* () {
    const cipher = yield* CredentialCipher;
    const callers = parseResourceCallers(env.SEALANT_RESOURCE_CALLERS);
    if (env.DEFAULT_RUNTIME_ADAPTER === "k8s" || env.DEFAULT_RUNTIME_ADAPTER === "k3s")
      return {
        kind: "kubernetes",
        secretEnvAvailable: env.SEALANT_CREDENTIALS_KEY !== undefined,
        runtime: new KubernetesCallerRuntime({
          namespace: env.SEALANT_RESOURCE_K8S_NAMESPACE,
          callers,
          cipher,
          networkPolicyEnforced: env.SEALANT_RESOURCE_K8S_NETWORK_POLICY,
          ...(env.SEALANT_RESOURCE_K8S_KUBECONFIG === undefined
            ? {}
            : { kubeconfigPath: env.SEALANT_RESOURCE_K8S_KUBECONFIG }),
        }),
      } as const;
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
      secretEnvAvailable: env.SEALANT_CREDENTIALS_KEY !== undefined,
      runtime: new DockerResourceRuntime({
        callers,
        cipher,
        ...(env.SEALANT_RESOURCE_CALLER_GUARD_IMAGE === undefined
          ? {}
          : { callerGuardImage: env.SEALANT_RESOURCE_CALLER_GUARD_IMAGE }),
        subnets: repositorySubnets(repo, pools),
        dockerSocketPath: env.DOCKER_SOCKET_PATH,
        ...(env.SEALANT_DOCKER_NETWORK_GUARD_IMAGE === undefined
          ? {}
          : { guardImage: env.SEALANT_DOCKER_NETWORK_GUARD_IMAGE }),
      }),
    } as const;
  }),
);
