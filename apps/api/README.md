# API App

`@sealant/api` is the first control-plane API scaffold for Sealant.

It currently provides:

- a Node-based Hono server entrypoint
- OpenAPI generation with `hono-openapi`
- interactive docs at `/docs` backed by Scalar
- a starter route layout split into `system`, `registries`, and `workspace-build-jobs` groups
- initial read-only registry endpoints backed by `@sealant/registry-integration`
- initial image composition job routes backed by `@sealant/db` and `@sealant/workspace-build-queue`

## Current routes

- `GET /`
- `GET /healthz`
- `GET /readyz`
- `GET /openapi.json`
- `GET /docs`
- `GET /v1/registries/{registryId}`
- `GET /v1/registries/{registryId}/ping`
- `GET /v1/registries/{registryId}/extensions`
- `GET /v1/registries/{registryId}/tags?repository=...`
- `GET /v1/registries/{registryId}/manifest?repository=...&reference=...`
- `POST /v1/workspace-build-jobs`
- `GET /v1/workspace-build-jobs/{jobId}`

## Development

Run the API locally:

```bash
pnpm --filter @sealant/api dev
```

The default registry settings point at the local Zot instance started from `packages/registry-integration/dev/zot/compose.yaml`.

The workspace build job routes also expect RabbitMQ from `packages/workspace-build-queue/dev/rabbitmq/compose.yaml` on `127.0.0.1:5673` and the shared SQLite database from `@sealant/db`.

## Architecture

The layout follows the general route-group split from the `hono-open-api-starter` project while using `hono-openapi` instead of `@hono/zod-openapi` so the API layer can stay aligned with Standard Schema validators over time.

- `src/app.ts`: app assembly and route mounting
- `src/index.ts`: Node server bootstrap
- `src/env.ts`: typed runtime env parsing
- `src/lib/`: shared app setup and OpenAPI wiring
- `src/routes/system/`: liveness and API index routes
- `src/routes/registries/`: first registry-backed API routes
- `src/routes/workspace-build-jobs/`: queued image composition job routes
