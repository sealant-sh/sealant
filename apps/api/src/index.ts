import { createServer } from "node:http";

import { HttpApiBuilder, HttpApiScalar, HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as PgClient from "@effect/sql-pg/PgClient";
import {
  GitHubInstallationRepoLive,
  GitHubInstallationRepositoryCacheRepoLive,
  GitHubWebhookDeliveryRepoLive,
  RepositoryProfileRepoLive,
  SealantDBLive,
} from "@sealant/db";
import { gitHubSourceIntegrationLayer } from "@sealant/source-integrations";
import { Layer, Redacted } from "effect";

import { makeGitHubHttpApiLayer } from "./routes/github/github.http-api.js";
import { env } from "./runtime-env.js";

const parseAllowedOrigins = (value: string): Set<string> => {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
};

const allowAllOrigins = env.CORS_ALLOWED_ORIGINS.trim() === "*";
const allowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);

const databaseClientLayer = SealantDBLive.pipe(
  Layer.provide(
    PgClient.layer({
      url: Redacted.make(env.DATABASE_URL),
    }),
  ),
);

const databaseLayer = Layer.mergeAll(
  GitHubInstallationRepoLive,
  GitHubInstallationRepositoryCacheRepoLive,
  GitHubWebhookDeliveryRepoLive,
  RepositoryProfileRepoLive,
).pipe(Layer.provide(databaseClientLayer));

const sourceIntegrationLayer = gitHubSourceIntegrationLayer({
  apiBaseUrl: env.GITHUB_API_BASE_URL,
  ...(env.GITHUB_APP_ID === undefined ? {} : { appId: env.GITHUB_APP_ID }),
  ...(env.GITHUB_APP_PRIVATE_KEY === undefined ? {} : { privateKey: env.GITHUB_APP_PRIVATE_KEY }),
  ...(env.GITHUB_APP_WEBHOOK_SECRET === undefined
    ? {}
    : { webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET }),
});

const apiLayer = makeGitHubHttpApiLayer().pipe(
  Layer.provide(sourceIntegrationLayer),
  Layer.provide(databaseLayer),
);

const openApiLayer = HttpApiBuilder.middlewareOpenApi({ path: "/openapi.json" }).pipe(
  Layer.provide(apiLayer),
);

const docsLayer = HttpApiScalar.layer({
  path: "/docs",
  scalar: {
    theme: "saturn",
    layout: "classic",
    darkMode: true,
    defaultOpenAllTags: false,
  },
}).pipe(Layer.provide(apiLayer));

const corsLayer = HttpApiBuilder.middlewareCors({
  allowedOrigins: (origin) => {
    if (allowAllOrigins) {
      return true;
    }

    if (typeof origin !== "string" || origin.length === 0) {
      return true;
    }

    return allowedOrigins.has(origin);
  },
  allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["content-type", "authorization", "idempotency-key", "x-sealant-gateway-token"],
  exposedHeaders: ["location"],
  maxAge: 86_400,
});

const appLayer = Layer.mergeAll(apiLayer, openApiLayer, docsLayer, corsLayer);

const serverLayer = HttpApiBuilder.serve().pipe(
  Layer.provide(appLayer),
  Layer.provide(HttpServer.layerContext),
  Layer.provide(NodeHttpServer.layer(createServer, { port: env.PORT })),
);

const databaseUrl = new URL(env.DATABASE_URL);

console.log(`[api] database: ${databaseUrl.protocol}//${databaseUrl.host}${databaseUrl.pathname}`);
console.log(`[api] repology endpoint: ${env.REPOLOGY_API_BASE_URL}`);

NodeRuntime.runMain(Layer.launch(serverLayer));
