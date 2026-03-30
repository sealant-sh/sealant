---
title: "@sealant/api"
slug: /apps/api
status: draft
owner: engineering
updated: 2026-03-31
---

## Purpose

`@sealant/api` is the control-plane API for validation, orchestration, lifecycle updates, and
stateful read models.

Product-facing contracts should model around `sandboxes` and `issue workflows`, while lower-level
execution details remain internal/operator-facing.

## Current capabilities

- Node-based Hono server
- OpenAPI generation (`/openapi.json`)
- Scalar docs UI (`/docs`)
- route groups for system, sandboxes, registries, packages, and github
- sandbox lifecycle routes backed by `@sealant/db`, `@sealant/rabbitmq`, and `@sealant/sandboxes`
- schema-first route contracts powered by `@sealant/validators`

Primary route details are documented in `apps/api/README.md`.

## Key dependencies

- `@sealant/db`
- `@sealant/rabbitmq`
- `@sealant/sandboxes`
- `@sealant/source-integrations`
- `@sealant/validators`

## Environment highlights

Environment parsing merges database and RabbitMQ env contracts and adds API-specific config for:

- server/CORS
- registry connectivity
- Repology request configuration
- GitHub App configuration
- optional sandbox SSH gateway rewrite settings

See `apps/api/src/env.ts` for the complete runtime contract.

## Runtime scripts

- `pnpm --filter @sealant/api dev`
- `pnpm --filter @sealant/api test`
- `pnpm --filter @sealant/api typecheck`
