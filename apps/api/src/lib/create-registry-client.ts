import { createZotRegistryClient } from "@sealant/sandboxes";

import type { AppEnv } from "../env.js";

export const createRegistryClient = (env: AppEnv) => {
  return createZotRegistryClient({
    baseUrl: env.REGISTRY_BASE_URL,
    pushRegistry: env.REGISTRY_PUSH_REGISTRY,
    ...(env.REGISTRY_USERNAME === undefined ? {} : { username: env.REGISTRY_USERNAME }),
    ...(env.REGISTRY_PASSWORD === undefined ? {} : { password: env.REGISTRY_PASSWORD }),
  });
};
