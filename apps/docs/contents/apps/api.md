---
title: "@sealant/api"
slug: /apps/api
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/api

## Purpose

`@sealant/api` is the control-plane API for validation, orchestration, lifecycle updates, and
stateful read models.

Product-facing contracts should model around `sandboxes` and `issue workflows`, while lower-level
orchestration endpoints remain internal/operator-facing.

## Current capabilities

- Node-based Hono server
- OpenAPI generation (`/openapi.json`)
- Scalar docs UI (`/docs`)
- route groups for system, sandboxes, registries, and workspace-build-jobs
- sandbox lifecycle routes backed by `@sealant/db` and `@sealant/workspace-build-queue`
- registry inspection routes backed by `@sealant/registry-integration`

Primary route details are documented in `apps/api/README.md`.

## Key dependencies

- `@sealant/db`
- `@sealant/package-standardization`
- `@sealant/registry-integration`
- `@sealant/source-integrations`
- `@sealant/workspace-build-queue`
- `@sealant/workspace-composition`

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
