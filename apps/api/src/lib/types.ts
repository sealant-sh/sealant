import type {
  SandboxAttemptRepository,
  SandboxRepository,
  SandboxRuntimeInstanceRepository,
  WorkspaceBuildJobRepository,
} from "@sealant/db";
import type { PackageStandardizer } from "@sealant/package-standardization";
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
    packageStandardizer: PackageStandardizer;
    sandboxRepository: SandboxRepository;
    sandboxRuntimeInstanceRepository: SandboxRuntimeInstanceRepository;
    sandboxAttemptRepository: SandboxAttemptRepository;
  };
}

export interface AppRuntimeConfig {
  readonly env: AppEnv;
  readonly registryClient: RegistryClient;
  readonly workspaceBuildJobPublisher: WorkspaceBuildJobPublisher;
  readonly workspaceBuildJobRepository: WorkspaceBuildJobRepository;
  readonly packageStandardizer?: PackageStandardizer;
  readonly sandboxRepository: SandboxRepository;
  readonly sandboxRuntimeInstanceRepository: SandboxRuntimeInstanceRepository;
  readonly sandboxAttemptRepository: SandboxAttemptRepository;
}
