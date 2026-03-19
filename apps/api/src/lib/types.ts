import type { RegistryClient } from "@sealant/registry-integration";

import type { AppEnv } from "../env.js";

export interface AppBindings {
  Variables: {
    env: AppEnv;
    registryClient: RegistryClient;
  };
}

export interface AppRuntimeConfig {
  readonly env: AppEnv;
  readonly registryClient: RegistryClient;
}
