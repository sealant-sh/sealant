import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as PgClient from "@effect/sql-pg/PgClient";
import { credentialCipherLayer } from "@sealant/credentials";
import { ControlPlaneDataAccessLive, SealantDBLive } from "@sealant/db";
import { gitHubSourceIntegrationLayer } from "@sealant/source-integrations";
import { InlineByteaArtifactStoreLive, TelemetryQueryLive } from "@sealant/telemetry";
import { SealantRuntimeControlLive } from "@sealant/workspaces";
import { Effect, Layer, Redacted } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { makeControlPlaneHttpApiLayer } from "./routes/control-plane.http-api.js";
import { InferenceEngineLive } from "./routes/inference/claude-engine.js";
import { CodexInferenceEngineLive } from "./routes/inference/codex-engine.js";
import { SessionOutputStreamRoute } from "./routes/sessions/sessions.sse.js";
import { SessionAttachRoute } from "./routes/sessions/sessions.ws.js";
import { parseAllowedCaptureOrigins } from "./routes/workspaces/credential-destinations.js";
import { WorkspaceForwardRoute } from "./routes/workspaces/workspaces.ws.js";
import { env } from "./runtime-env.js";
import { budgetLimits } from "./services/budget-limits.js";
import { budgetsOff, makeRateWindow } from "./services/budgets.js";
import { ControlPlaneCapabilitiesLive } from "./services/control-plane-capabilities.js";
import {
  authPosture,
  servicePrincipalMiddleware,
  servicePrincipals,
} from "./services/service-principals.js";

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
  // Daemon control-channel access for the interactive-session verbs: each request opens a
  // short-lived docker-exec bridge to the workspace daemon (sessions are daemon-owned, so no
  // connection registry is needed API-side).
  SealantRuntimeControlLive,
  // The engine layer is a thin facade over module-level session state (sessions must survive
  // across requests regardless of this layer's lifecycle), so providing it here is safe.
  InferenceEngineLive,
  // The codex engine is stateless (tool-less v1: every exchange settles in one spawn).
  CodexInferenceEngineLive,
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
 * Serves a Scalar API reference at `/docs` for the same `/openapi.json` the contract already
 * publishes. Deliberately not `HttpApiScalar.layer`: that module carries the 6 MiB Scalar
 * browser bundle as a string constant, and because it is reached through the
 * `effect/unstable/httpapi` namespace it survives tree-shaking even when only the CDN variant is
 * used, so every API process would keep it resident for a page almost nobody opens. The viewer
 * loads from jsDelivr instead.
 */
const scalarVersion = "1.43.5";
const scalarConfig = JSON.stringify({
  _integration: "html",
  url: "/openapi.json",
  theme: "saturn",
  layout: "classic",
  darkMode: true,
  defaultOpenAllTags: false,
}).replaceAll("<", "\\u003c");
const docsHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Sealant Control Plane API</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="api-reference-container"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${scalarVersion}/dist/browser/standalone.min.js" crossorigin></script>
    <script>
      window.Scalar.createApiReference(document.getElementById("api-reference-container"), ${scalarConfig});
    </script>
  </body>
</html>
`;
const docsLayer = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    yield* router.add("GET", "/docs", Effect.succeed(HttpServerResponse.html(docsHtml)));
  }),
);

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
/**
 * Raw streaming routes (outside the schema-derived contract): the SSE session-output tail.
 * Provided with the same request-scoped dependencies as the contract handlers.
 */
const sseLayer = SessionOutputStreamRoute.pipe(HttpRouter.provideRequest(requestDependenciesLayer));

/** The WS terminal data plane (sessions.ws.ts): auth once, one held daemon connection. */
const wsLayer = SessionAttachRoute.pipe(HttpRouter.provideRequest(requestDependenciesLayer));

/** The WS port-forward data plane (workspaces.ws.ts): raw bytes to an in-workspace port. */
const forwardLayer = WorkspaceForwardRoute.pipe(
  HttpRouter.provideRequest(requestDependenciesLayer),
);

const appLayer = Layer.mergeAll(apiLayer, sseLayer, wsLayer, forwardLayer, docsLayer);

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
/**
 * Authentication gate (services/service-principals.ts). Runs INSIDE cors so preflights and the
 * 401 itself carry CORS headers. Without service keys the process has already refused to start,
 * unless the development exception made it open (`resolveAuthPosture`).
 */
if (parseAllowedCaptureOrigins(env.SEALANT_CAPTURE_ALLOWED_ENDPOINTS) === null) {
  console.error(
    "[api] refusing to start: SEALANT_CAPTURE_ALLOWED_ENDPOINTS must be comma-separated http(s) origins with no path.",
  );
  process.exit(78);
}
if (authPosture.kind === "refused") {
  console.error(`[api] refusing to start: ${authPosture.message}`);
  process.exit(78);
}

const authGate = servicePrincipalMiddleware(
  servicePrincipals,
  env.WORKSPACE_SSH_GATEWAY_TOKEN?.trim(),
  {
    window: makeRateWindow(),
    requestsPerMinute: budgetLimits.principalRequestsPerMinute,
  },
);

const serverLayer = HttpRouter.serve(appLayer, {
  middleware: (app) => corsMiddleware(authGate(app)),
}).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: env.PORT })));

/**
 * Startup diagnostics for operational visibility.
 */
const databaseUrl = new URL(env.DATABASE_URL);

console.log(`[api] database: ${databaseUrl.protocol}//${databaseUrl.host}${databaseUrl.pathname}`);
console.log(`[api] repology endpoint: ${env.REPOLOGY_API_BASE_URL}`);
console.log(
  authPosture.kind === "closed"
    ? "[api] authentication: service keys required on /v1"
    : "[api] authentication: OPEN (SEALANT_ALLOW_OPEN_API, development only) — every /v1 route is served without a credential; keep this API on loopback",
);

const budgetsTurnedOff = budgetsOff(budgetLimits);
console.log(
  budgetsTurnedOff.length === 0
    ? "[api] budgets: all set"
    : `[api] budgets: off for ${budgetsTurnedOff.join(", ")} (0 = no limit)`,
);

if (!env.SEALANT_REQUIRE_OWNER_SCOPE) {
  console.warn(
    "[api] owner scope: NOT REQUIRED (SEALANT_REQUIRE_OWNER_SCOPE=false) — reads and updates that name no owner are served unscoped; for one rollout only",
  );
}

/**
 * Boot the server runtime.
 *
 * This call keeps the process alive and supervises the launched layer graph.
 */
NodeRuntime.runMain(Layer.launch(serverLayer));
