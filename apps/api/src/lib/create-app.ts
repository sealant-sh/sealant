import { Hono } from "hono";
import { cors } from "hono/cors";

import { createPassthroughPackageStandardizer } from "./create-package-standardizer.js";
import type { AppBindings, AppRuntimeConfig } from "./types.js";

export const createRouter = () => {
  return new Hono<AppBindings>();
};

export const createApp = (config: AppRuntimeConfig) => {
  const app = createRouter();
  const allowAllOrigins = config.env.CORS_ALLOWED_ORIGINS.trim() === "*";
  const allowedOrigins = parseAllowedOrigins(config.env.CORS_ALLOWED_ORIGINS);

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (allowAllOrigins) {
          return "*";
        }

        if (origin.length === 0) {
          return origin;
        }

        if (allowedOrigins.has(origin)) {
          return origin;
        }

        return "";
      },
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type", "authorization", "idempotency-key"],
      exposeHeaders: ["location"],
      maxAge: 86_400,
    }),
  );

  app.use("*", async (c, next) => {
    c.set("env", config.env);
    c.set("registryClient", config.registryClient);
    c.set("workspaceBuildJobPublisher", config.workspaceBuildJobPublisher);
    c.set("workspaceBuildJobRepository", config.workspaceBuildJobRepository);
    c.set("gitHubSourceIntegration", config.gitHubSourceIntegration);
    c.set("gitHubInstallationRepository", config.gitHubInstallationRepository);
    c.set(
      "gitHubInstallationRepositoryCacheRepository",
      config.gitHubInstallationRepositoryCacheRepository,
    );
    c.set("gitHubWebhookDeliveryRepository", config.gitHubWebhookDeliveryRepository);
    c.set("repositoryProfileRepository", config.repositoryProfileRepository);
    c.set(
      "packageStandardizer",
      config.packageStandardizer ?? createPassthroughPackageStandardizer(),
    );
    c.set("sandboxRepository", config.sandboxRepository);
    c.set("sandboxRuntimeInstanceRepository", config.sandboxRuntimeInstanceRepository);
    c.set("sandboxAttemptRepository", config.sandboxAttemptRepository);
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
    console.error("[api] request failed", {
      method: c.req.method,
      path: c.req.path,
      error: error.message,
      stack: error.stack,
    });

    return c.json(
      {
        message: error.message.length > 0 ? error.message : "Internal Server Error",
      },
      500,
    );
  });

  return app;
};

const parseAllowedOrigins = (value: string): Set<string> => {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
};
