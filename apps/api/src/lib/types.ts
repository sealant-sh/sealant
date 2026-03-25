import type {
  GitHubInstallationRepository,
  GitHubInstallationRepositoryCacheRepository,
  GitHubWebhookDeliveryRepository,
  RepositoryProfileRepository,
  SandboxAttemptRepository,
  SandboxRepository,
  SandboxRuntimeInstanceRepository,
  WorkspaceBuildJobRepository,
} from "@sealant/db";
import type { PackageStandardizer } from "@sealant/package-standardization";
import type { RegistryClient } from "@sealant/registry-integration";
import type { GitHubSourceIntegration } from "@sealant/source-integrations";

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
    gitHubSourceIntegration?: GitHubSourceIntegration;
    gitHubInstallationRepository?: GitHubInstallationRepository;
    gitHubInstallationRepositoryCacheRepository?: GitHubInstallationRepositoryCacheRepository;
    gitHubWebhookDeliveryRepository?: GitHubWebhookDeliveryRepository;
    repositoryProfileRepository?: RepositoryProfileRepository;
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
  readonly gitHubSourceIntegration?: GitHubSourceIntegration;
  readonly gitHubInstallationRepository?: GitHubInstallationRepository;
  readonly gitHubInstallationRepositoryCacheRepository?: GitHubInstallationRepositoryCacheRepository;
  readonly gitHubWebhookDeliveryRepository?: GitHubWebhookDeliveryRepository;
  readonly repositoryProfileRepository?: RepositoryProfileRepository;
  readonly sandboxRepository: SandboxRepository;
  readonly sandboxRuntimeInstanceRepository: SandboxRuntimeInstanceRepository;
  readonly sandboxAttemptRepository: SandboxAttemptRepository;
}
