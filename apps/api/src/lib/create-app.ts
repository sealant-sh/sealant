import { Hono } from "hono";

import type { AppBindings, AppRuntimeConfig } from "./types.js";

export const createRouter = () => {
  return new Hono<AppBindings>();
};

export const createApp = (config: AppRuntimeConfig) => {
  const app = createRouter();

  app.use("*", async (c, next) => {
    c.set("env", config.env);
    c.set("registryClient", config.registryClient);
    c.set("workspaceBuildJobPublisher", config.workspaceBuildJobPublisher);
    c.set("workspaceBuildJobRepository", config.workspaceBuildJobRepository);
    await next();
  });

  app.notFound((c) => {
    return c.json(
      {
        message: "Not Found",
      },
      404,
    );
  });

  app.onError((error, c) => {
    return c.json(
      {
        message: error.message.length > 0 ? error.message : "Internal Server Error",
      },
      500,
    );
  });

  return app;
};
