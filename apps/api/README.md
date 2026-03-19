# API App

`@sealant/api` is the first control-plane API scaffold for Sealant.

It currently provides:

- a Node-based Hono server entrypoint
- OpenAPI generation with `hono-openapi`
- interactive docs at `/docs` backed by Scalar
- a starter route layout split into `system` and `registries` groups
- initial read-only registry endpoints backed by `@sealant/registry-integration`

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

## Development

Run the API locally:

```bash
pnpm --filter @sealant/api dev
```

The default registry settings point at the local Zot instance started from `packages/registry-integration/dev/zot/compose.yaml`.

## Architecture

The layout follows the general route-group split from the `hono-open-api-starter` project while using `hono-openapi` instead of `@hono/zod-openapi` so the API layer can stay aligned with Standard Schema validators over time.

- `src/app.ts`: app assembly and route mounting
- `src/index.ts`: Node server bootstrap
- `src/env.ts`: typed runtime env parsing
- `src/lib/`: shared app setup and OpenAPI wiring
- `src/routes/system/`: liveness and API index routes
- `src/routes/registries/`: first registry-backed API routes
