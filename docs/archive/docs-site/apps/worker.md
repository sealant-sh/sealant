---
title: "@sealant/worker"
slug: /apps/worker
status: draft
owner: engineering
updated: 2026-03-31
---

## Purpose

`@sealant/worker` is the background execution worker for workspace image build jobs and runtime
launch handoff.

It consumes queued build jobs, compiles/publishes artifacts, and updates durable lifecycle state.

## Current capabilities

- RabbitMQ transport via `@sealant/rabbitmq`
- durable build/job state updates via `@sealant/db`
- BuildKit compile, registry publication, and runtime launch via `@sealant/workspaces`
- source-provider resolution via `@sealant/source-integrations`

## Key dependencies

- `@sealant/db`
- `@sealant/rabbitmq`
- `@sealant/workspaces`
- `@sealant/source-integrations`

## Environment highlights

Worker env combines database + RabbitMQ contracts with worker-specific defaults for:

- registry connectivity
- optional GitHub App credentials
- Docker socket path
- default runtime adapter
- default startup and SSH behavior for launched workspaces
- worker identity and lease duration

See `apps/worker/src/env.ts` for the full contract.

## Runtime scripts

- `pnpm --filter @sealant/worker dev`
- `pnpm --filter @sealant/worker test`
- `pnpm --filter @sealant/worker typecheck`
