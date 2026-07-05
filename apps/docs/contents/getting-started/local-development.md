---
title: Local Development Setup
slug: /getting-started/local-development
status: draft
owner: engineering
updated: 2026-03-28
---

This guide bootstraps the monorepo and starts local infrastructure for sandbox development.

## 1) Enter the development shell

Use either `direnv` or Nix directly:

```bash
direnv allow
```

or

```bash
nix develop
```

## 2) Install dependencies

```bash
pnpm install
```

## 3) Run database migrations

```bash
pnpm --filter @sealant/db db:migrate
```

## 4) Start local infrastructure

```bash
docker compose up -d postgres rabbitmq zot
```

Default local endpoints:

- PostgreSQL: `postgresql://sealant:sealant@127.0.0.1:5433/sealant_control_plane`
- RabbitMQ AMQP: `amqp://sealant:sealant@127.0.0.1:5673`
- RabbitMQ UI: `http://127.0.0.1:15673`
- Zot registry: `http://127.0.0.1:5000`

## 5) Run core services

In separate terminals:

```bash
pnpm --filter @sealant/api dev
pnpm --filter @sealant/worker dev
```

Optional product surfaces:

```bash
pnpm --filter @sealant/web dev
pnpm --filter @sealant/docs dev
```

## 6) Verify health

```bash
curl http://localhost:4000/healthz
curl http://localhost:4000/v1/registries/default/ping
```
