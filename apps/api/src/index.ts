import { createServer } from "node:http";

import { HttpApiBuilder, HttpApiScalar, HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as PgClient from "@effect/sql-pg/PgClient";
import { GitHubDataAccessLive, SealantDBLive } from "@sealant/db";
import { gitHubSourceIntegrationLayer } from "@sealant/source-integrations";
import { Layer, Redacted } from "effect";

import { makeGitHubHttpApiLayer } from "./routes/github/github.http-api.js";
import { env } from "./runtime-env.js";

/**
 * Parse `CORS_ALLOWED_ORIGINS` from env into a normalized set.
 *
 * We keep this logic local to startup because it is static process config,
 * not request-scoped behavior.
 */
const parseAllowedOrigins = (value: string): Set<string> => {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
};

/**
 * We support two CORS modes:
 * - wildcard `*` means allow everything
 * - explicit list means allow only configured origins
 */
const allowAllOrigins = env.CORS_ALLOWED_ORIGINS.trim() === "*";
const allowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);

/**
 * Database client layer (low-level):
 *
 * - `PgClient.layer(...)` builds the Postgres client/pool from runtime config.
 * - `SealantDBLive` builds our typed SQL DB service on top of that client.
 *
 * Lifecycle note:
 * This layer is allocated once at process startup and shared across requests.
 * It is not recreated per request.
 */
const databaseClientLayer = SealantDBLive.pipe(
  Layer.provide(
    PgClient.layer({
      url: Redacted.make(env.DATABASE_URL),
    }),
  ),
);

/**
 * Repository layer (domain-level):
 *
 * `GitHubDataAccessLive` is a ready-made composition exported by `@sealant/db`.
 * It merges all repository services needed by the GitHub module.
 *
 * This is the "sane default" composition point so app code stays minimal.
 */
const databaseLayer = GitHubDataAccessLive.pipe(Layer.provide(databaseClientLayer));

/**
 * Source integration layer:
 *
 * This binds GitHub integration capabilities (API + app auth + webhook verification)
 * from process env into an Effect service.
 */
const sourceIntegrationLayer = gitHubSourceIntegrationLayer({
  apiBaseUrl: env.GITHUB_API_BASE_URL,
  ...(env.GITHUB_APP_ID === undefined ? {} : { appId: env.GITHUB_APP_ID }),
  ...(env.GITHUB_APP_PRIVATE_KEY === undefined ? {} : { privateKey: env.GITHUB_APP_PRIVATE_KEY }),
  ...(env.GITHUB_APP_WEBHOOK_SECRET === undefined
    ? {}
    : { webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET }),
});

/**
 * Core API layer:
 *
 * `makeGitHubHttpApiLayer()` returns the `HttpApiBuilder.api(...)` layer for our
 * contract-first GitHub API implementation.
 *
 * We satisfy its dependencies here by providing:
 * - source integrations
 * - repository/data access services
 */
const apiLayer = makeGitHubHttpApiLayer().pipe(
  Layer.provide(sourceIntegrationLayer),
  Layer.provide(databaseLayer),
);

/**
 * OpenAPI endpoint layer.
 *
 * Adds `/openapi.json` derived from the same `HttpApi` contract.
 */
const openApiLayer = HttpApiBuilder.middlewareOpenApi({ path: "/openapi.json" }).pipe(
  Layer.provide(apiLayer),
);

/**
 * Human docs layer.
 *
 * Adds Scalar docs at `/docs`, again generated from the same contract.
 */
const docsLayer = HttpApiScalar.layer({
  path: "/docs",
  scalar: {
    theme: "saturn",
    layout: "classic",
    darkMode: true,
    defaultOpenAllTags: false,
  },
}).pipe(Layer.provide(apiLayer));

/**
 * CORS transport middleware layer.
 *
 * This runs at HTTP transport level, not inside domain handlers.
 */
const corsLayer = HttpApiBuilder.middlewareCors({
  allowedOrigins: (origin) => {
    // Explicit wildcard support for local/dev and trusted edge deployments.
    if (allowAllOrigins) {
      return true;
    }

    // Non-browser / missing-origin requests should still pass.
    if (typeof origin !== "string" || origin.length === 0) {
      return true;
    }

    // Browser requests are constrained to configured origin allowlist.
    return allowedOrigins.has(origin);
  },
  allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["content-type", "authorization", "idempotency-key", "x-sealant-gateway-token"],
  exposedHeaders: ["location"],
  maxAge: 86_400,
});

/**
 * App composition layer.
 *
 * This merges route handlers + docs + transport middleware.
 */
const appLayer = Layer.mergeAll(apiLayer, openApiLayer, docsLayer, corsLayer);

/**
 * Server layer.
 *
 * `HttpApiBuilder.serve()` converts the API layer graph into an HTTP app.
 * `NodeHttpServer.layer(...)` binds that app to a real Node HTTP server.
 *
 * Lifecycle reminder:
 * The full layer graph is initialized once when `Layer.launch(serverLayer)` runs.
 */
const serverLayer = HttpApiBuilder.serve().pipe(
  Layer.provide(appLayer),
  Layer.provide(HttpServer.layerContext),
  Layer.provide(NodeHttpServer.layer(createServer, { port: env.PORT })),
);

/**
 * Startup diagnostics for operational visibility.
 */
const databaseUrl = new URL(env.DATABASE_URL);

console.log(`[api] database: ${databaseUrl.protocol}//${databaseUrl.host}${databaseUrl.pathname}`);
console.log(`[api] repology endpoint: ${env.REPOLOGY_API_BASE_URL}`);

/**
 * Boot the server runtime.
 *
 * This call keeps the process alive and supervises the launched layer graph.
 */
NodeRuntime.runMain(Layer.launch(serverLayer));
