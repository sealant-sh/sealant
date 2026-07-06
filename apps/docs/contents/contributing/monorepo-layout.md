---
title: Monorepo layout
description:
  What every app and package under apps/ and packages/ is for, and where to start reading each one.
---

Sealant is a `pnpm` + `turbo` monorepo. `apps/` holds deployable surfaces; `packages/` holds the
shared domains and libraries they compose. `tooling/` holds centralized TypeScript, lint, format,
and test config used across every workspace.

## Apps

| App                    | Role                                                                                                                                                                                                                    | Key entry points                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@sealant/api`         | Control-plane API: workspace lifecycle, SSH-key resolution, runs/execution-record queries, GitHub App routes, registry proxy. Effect `HttpApi` server on Hono/Node, OpenAPI at `/openapi.json`, Scalar docs at `/docs`. | `apps/api/src/index.ts`, `apps/api/src/routes/*`, `apps/api/src/runtime-env.ts`        |
| `@sealant/cli`         | Repo-local `sealant` command for connected accounts, profile credential bindings, and CLI config against a self-hosted control plane.                                                                                   | `apps/cli/src/main.ts`, `apps/cli/src/commands/*`, `apps/cli/src/providers/*`          |
| `@sealant/web`         | Main product app — workspaces, execution records, SSH-key settings, and preview repository/profile/registry views. TanStack Start + TanStack Router.                                                                    | `apps/web/src/routes/_authenticated/*`, `apps/web/DESIGN.md`                           |
| `@sealant/worker`      | Background worker: consumes workspace build requests, compiles/publishes images via BuildKit, launches workspace runtimes, updates durable lifecycle state.                                                             | `apps/worker/src/index.ts`, `apps/worker/src/runtime-env.ts`                           |
| `@sealant/ssh-gateway` | Single stable SSH entrypoint (`ws-<workspaceId>@host`) that resolves a workspace's runtime target from the API and proxies the connection into it.                                                                      | `apps/ssh-gateway/src/gateway-server.ts`, `apps/ssh-gateway/src/principal-resolver.ts` |
| `@sealant/docs`        | This documentation site — a fumadocs app over the Markdown/MDX content in `apps/docs/contents`. TanStack Start, deployed to Cloudflare via `wrangler`.                                                                  | `apps/docs/contents/*`, `apps/docs/src/lib/source.ts`                                  |
| `@sealant/marketing`   | Public marketing site and install/docs entrypoints. TanStack Start + Vite, deployed to Cloudflare.                                                                                                                      | `apps/marketing/src/routes/index.tsx`                                                  |

## Packages

| Package                        | Role                                                                                                                                                        | Key entry points                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `@sealant/api-contracts`       | The wire contracts — the single source of truth for the HTTP API. Effect `HttpApi` groups, endpoint schemas, and typed errors; no runtime logic.            | `packages/api-contracts/src/core-api/*`                                                              |
| `@sealant/auth`                | Shared Better Auth setup: server bootstrap, client factory, session helpers, backed by `@sealant/db`.                                                       | `packages/auth/src/server.ts`, `packages/auth/src/session.ts`                                        |
| `@sealant/credentials`         | Connected-account credential payload parsing, AES-256-GCM sealing, and launch injection planning for Claude, Codex, and GitHub credentials.                 | `packages/credentials/src/index.ts`, `packages/credentials/src/cipher.ts`                            |
| `@sealant/db`                  | Shared PostgreSQL + Drizzle persistence for the control plane — workspace lifecycle, telemetry/execution records, auth, and source-integration tables.      | `packages/db/src/client.ts`, `packages/db/src/repositories/*`                                        |
| `@sealant/rabbitmq`            | Business-agnostic AMQP transport: publish/consume JSON messages, topology assertions, connection singletons.                                                | `packages/rabbitmq/src/index.ts`                                                                     |
| `@sealant/workspaces`          | Workspace domain orchestration end to end: BuildKit compile, registry publish, runtime adapters, build-queue messages, worker job processing.               | `packages/workspaces/src/worker/process-workspace-build-job.ts`, `packages/workspaces/src/runtime/*` |
| `@sealant/sdk`                 | The fluent public SDK (`Sealant`, `opencode()` harness), published on npm as `@sealant/sdk` `0.4.0` — create a workspace, run a harness, replay the record. | `packages/sdk/src/client.ts`, `packages/sdk/src/facade/*`                                            |
| `@sealant/source-integrations` | Repository/provider integrations — GitHub App auth, installation lookup, webhook verification.                                                              | `packages/source-integrations/src/github/`                                                           |
| `@sealant/telemetry`           | Ingests the `sealantd` event firehose and persists it as the append-only, replayable execution record, keyed on `(runId, sequence)`.                        | `packages/telemetry/src/ingester.ts`, `packages/telemetry/src/projector.ts`                          |
| `@sealant/ui`                  | Shared React components, hooks, and utilities for product surfaces — primitives, layout shell, registry views. Matches `apps/web/DESIGN.md`.                | `packages/ui/src/index.ts`, `packages/ui/src/components/ui/*`                                        |
| `@sealant/validators`          | Shared Zod schemas for API requests/responses and workspace build/queue payloads, consumed by both `@sealant/api` and `@sealant/workspaces`.                | `packages/validators/src/index.ts`                                                                   |

## Dependency shape

Contracts and domain packages don't depend on apps; apps compose them:

- `@sealant/api-contracts` and `@sealant/validators` have no internal dependencies — they're the
  bottom of the graph.
- `@sealant/db`, `@sealant/rabbitmq`, `@sealant/auth`, and `@sealant/credentials` sit near the
  bottom of the app graph; `auth` depends on `db`, and `credentials` is intentionally independent of
  app code.
- `@sealant/workspaces` and `@sealant/telemetry` sit above `db`, `rabbitmq`, and
  `source-integrations`.
- `apps/api` and `apps/worker` depend on the domain packages above and wire them together;
  `apps/web` depends on `auth`, `db`, `ui`, and `validators`.

For the pattern that governs how a new API domain is wired from persistence to HTTP handler, see
[Effect and API conventions](/docs/contributing/effect-and-api-conventions).
