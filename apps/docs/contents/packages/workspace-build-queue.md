---
title: "@sealant/workspace-build-queue"
slug: /packages/workspace-build-queue
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/workspace-build-queue

## Purpose

`@sealant/workspace-build-queue` is the RabbitMQ transport package for workspace image build jobs.

It provides queue topology, typed message contracts, and convenience publish/consume helpers.

## Why this package exists

- Keep queue names and message schema stable across API and worker services.
- Encapsulate broker connection/channel lifecycle in one reusable package.
- Ensure build-job orchestration remains durable and typed.

## Module map

- `src/env.ts`
  - RabbitMQ env schema and parsing
- `src/messages.ts`
  - job-request message kind and schema
- `src/topology.ts`
  - queue/exchange/dead-letter topology
- `src/singleton.ts`
  - broker connection singleton management
- `src/publisher.ts`
  - enqueue helper for new build jobs
- `src/consumer.ts`
  - queue consumer helper and ack/retry wiring
- `src/index.ts`
  - public API surface exports

## Public surface

- environment parsing:
  - `rabbitMqEnvSchema`
  - `parseRabbitMqEnv`
- message contract:
  - `workspaceBuildJobRequestedMessageKind`
  - `workspaceBuildJobRequestedMessageSchema`
  - `parseWorkspaceBuildJobRequestedMessage`
- queue operations:
  - `publishWorkspaceBuildJobRequested`
  - `consumeWorkspaceBuildJobs`
  - `assertWorkspaceBuildQueueTopology`
- connection management:
  - `getRabbitMqSingleton`
  - `closeRabbitMqSingleton`

Exports are defined in `packages/workspace-build-queue/src/index.ts`.

## Queue topology

- primary queue: `workspace-build-jobs`
- dead-letter exchange: `workspace-build-jobs.dlx`
- dead-letter queue: `workspace-build-jobs.dead-letter`

The topology is asserted before publish/consume flows use the queue.

## Message shape

Current requested-build message:

- `kind`: `workspace-build-job.requested`
- `jobId`: non-empty string

## Runtime behavior

- publisher emits validated job-request messages
- consumer reads messages with configured prefetch
- singleton keeps one connection/channel pair per process
- dead-letter handling preserves failed work for inspection

## Environment

- `RABBITMQ_URL` (default: `amqp://sealant:sealant@127.0.0.1:5673`)
- `WORKSPACE_BUILD_QUEUE_PREFETCH` (default: `1`)

## Cross-package dependency

- Used by `@sealant/api` to enqueue workspace build jobs.
- Used by `@sealant/worker` to consume and acknowledge workspace build jobs.

## Local development

Start RabbitMQ:

```bash
docker compose up -d rabbitmq
```

Management UI default: `http://127.0.0.1:15673`

## Internal dependencies

- Internal package dependencies: none
- External runtime dependencies: `amqplib`, `zod`

## Scripts

- `pnpm --filter @sealant/workspace-build-queue lint`
- `pnpm --filter @sealant/workspace-build-queue typecheck`
