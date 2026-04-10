---
title: API Route Effect Architecture Approach
slug: /architecture/api-route-effect-approach
status: draft
owner: engineering
updated: 2026-04-08
---

This document defines the architecture pattern we use for API routes in Sealant.

Use this as the template for new route domains (sandboxes, issue workflows, registries, packages,
and future integrations).

## Core idea

Split each route domain into three layers:

1. capability package (`packages/*`)
2. API boundary contract (`packages/api-contracts`)
3. live API behavior (`apps/api`)

This keeps transport concerns, business behavior, and external provider logic separate.

## 1) Capability package (`packages/*`)

A capability package owns reusable domain or integration behavior.

Expected shape:

- `service.ts`
  - service contract/tag
  - domain models and capability-specific errors
  - no HTTP details
- `layer.ts`
  - live implementation and layer construction
  - optional test layer helpers
- `utils.ts` (optional)
  - pure helpers only

Example (current reference): `@sealant/source-integrations` for GitHub App operations.

## 2) API boundary contract (`packages/api-contracts`)

`api-contracts` defines only the HTTP-facing shape.

Expected shape:

- request/query/header schemas
- response schemas
- public API errors (status + payload)
- `HttpApi` groups/endpoints
- OpenAPI metadata

Rules:

- no business side effects
- no route implementation logic
- no app/runtime wiring

## 3) Live API behavior (`apps/api`)

`apps/api` is the composition root for route behavior.

Expected shape per domain:

- `*.module.ts`
  - implements contract use-cases with Effect
  - uses runtime dependencies (db repos, capabilities, env-backed clients)
  - maps internal/capability failures to contract errors
- `*.http-api.ts`
  - binds `HttpApi` endpoint names to module methods
  - keeps handlers thin; no domain logic in handler glue
- route mounting in `app.ts`
  - mounts web handler under domain prefix

## Dependency direction

Target dependency flow:

- capabilities do not depend on `apps/api`
- `api-contracts` does not depend on `apps/api`
- `apps/api` depends on both capabilities and `api-contracts`

In short: contracts and capabilities are reused, app composes.

## Type source of truth policy

In this repository, DB schemas are treated as canonical for shared internal typing.

- Drizzle schema + generated Effect schemas in `@sealant/db` are the source of truth.
- `api-contracts` can reuse these schema primitives where appropriate.
- API transport models still remain explicit and intentional at the boundary.

This is acceptable because Sealant is a single monorepo with shared release cadence.

## Error strategy

Use a two-step error model:

1. capability-level errors in packages (invariant/http/unexpected, etc.)
2. boundary-level API errors in `api-contracts` (400/401/403/404/500/503)

`apps/api` is responsible for mapping capability errors to API errors.

## Route implementation checklist

When adding a new route domain, follow this order:

1. Define capability service + layer in a package.
2. Define endpoint shapes and errors in `api-contracts`.
3. Implement module behavior in `apps/api`.
4. Bind handlers in `*.http-api.ts`.
5. Mount the handler in `apps/api/src/app.ts`.
6. Add tests for success paths and error mapping.

## What to avoid

- Putting business logic directly in route handler glue.
- Letting capability packages import API route code.
- Duplicating schema definitions across package and contract layers.
- Returning raw capability/internal errors directly over HTTP.

## Current reference implementation

The GitHub route is the reference for this pattern:

- capability: `packages/source-integrations/src/github/*`
- contract: `packages/api-contracts/src/core-api/github.ts`
- live behavior: `apps/api/src/routes/github/github.module.ts`
- contract binding: `apps/api/src/routes/github/github.http-api.ts`

Use the same shape for future route migrations and new route domains.
