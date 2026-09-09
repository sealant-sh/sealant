import type { AppEnv } from "@sealant/validators/env";
import {
  createLocalDockerImageStore,
  createZotRegistryClient,
  type RegistryClient,
} from "@sealant/workspaces";

/**
 * Where workspace images live. Unset `REGISTRY_BASE_URL` (the single-host default) means the local
 * Docker Engine: images are built, tagged, and launched on the same daemon, so nothing is pushed.
 * Set it (with `REGISTRY_PUSH_REGISTRY`) for an OCI registry — required on Kubernetes.
 */
export const createRegistryClient = (env: AppEnv): RegistryClient => {
  if (env.REGISTRY_BASE_URL === undefined) {
    return createLocalDockerImageStore();
  }
  return createZotRegistryClient({
    baseUrl: env.REGISTRY_BASE_URL,
    ...(env.REGISTRY_PUSH_REGISTRY === undefined
      ? {}
      : { pushRegistry: env.REGISTRY_PUSH_REGISTRY }),
    ...(env.REGISTRY_USERNAME === undefined ? {} : { username: env.REGISTRY_USERNAME }),
    ...(env.REGISTRY_PASSWORD === undefined ? {} : { password: env.REGISTRY_PASSWORD }),
  });
};
