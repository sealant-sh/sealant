---
title: Apps Documentation Index
slug: /apps
status: draft
owner: engineering
updated: 2026-03-28
---

# Apps Documentation Index

This section documents deployable workspaces under `apps/`.

## App map

| App                    | Role                                                    | Primary dependencies                                                               | Page                               |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| `@sealant/web`         | Main product app for sandbox and issue workflow UX      | `@sealant/auth`, `@sealant/db`, `@sealant/ui`                                      | [web.md](./web.md)                 |
| `@sealant/api`         | Control-plane API for lifecycle orchestration and state | `@sealant/db`, `@sealant/workspace-build-queue`, integrations packages             | [api.md](./api.md)                 |
| `@sealant/worker`      | Background build/execution worker                       | `@sealant/db`, `@sealant/os-integration-buildkit`, `@sealant/runtime-adapters-api` | [worker.md](./worker.md)           |
| `@sealant/ssh-gateway` | SSH routing gateway for sandbox access                  | API `ssh-target` route, `ssh2`                                                     | [ssh-gateway.md](./ssh-gateway.md) |
| `@sealant/docs`        | Documentation site app (content + rendering shell)      | TanStack Start stack, Cloudflare deploy                                            | [docs.md](./docs.md)               |
| `@sealant/marketing`   | Public site and launch surfaces                         | TanStack Start stack, Cloudflare deploy                                            | [marketing.md](./marketing.md)     |
| `@sealant/electron`    | Desktop app workspace (scaffold)                        | TypeScript tooling only                                                            | [electron.md](./electron.md)       |

## Suggested reading order

1. `web`
2. `api`
3. `worker`
4. `ssh-gateway`
5. `docs`
6. `marketing`
7. `electron`
