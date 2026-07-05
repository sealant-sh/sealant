---
title: Apps Documentation Index
slug: /apps
status: draft
owner: engineering
updated: 2026-03-31
---

This section documents deployable workspaces under `apps/`.

## App map

| App                    | Role                                                    | Primary dependencies                                                            | Page                               |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| `@sealant/web`         | Main product app for sandbox UX                         | `@sealant/auth`, `@sealant/db`, `@sealant/ui`                                   | [web.md](./web.md)                 |
| `@sealant/api`         | Control-plane API for lifecycle orchestration and state | `@sealant/db`, `@sealant/rabbitmq`, `@sealant/sandboxes`, `@sealant/validators` | [api.md](./api.md)                 |
| `@sealant/worker`      | Background build/execution worker                       | `@sealant/db`, `@sealant/rabbitmq`, `@sealant/sandboxes`                        | [worker.md](./worker.md)           |
| `@sealant/ssh-gateway` | SSH routing gateway for sandbox access                  | API `ssh-target` route, `ssh2`                                                  | [ssh-gateway.md](./ssh-gateway.md) |
| `@sealant/docs`        | Documentation site app (content + rendering shell)      | TanStack Start stack, Fumadocs, Cloudflare deploy                               | [docs.md](./docs.md)               |
| `@sealant/marketing`   | Public site and launch surfaces                         | TanStack Start stack, Cloudflare deploy                                         | [marketing.md](./marketing.md)     |

## Suggested reading order

1. `web`
2. `api`
3. `worker`
4. `ssh-gateway`
5. `docs`
6. `marketing`
