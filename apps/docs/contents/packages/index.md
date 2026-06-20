---
title: Package Documentation Index
slug: /packages
status: draft
owner: engineering
updated: 2026-03-31
---

This section documents shared packages under `packages/`.

## Package map

| Package                        | Primary role                                                        | Internal package dependencies                                                             | Page                                               |
| ------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `@sealant/sandboxes`           | Sandbox domain orchestration for build, publish, runtime, and queue | `@sealant/db`, `@sealant/rabbitmq`, `@sealant/source-integrations`, `@sealant/validators` | [sandboxes.md](./sandboxes.md)                     |
| `@sealant/rabbitmq`            | Business-agnostic RabbitMQ transport primitives                     | None                                                                                      | [rabbitmq.md](./rabbitmq.md)                       |
| `@sealant/validators`          | Shared API and worker message contracts                             | None                                                                                      | [validators.md](./validators.md)                   |
| `@sealant/db`                  | Shared PostgreSQL + Drizzle state for sandboxes and issue workflows | None                                                                                      | [db.md](./db.md)                                   |
| `@sealant/issues`              | Issue workflow provider imports, normalization, and board helpers   | None                                                                                      | [issues.md](./issues.md)                           |
| `@sealant/source-integrations` | Source provider integrations (GitHub today)                         | None                                                                                      | [source-integrations.md](./source-integrations.md) |
| `@sealant/auth`                | Shared Better Auth integration for product apps                     | `@sealant/db`                                                                             | [auth.md](./auth.md)                               |
| `@sealant/ui`                  | Shared React UI components, hooks, and utilities                    | None                                                                                      | [ui.md](./ui.md)                                   |

## Suggested reading order

1. `validators`
2. `rabbitmq`
3. `sandboxes`
4. `db`
5. `issues`
6. `source-integrations`
7. `auth`
8. `ui`

This order mirrors the sandbox lifecycle path from contracts and transport through orchestration and
state.

## DB deep dives

- [db-effect-service-layer.md](./db-effect-service-layer.md)
- [db-effect-postgres-follow-up-plan.md](./db-effect-postgres-follow-up-plan.md)
