import {
  createSandboxAttemptRepository,
  createDatabaseClientFromEnv,
  createSandboxRepository,
  createSandboxRuntimeInstanceRepository,
  createWorkspaceBuildJobRepository,
} from "@sealant/db";

import { env } from "./env.js";
import { configureOpenAPI } from "./lib/configure-openapi.js";
import { createApp, createRouter } from "./lib/create-app.js";
import { createRegistryClient } from "./lib/create-registry-client.js";
import { createWorkspaceBuildJobPublisher } from "./lib/create-workspace-build-job-publisher.js";
import type { AppRuntimeConfig } from "./lib/types.js";
import registries from "./routes/registries/registries.index.js";
import sandboxes from "./routes/sandboxes/sandboxes.index.js";
import system from "./routes/system/system.index.js";
import workspaceBuildJobs from "./routes/workspace-build-jobs/workspace-build-jobs.index.js";

export const createApiApp = (config: AppRuntimeConfig) => {
  const app = createApp(config);
  const routes = createRouter();

  routes.route("/", system);
  routes.route("/v1/sandboxes", sandboxes);
  routes.route("/v1/registries", registries);
  routes.route("/v1/workspace-build-jobs", workspaceBuildJobs);

  app.route("/", routes);
  configureOpenAPI(app, routes, config.env);

  return app;
};

const databaseClient = await createDatabaseClientFromEnv(env);

const app = createApiApp({
  env,
  registryClient: createRegistryClient(env),
  workspaceBuildJobPublisher: createWorkspaceBuildJobPublisher(env),
  workspaceBuildJobRepository: createWorkspaceBuildJobRepository(databaseClient),
  sandboxRepository: createSandboxRepository(databaseClient),
  sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepository(databaseClient),
  sandboxAttemptRepository: createSandboxAttemptRepository(databaseClient),
});

export default app;
