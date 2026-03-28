---
title: Package Documentation Index
slug: /packages
status: draft
owner: engineering
updated: 2026-03-28
---

# Package Documentation Index

This folder is the framework-agnostic source of truth for package docs.

The pages here are written first as plain Markdown so we can keep documenting architecture while the
final docs-site stack is still evolving.

## Package map

| Package                            | Primary role                                                    | Internal package dependencies                                        | Page                                                       |
| ---------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `@sealant/workspace-composition`   | Core sandbox composition contracts and normalization            | None                                                                 | [workspace-composition.md](./workspace-composition.md)     |
| `@sealant/ai-harness-integrations` | AI harness catalog and launch/install commands                  | None                                                                 | [ai-harness-integrations.md](./ai-harness-integrations.md) |
| `@sealant/os-integration-buildkit` | BuildKit executor for Arch/Fedora/Nix workspace images          | `@sealant/ai-harness-integrations`, `@sealant/workspace-composition` | [os-integration-buildkit.md](./os-integration-buildkit.md) |
| `@sealant/db`                      | Shared SQLite + Drizzle state for sandboxes and issue workflows | `@sealant/workspace-composition`                                     | [db.md](./db.md)                                           |
| `@sealant/workspace-build-queue`   | RabbitMQ transport for workspace build jobs                     | None                                                                 | [workspace-build-queue.md](./workspace-build-queue.md)     |
| `@sealant/registry-integration`    | Registry publish/tag/lookup integration (Zot-first)             | None                                                                 | [registry-integration.md](./registry-integration.md)       |
| `@sealant/runtime-adapters-api`    | Runtime launch contracts and adapter selection                  | None                                                                 | [runtime-adapters-api.md](./runtime-adapters-api.md)       |
| `@sealant/source-integrations`     | Source provider integrations (GitHub today)                     | None                                                                 | [source-integrations.md](./source-integrations.md)         |
| `@sealant/package-standardization` | Cross-OS package resolution and normalization                   | None                                                                 | [package-standardization.md](./package-standardization.md) |
| `@sealant/auth`                    | Shared Better Auth integration for product apps                 | `@sealant/db`                                                        | [auth.md](./auth.md)                                       |
| `@sealant/ui`                      | Shared React UI components, hooks, and utilities                | None                                                                 | [ui.md](./ui.md)                                           |

## Suggested reading order

1. `workspace-composition`
2. `ai-harness-integrations`
3. `os-integration-buildkit`
4. `db`
5. `workspace-build-queue`
6. `registry-integration`
7. `runtime-adapters-api`
8. `source-integrations`
9. `package-standardization`
10. `auth`
11. `ui`

This order mirrors the execution path for sandbox lifecycle and issue workflow lifecycle.
