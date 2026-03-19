import type { WorkspaceBuildJobRepository } from "@sealant/db";
import type { RegistryClient } from "@sealant/registry-integration";

import type { AppEnv } from "../env.js";

export interface WorkspaceBuildJobPublisher {
  publishRequested(input: { jobId: string }): Promise<void>;
}

export interface AppBindings {
  Variables: {
    env: AppEnv;
    registryClient: RegistryClient;
    workspaceBuildJobPublisher: WorkspaceBuildJobPublisher;
    workspaceBuildJobRepository: WorkspaceBuildJobRepository;
  };
}

export interface AppRuntimeConfig {
  readonly env: AppEnv;
  readonly registryClient: RegistryClient;
  readonly workspaceBuildJobPublisher: WorkspaceBuildJobPublisher;
  readonly workspaceBuildJobRepository: WorkspaceBuildJobRepository;
}
