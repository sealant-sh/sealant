import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as PgClient from "@effect/sql-pg/PgClient";
import { ControlPlaneAPI } from "@sealant/api-contracts";
import { credentialCipherLayer } from "@sealant/credentials";
import { ControlPlaneDataAccessLive, SealantDBLive } from "@sealant/db";
import { gitHubSourceIntegrationLayer } from "@sealant/source-integrations";
import { InlineByteaArtifactStoreLive, TelemetryQueryLive } from "@sealant/telemetry";
import { Layer, Redacted } from "effect";
import { HttpMiddleware, HttpRouter } from "effect/unstable/http";
import { HttpApiScalar } from "effect/unstable/httpapi";

import { makeControlPlaneHttpApiLayer } from "./routes/control-plane.http-api.js";
import { env } from "./runtime-env.js";
import { ControlPlaneCapabilitiesLive } from "./services/control-plane-capabilities.js";

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
 * `ControlPlaneDataAccessLive` is a ready-made composition exported by `@sealant/db`.
 * It merges all repository services needed across control-plane route domains.
 *
 * This is the "sane default" composition point so app code stays minimal.
 */
const databaseLayer = ControlPlaneDataAccessLive.pipe(Layer.provide(databaseClientLayer));

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
 * Request-scoped dependency layer:
 *
 * Domain handlers depend on the repository/integration/capability services. In
 * Effect 4 these surface as request-level requirements on the API layer, so we
 * provide them with `HttpRouter.provideRequest(...)` below rather than at layer
 * construction time.
 *
 * `ControlPlaneCapabilitiesLive` itself needs the package-resolution cache repo,
 * so we provide `databaseLayer` into it while still re-exporting the repos for
 * the handlers via `Layer.provideMerge`.
 */
/**
 * Telemetry read layer:
 *
 * `TelemetryQuery` folds the append-only telemetry log into the run record (timeline, byte-exact
 * scrollback, loss report) for the runs handlers. It needs `SealantDB` and an `ArtifactStore`; both
 * are provided here over the same Postgres client so the layer is self-contained when merged in.
 */
const telemetryQueryLayer = TelemetryQueryLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      databaseClientLayer,
      InlineByteaArtifactStoreLive.pipe(Layer.provide(databaseClientLayer)),
    ),
  ),
);

/**
 * Credential cipher layer:
 *
 * Seals connected-account payloads at rest (AES-256-GCM, key from
 * `SEALANT_CREDENTIALS_KEY`). When the key is unset the connected-accounts module
 * fails fast with 503 before ever touching the cipher, so the zero-key fallback
 * below is never exercised — it only keeps the layer graph total so startup does
 * not depend on optional configuration.
 */
const credentialCipher = credentialCipherLayer({
  key: env.SEALANT_CREDENTIALS_KEY ?? Buffer.alloc(32).toString("base64"),
});

const requestDependenciesLayer = Layer.mergeAll(
  sourceIntegrationLayer,
  ControlPlaneCapabilitiesLive,
  telemetryQueryLayer,
  credentialCipher,
).pipe(Layer.provideMerge(databaseLayer));

/**
 * Core API layer:
 *
 * `makeControlPlaneHttpApiLayer()` returns the `HttpApiBuilder.layer(...)` layer for our
 * contract-first control-plane API implementation, registered against the request
 * router and serving `/openapi.json` derived from the same `HttpApi` contract.
 *
 * We satisfy the handlers' request-scoped dependencies here.
 */
const apiLayer = makeControlPlaneHttpApiLayer().pipe(
  HttpRouter.provideRequest(requestDependenciesLayer),
);

/**
 * Human docs layer.
 *
 * Adds Scalar docs at `/docs`, again generated from the same contract.
 */
const docsLayer = HttpApiScalar.layer(ControlPlaneAPI, {
  path: "/docs",
  scalar: {
    theme: "saturn",
    layout: "classic",
    darkMode: true,
    defaultOpenAllTags: false,
  },
});

/**
 * CORS transport middleware.
 *
 * This runs at HTTP transport level, not inside domain handlers.
 */
const corsMiddleware = HttpMiddleware.cors({
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
 * This merges route handlers + docs into the request router.
 */
const appLayer = Layer.mergeAll(apiLayer, docsLayer);

/**
 * Server layer.
 *
 * `HttpRouter.serve(...)` converts the router app layer graph into an HTTP app
 * and applies transport-level CORS middleware.
 * `NodeHttpServer.layer(...)` binds that app to a real Node HTTP server.
 *
 * Lifecycle reminder:
 * The full layer graph is initialized once when `Layer.launch(serverLayer)` runs.
 */
const serverLayer = HttpRouter.serve(appLayer, {
  middleware: corsMiddleware,
}).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: env.PORT })));

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
