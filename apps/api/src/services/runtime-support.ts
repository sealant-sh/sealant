import {
  WorkspaceInternalServerError,
  type WorkspaceRuntimesResponse,
} from "@sealant/api-contracts";
import {
  BOAT_RUNTIME_ID,
  runtimeArchitectureOf,
  runtimeSupport,
  type RuntimeAdapterId,
  type RuntimeInstall,
} from "@sealant/validators";
import { AGENT_DEFAULT_PORT, processImagePlatform } from "@sealant/workspaces";
import { Effect } from "effect";

import { env } from "../runtime-env.js";
import { boatLaunchable } from "./boat-availability.js";

/**
 * What this install knows that changes the runtime table, read from the API's environment. The
 * architecture of Docker and Kubernetes workspaces is the one `inspectWorkspaceImage` plans for.
 */
export const runtimeInstall = Effect.try({
  try: (): RuntimeInstall => ({
    kubernetesDocker: env.SEALANT_K8S_DOCKER_ENABLED,
    microvmDocker: env.SEALANT_MICROVM_DOCKER_ENABLED,
    microvmAgentPort: env.SEALANT_MICROVM_AGENT_PORT ?? AGENT_DEFAULT_PORT,
    containerArchitecture: runtimeArchitectureOf(
      env.SEALANT_WORKSPACE_IMAGE_PLATFORM ?? processImagePlatform(),
    ),
    // Where resource instances run (`ResourceRuntimeHostLive`): Docker beside Docker workspaces
    // and Boat's gateway, a cluster of their own on Kubernetes, nowhere otherwise.
    resourceHost:
      env.DEFAULT_RUNTIME_ADAPTER === "docker"
        ? "docker"
        : env.DEFAULT_RUNTIME_ADAPTER === "k8s" || env.DEFAULT_RUNTIME_ADAPTER === "k3s"
          ? "kubernetes"
          : "none",
  }),
  catch: (error) =>
    new WorkspaceInternalServerError({
      message: error instanceof Error ? error.message : "Failed to read the install's runtimes.",
    }),
});

/**
 * The runtimes this install launches workspaces on, as far as the API can tell: the default
 * runtime (what `auto` resolves to), then Boat where it is configured. Boat is listed only where
 * the create would not refuse it as unregistered, the default included. A runtime the worker
 * registers beside the default, which the API cannot see, is not listed.
 */
export const launchableRuntimes = Effect.gen(function* () {
  const boat = yield* boatLaunchable;
  const runtimes: RuntimeAdapterId[] = [env.DEFAULT_RUNTIME_ADAPTER, BOAT_RUNTIME_ID];
  return [...new Set(runtimes)].filter((runtime) => runtime !== BOAT_RUNTIME_ID || boat);
});

/** `GET /v1/workspaces/runtimes`: the runtime table for every runtime this install launches. */
export const listWorkspaceRuntimes = Effect.gen(function* () {
  const install = yield* runtimeInstall;
  const runtimes = yield* launchableRuntimes;
  return {
    default: env.DEFAULT_RUNTIME_ADAPTER,
    runtimes: runtimes.map((runtime) => runtimeSupport(runtime, install)),
  } satisfies WorkspaceRuntimesResponse;
});
