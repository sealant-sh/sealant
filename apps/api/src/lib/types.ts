import type {
  GitHubInstallationRepository,
  GitHubInstallationRepositoryCacheRepository,
  GitHubWebhookDeliveryRepository,
  RepositoryProfileRepository,
  SandboxAttemptRepository,
  SandboxRepository,
  SandboxRuntimeInstanceRepository,
  SandboxBuildJobRepository,
} from "@sealant/db";
import type { PackageStandardizer, RegistryClient } from "@sealant/sandboxes";
import type { GitHubSourceIntegration } from "@sealant/source-integrations";

import type { AppEnv } from "../env.js";

export interface SandboxBuildJobPublisher {
  publishRequested(input: { jobId: string }): Promise<void>;
}

export interface AppBindings {
  Variables: {
    env: AppEnv;
    registryClient: RegistryClient;
    sandboxBuildJobPublisher: SandboxBuildJobPublisher;
    sandboxBuildJobRepository: SandboxBuildJobRepository;
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
  readonly sandboxBuildJobPublisher: SandboxBuildJobPublisher;
  readonly sandboxBuildJobRepository: SandboxBuildJobRepository;
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
