---
title: "@sealant/rabbitmq"
slug: /packages/rabbitmq
status: draft
owner: engineering
updated: 2026-03-31
---

## Purpose

`@sealant/rabbitmq` provides business-agnostic AMQP transport utilities.

It is intentionally generic so domain packages can reuse one transport foundation.

## What it provides

- `rabbitMqEnvSchema` and `parseRabbitMqEnv`
- JSON message publish helper (`publishRabbitMqJsonMessage`)
- JSON message consume helper (`consumeRabbitMqJsonMessages`)
- topology assertion helpers (`assertRabbitMqTopology`)
- connection/channel singleton helpers (`getRabbitMqSingleton`, `closeRabbitMqSingleton`)

Exports are defined in `packages/rabbitmq/src/index.ts`.

## Environment contract

- `RABBITMQ_URL`
- `WORKSPACE_BUILD_QUEUE_PREFETCH`

Schema source: `packages/rabbitmq/src/env.ts`.

## Dependency model

- Internal package dependencies: none
- External runtime dependencies: `amqplib`, `zod`

## Scripts

- `pnpm --filter @sealant/rabbitmq lint`
- `pnpm --filter @sealant/rabbitmq typecheck`
