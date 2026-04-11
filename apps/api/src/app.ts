/**
 * @deprecated Legacy non-Effect implementation disabled during Effect migration.
 * Original code is intentionally commented out below.
 */

// import {
//   createGitHubInstallationRepository,
//   createGitHubInstallationRepositoryCacheRepository,
//   createGitHubWebhookDeliveryRepository,
//   createPackageResolutionCacheRepository,
//   createRepositoryProfileRepository,
//   createDatabaseClientFromEnv,
//   createSandboxAttemptRepository,
//   createSandboxRepository,
//   createSandboxRuntimeInstanceRepository,
//   createSandboxBuildJobRepository,
// } from "@sealant/db";
// import { createGitHubSourceIntegration } from "@sealant/source-integrations";
//
// import { configureOpenAPI } from "./lib/configure-openapi.js";
// import { createApp } from "./lib/create-app.js";
// // import { createRouter } from "./lib/create-app.js";
// import { createApiPackageStandardizer } from "./lib/create-package-standardizer.js";
// import { createRegistryClient } from "./lib/create-registry-client.js";
// import { createSandboxBuildJobPublisher } from "./lib/create-sandbox-build-job-publisher.js";
// import type { AppRuntimeConfig } from "./lib/types.js";
// import { createGitHubWebHandler } from "./routes/github/github.http-api.js";
// // import packages from "./routes/packages/packages.index.js";
// // import registries from "./routes/registries/registries.index.js";
// // import sandboxes from "./routes/sandboxes/sandboxes.index.js";
// // import system from "./routes/system/system.index.js";
// import { env } from "./runtime-env.js";
//
// export const createApiApp = (config: AppRuntimeConfig) => {
//   const app = createApp(config);
//
//   // DEPRECATED: legacy Hono routes are disabled during Effect migration.
//   // const routes = createRouter();
//   // routes.route("/", system);
//   // routes.route("/v1/packages", packages);
//   // routes.route("/v1/sandboxes", sandboxes);
//   // routes.route("/v1/registries", registries);
//   // app.route("/", routes);
//
//   app.mount("/v1/github", createGitHubWebHandler(config));
//
//   // DEPRECATED: OpenAPI docs for legacy Hono routes are disabled during Effect migration.
//   // configureOpenAPI(app, routes, config.env);
//
//   configureOpenAPI(app, app, config.env);
//
//   return app;
// };
//
// export const createDefaultAppRuntimeConfig = async (): Promise<AppRuntimeConfig> => {
//   const databaseClient = await createDatabaseClientFromEnv(env);
//   const packageResolutionCacheRepository = createPackageResolutionCacheRepository(databaseClient);
//   const repositoryProfileRepository = createRepositoryProfileRepository(databaseClient);
//   const gitHubInstallationRepository = createGitHubInstallationRepository(databaseClient);
//   const gitHubInstallationRepositoryCacheRepository =
//     createGitHubInstallationRepositoryCacheRepository(databaseClient);
//   const gitHubWebhookDeliveryRepository = createGitHubWebhookDeliveryRepository(databaseClient);
//   const packageStandardizer = createApiPackageStandardizer({
//     env,
//     cacheRepository: packageResolutionCacheRepository,
//   });
//
//   return {
//     env,
//     registryClient: createRegistryClient(env),
//     sandboxBuildJobPublisher: createSandboxBuildJobPublisher(env),
//     sandboxBuildJobRepository: createSandboxBuildJobRepository(databaseClient),
//     packageStandardizer,
//     gitHubSourceIntegration: createGitHubSourceIntegration({
//       apiBaseUrl: env.GITHUB_API_BASE_URL,
//       ...(env.GITHUB_APP_ID === undefined ? {} : { appId: env.GITHUB_APP_ID }),
//       ...(env.GITHUB_APP_PRIVATE_KEY === undefined
//         ? {}
//         : { privateKey: env.GITHUB_APP_PRIVATE_KEY }),
//       ...(env.GITHUB_APP_WEBHOOK_SECRET === undefined
//         ? {}
//         : { webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET }),
//     }),
//     gitHubInstallationRepository,
//     gitHubInstallationRepositoryCacheRepository,
//     gitHubWebhookDeliveryRepository,
//     repositoryProfileRepository,
//     sandboxRepository: createSandboxRepository(databaseClient),
//     sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepository(databaseClient),
//     sandboxAttemptRepository: createSandboxAttemptRepository(databaseClient),
//   };
// };
//
// /**
//  * Creates the default API app with runtime infrastructure wiring.
//  *
//  * DB initialization is intentionally done here (instead of module top-level) so tests and tools
//  * can import the module without opening a database connection.
//  */
// export const createDefaultApiApp = async () => {
//   return createApiApp(await createDefaultAppRuntimeConfig());
// };

export {};
