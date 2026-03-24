import {
  createGitHubInstallationRepository,
  createGitHubInstallationRepositoryCacheRepository,
  createGitHubWebhookDeliveryRepository,
  createPackageResolutionCacheRepository,
  createRepositoryProfileRepository,
  createSandboxAttemptRepository,
  createDatabaseClientFromEnv,
  createSandboxRepository,
  createSandboxRuntimeInstanceRepository,
  createWorkspaceBuildJobRepository,
} from "@sealant/db";
import { createGitHubSourceIntegration } from "@sealant/source-integrations";

import { env } from "./env.js";
import { configureOpenAPI } from "./lib/configure-openapi.js";
import { createApp, createRouter } from "./lib/create-app.js";
import { createApiPackageStandardizer } from "./lib/create-package-standardizer.js";
import { createRegistryClient } from "./lib/create-registry-client.js";
import { createWorkspaceBuildJobPublisher } from "./lib/create-workspace-build-job-publisher.js";
import type { AppRuntimeConfig } from "./lib/types.js";
import github from "./routes/github/github.index.js";
import packages from "./routes/packages/packages.index.js";
import registries from "./routes/registries/registries.index.js";
import sandboxes from "./routes/sandboxes/sandboxes.index.js";
import system from "./routes/system/system.index.js";
import workspaceBuildJobs from "./routes/workspace-build-jobs/workspace-build-jobs.index.js";

export const createApiApp = (config: AppRuntimeConfig) => {
  const app = createApp(config);
  const routes = createRouter();

  routes.route("/", system);
  routes.route("/v1/packages", packages);
  routes.route("/v1/sandboxes", sandboxes);
  routes.route("/v1/registries", registries);
  routes.route("/v1/github", github);
  routes.route("/v1/workspace-build-jobs", workspaceBuildJobs);

  app.route("/", routes);
  configureOpenAPI(app, routes, config.env);

  return app;
};

const databaseClient = await createDatabaseClientFromEnv(env);
const packageResolutionCacheRepository = createPackageResolutionCacheRepository(databaseClient);
const repositoryProfileRepository = createRepositoryProfileRepository(databaseClient);
const gitHubInstallationRepository = createGitHubInstallationRepository(databaseClient);
const gitHubInstallationRepositoryCacheRepository =
  createGitHubInstallationRepositoryCacheRepository(databaseClient);
const gitHubWebhookDeliveryRepository = createGitHubWebhookDeliveryRepository(databaseClient);
const packageStandardizer = createApiPackageStandardizer({
  env,
  cacheRepository: packageResolutionCacheRepository,
});

const app = createApiApp({
  env,
  registryClient: createRegistryClient(env),
  workspaceBuildJobPublisher: createWorkspaceBuildJobPublisher(env),
  workspaceBuildJobRepository: createWorkspaceBuildJobRepository(databaseClient),
  packageStandardizer,
  gitHubSourceIntegration: createGitHubSourceIntegration({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
    apiBaseUrl: env.GITHUB_API_BASE_URL,
  }),
  gitHubInstallationRepository,
  gitHubInstallationRepositoryCacheRepository,
  gitHubWebhookDeliveryRepository,
  repositoryProfileRepository,
  sandboxRepository: createSandboxRepository(databaseClient),
  sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepository(databaseClient),
  sandboxAttemptRepository: createSandboxAttemptRepository(databaseClient),
});

export default app;
