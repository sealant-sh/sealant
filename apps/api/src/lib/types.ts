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
import type { AppEnv } from "@sealant/validators/env";

export interface SandboxBuildJobPublisher {
  publishRequested(input: { jobId: string }): Promise<void>;
}

export interface ApiClock {
  now(): Date;
}

export interface ApiIdGenerator {
  randomUuid(): string;
}

export interface ApiLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface ApiRuntime {
  readonly env: AppEnv;
  readonly clock: ApiClock;
  readonly idGenerator: ApiIdGenerator;
  readonly logger: ApiLogger;
  readonly registryClient: RegistryClient;
  readonly sandboxBuildJobPublisher: SandboxBuildJobPublisher;
  readonly sandboxBuildJobRepository: SandboxBuildJobRepository;
  readonly packageStandardizer: PackageStandardizer;
  readonly gitHubSourceIntegration?: GitHubSourceIntegration;
  readonly gitHubInstallationRepository?: GitHubInstallationRepository;
  readonly gitHubInstallationRepositoryCacheRepository?: GitHubInstallationRepositoryCacheRepository;
  readonly gitHubWebhookDeliveryRepository?: GitHubWebhookDeliveryRepository;
  readonly repositoryProfileRepository?: RepositoryProfileRepository;
  readonly sandboxRepository: SandboxRepository;
  readonly sandboxRuntimeInstanceRepository: SandboxRuntimeInstanceRepository;
  readonly sandboxAttemptRepository: SandboxAttemptRepository;
}

export interface AppBindings {
  Variables: {
    runtime: ApiRuntime;
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
