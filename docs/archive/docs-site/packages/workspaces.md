---
title: "@sealant/workspaces"
slug: /packages/workspaces
status: draft
owner: engineering
updated: 2026-03-31
---

## Purpose

`@sealant/workspaces` owns workspace domain orchestration from compile through runtime launch.

It centralizes the concrete implementation that used to be split across multiple packages.

## Why this package exists

- Keep workspace lifecycle logic in one place.
- Avoid cross-package orchestration drift between API and worker.
- Expose one stable domain API for build, publish, queue, runtime, and worker processing.

## Module map

- `src/buildkit/*`
  - BuildKit compile planning and Docker build/save execution
- `src/registry/*`
  - OCI publish and registry lookup helpers
- `src/runtime/*`
  - runtime adapter contracts and built-in adapter implementations
- `src/queue/*`
  - queue topology and workspace build message publish/consume helpers
- `src/package-standardization.ts`
  - package normalization helpers used during workspace processing
- `src/api/workspace.ts`
  - API-facing workspace lifecycle mapping helpers
- `src/worker/process-workspace-build-job.ts`
  - worker-side workspace build job orchestration pipeline

## Public surface

Top-level exports are defined in `packages/workspaces/src/index.ts` and include:

- BuildKit compile helpers (`src/buildkit/index.ts`)
- registry client helpers (`src/registry/index.ts`)
- runtime adapter contracts/adapters (`src/runtime/index.ts`)
- workspace queue helpers (`src/queue/index.ts`)
- package standardization API (`src/package-standardization.ts`)
- API mapping helpers (`src/api/workspace.ts`)
- worker orchestration entrypoint (`src/worker/process-workspace-build-job.ts`)

## Cross-package dependencies

- `@sealant/db` for durable lifecycle and attempt state
- `@sealant/rabbitmq` for transport primitives
- `@sealant/source-integrations` for provider-backed source auth metadata
- `@sealant/validators` for contract schemas shared with API and worker

## Scripts

- `pnpm --filter @sealant/workspaces lint`
- `pnpm --filter @sealant/workspaces test`
- `pnpm --filter @sealant/workspaces typecheck`
