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

The default registry settings point at the local Zot instance started from the root
`compose.yaml`.

The workspace build job routes also expect RabbitMQ from the root `compose.yaml` on
`127.0.0.1:5673` and the shared SQLite database from `@sealant/db`.

## Operations Runbook (Local Image Build Flow)

This API is the control-plane entrypoint for workspace image builds.

### What this flow does

1. `POST /v1/workspace-build-jobs` stores a durable build job in SQLite and publishes a queue
   message to RabbitMQ.
2. `@sealant/worker` consumes the job, compiles via `@sealant/os-integration-nix`, and publishes the
   OCI image to Zot via `@sealant/registry-integration`.
3. `GET /v1/workspace-build-jobs/{jobId}` returns the durable job state, including success/failure
   details and published image references.

### Prerequisites

- Nix shell available (`direnv allow` or `nix develop`)
- Docker daemon running (used for local infra and current publish bridge)
- Dependencies installed

```bash
pnpm install
pnpm --filter @sealant/db db:migrate
```

### Start local dependencies

```bash
docker compose up -d rabbitmq zot
```

- RabbitMQ AMQP: `amqp://sealant:sealant@127.0.0.1:5673`
- RabbitMQ UI: `http://127.0.0.1:15673`
- Zot registry: `http://127.0.0.1:5000`

### Start services

In separate terminals:

```bash
pnpm --filter @sealant/api dev
pnpm --filter @sealant/worker dev
```

### Verify control-plane health

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/v1/registries/default/ping
```

### Queue a workspace image build

```bash
curl -X POST http://localhost:3000/v1/workspace-build-jobs \
  -H 'content-type: application/json' \
  -d '{
    "registryId": "default",
    "repository": "sealant/workspaces/demo",
    "tag": "opencode",
    "spec": {
      "source": "https://github.com/example/repo",
      "harness": "opencode",
      "os": "nix",
      "target": {
        "runtime": "docker"
      }
    }
  }'
```

Expected response: `202` with `jobId`.

### Poll job status

```bash
curl http://localhost:3000/v1/workspace-build-jobs/<jobId>
```

Terminal states: `queued`, `running`, `succeeded`, `failed`.

On success, the response includes:

- `publishedImage.reference`
- `publishedImage.digestReference`
- `publishedImage.digest`
- `result.runtime.adapter`
- `result.runtime.resourceId`
- `result.runtime.endpoint` (when exposed by the selected runtime adapter)

### Confirm image exists in registry

```bash
curl "http://localhost:3000/v1/registries/default/tags?repository=sealant/workspaces/demo"
```

### Common failure cases

- `404 Unknown registry`: request `registryId` must match `REGISTRY_NAME` (default: `default`).
- `502` on create job: queue publish failed (RabbitMQ unavailable or misconfigured).
- Job `failed`: compile/publish error from worker; inspect worker logs and job `error` payload.

## Architecture

The layout follows the general route-group split from the `hono-open-api-starter` project while
using `hono-openapi` instead of `@hono/zod-openapi` so the API layer can stay aligned with Standard
Schema validators over time.

- `src/app.ts`: app assembly and route mounting
- `src/index.ts`: Node server bootstrap
- `src/env.ts`: typed runtime env parsing
- `src/lib/`: shared app setup and OpenAPI wiring
- `src/routes/system/`: liveness and API index routes
- `src/routes/registries/`: first registry-backed API routes
- `src/routes/workspace-build-jobs/`: queued image composition job routes
