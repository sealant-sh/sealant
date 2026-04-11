// import type {
// GitHubInstallationRepository,
// GitHubInstallationRepositoryCacheRepository,
// GitHubWebhookDeliveryRepository,
// RepositoryProfileRepository,
// SandboxAttemptRepository,
// SandboxRepository,
// SandboxRuntimeInstanceRepository,
// SandboxBuildJobRepository,
// } from "@sealant/db";
// import type {
//   // PackageStandardizer,
//   // RegistryClient,
// } from "@sealant/sandboxes";
import type { GitHubSourceIntegration } from "@sealant/source-integrations";
import type { AppEnv } from "@sealant/validators/env";
import { Context } from "effect";

export interface SandboxBuildJobPublisher {
  publishRequested(input: { jobId: string }): Promise<void>;
}

export interface AppRuntimeConfig {
  readonly env: AppEnv;
  // readonly registryClient: RegistryClient;
  // readonly sandboxBuildJobPublisher: SandboxBuildJobPublisher;
  // readonly sandboxBuildJobRepository: SandboxBuildJobRepository;
  // readonly packageStandardizer?: PackageStandardizer;
  readonly gitHubSourceIntegration?: GitHubSourceIntegration;
  // readonly gitHubInstallationRepository?: GitHubInstallationRepository;
  // readonly gitHubInstallationRepositoryCacheRepository?: GitHubInstallationRepositoryCacheRepository;
  // readonly gitHubWebhookDeliveryRepository?: GitHubWebhookDeliveryRepository;
  // readonly repositoryProfileRepository?: RepositoryProfileRepository;
  // readonly sandboxRepository: SandboxRepository;
  // readonly sandboxRuntimeInstanceRepository: SandboxRuntimeInstanceRepository;
  // readonly sandboxAttemptRepository: SandboxAttemptRepository;
}

export class ConfigService extends Context.Tag("@sealant/api/ConfigService")<
  ConfigService,
  {
    readonly env: AppRuntimeConfig["env"];
  }
>() {}

export class DependenciesService extends Context.Tag("@sealant/api/DependenciesService")<
  DependenciesService,
  Omit<AppRuntimeConfig, "env">
>() {}

export class ClockService extends Context.Tag("@sealant/api/ClockService")<
  ClockService,
  {
    now(): Date;
  }
>() {}

export class IdGeneratorService extends Context.Tag("@sealant/api/IdGeneratorService")<
  IdGeneratorService,
  {
    randomUuid(): string;
  }
>() {}

export class LoggerService extends Context.Tag("@sealant/api/LoggerService")<
  LoggerService,
  {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
  }
>() {}

export type ApiClock = Context.Tag.Service<typeof ClockService>;
export type ApiIdGenerator = Context.Tag.Service<typeof IdGeneratorService>;
export type ApiLogger = Context.Tag.Service<typeof LoggerService>;

export interface ApiRuntime {
  readonly env: AppEnv;
  readonly clock: ApiClock;
  readonly idGenerator: ApiIdGenerator;
  readonly logger: ApiLogger;
  // readonly registryClient: RegistryClient;
  // readonly sandboxBuildJobPublisher: SandboxBuildJobPublisher;
  // readonly sandboxBuildJobRepository: SandboxBuildJobRepository;
  // readonly packageStandardizer: PackageStandardizer;
  // readonly gitHubSourceIntegration?: GitHubSourceIntegration;
  // readonly gitHubInstallationRepository?: GitHubInstallationRepository;
  // readonly gitHubInstallationRepositoryCacheRepository?: GitHubInstallationRepositoryCacheRepository;
  // readonly gitHubWebhookDeliveryRepository?: GitHubWebhookDeliveryRepository;
  // readonly repositoryProfileRepository?: RepositoryProfileRepository;
  // readonly sandboxRepository: SandboxRepository;
  // readonly sandboxRuntimeInstanceRepository: SandboxRuntimeInstanceRepository;
  // readonly sandboxAttemptRepository: SandboxAttemptRepository;
}

export class ApiRuntimeService extends Context.Tag("@sealant/api/ApiRuntimeService")<
  ApiRuntimeService,
  ApiRuntime
>() {}

export interface AppBindings {
  Variables: {
    runtime: ApiRuntime;
  };
}
