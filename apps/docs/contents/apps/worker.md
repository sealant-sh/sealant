---
title: "@sealant/worker"
slug: /apps/worker
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/worker

## Purpose

`@sealant/worker` is the background execution worker for workspace image build jobs and runtime
launch handoff.

It consumes queued build jobs, compiles/publishes artifacts, and updates durable lifecycle state.

## Current capabilities

- RabbitMQ job consumption via `@sealant/workspace-build-queue`
- durable build/job state updates via `@sealant/db`
- BuildKit compile path via `@sealant/os-integration-buildkit`
- registry publication via `@sealant/registry-integration`
- runtime selection/launch via `@sealant/runtime-adapters-api`

## Key dependencies

- `@sealant/db`
- `@sealant/os-integration-buildkit`
- `@sealant/registry-integration`
- `@sealant/runtime-adapters-api`
- `@sealant/source-integrations`
- `@sealant/workspace-build-queue`
- `@sealant/workspace-composition`

## Environment highlights

Worker env combines database + RabbitMQ contracts with worker-specific defaults for:

- registry connectivity
- optional GitHub App credentials
- Docker socket path
- default runtime adapter
- default startup and SSH behavior for launched sandboxes
- worker identity and lease duration

See `apps/worker/src/env.ts` for the full contract.

## Runtime scripts

- `pnpm --filter @sealant/worker dev`
- `pnpm --filter @sealant/worker test`
- `pnpm --filter @sealant/worker typecheck`
