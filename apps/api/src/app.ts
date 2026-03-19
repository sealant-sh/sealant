import { env } from "./env.js";
import { configureOpenAPI } from "./lib/configure-openapi.js";
import { createApp, createRouter } from "./lib/create-app.js";
import { createRegistryClient } from "./lib/create-registry-client.js";
import type { AppRuntimeConfig } from "./lib/types.js";
import registries from "./routes/registries/registries.index.js";
import system from "./routes/system/system.index.js";

export const createApiApp = (config: AppRuntimeConfig) => {
  const app = createApp(config);
  const routes = createRouter();

  routes.route("/", system);
  routes.route("/v1/registries", registries);

  app.route("/", routes);
  configureOpenAPI(app, routes, config.env);

  return app;
};

const app = createApiApp({
  env,
  registryClient: createRegistryClient(env),
});

export default app;
