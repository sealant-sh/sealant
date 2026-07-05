---
title: "@sealant/sandboxes"
slug: /packages/sandboxes
status: draft
owner: engineering
updated: 2026-03-31
---

## Purpose

`@sealant/sandboxes` owns sandbox domain orchestration from compile through runtime launch.

It centralizes the concrete implementation that used to be split across multiple packages.

## Why this package exists

- Keep sandbox lifecycle logic in one place.
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
  - queue topology and sandbox build message publish/consume helpers
- `src/package-standardization.ts`
  - package normalization helpers used during sandbox processing
- `src/api/sandbox.ts`
  - API-facing sandbox lifecycle mapping helpers
- `src/worker/process-sandbox-build-job.ts`
  - worker-side sandbox build job orchestration pipeline

## Public surface

Top-level exports are defined in `packages/sandboxes/src/index.ts` and include:

- BuildKit compile helpers (`src/buildkit/index.ts`)
- registry client helpers (`src/registry/index.ts`)
- runtime adapter contracts/adapters (`src/runtime/index.ts`)
- sandbox queue helpers (`src/queue/index.ts`)
- package standardization API (`src/package-standardization.ts`)
- API mapping helpers (`src/api/sandbox.ts`)
- worker orchestration entrypoint (`src/worker/process-sandbox-build-job.ts`)

## Cross-package dependencies

- `@sealant/db` for durable lifecycle and attempt state
- `@sealant/rabbitmq` for transport primitives
- `@sealant/source-integrations` for provider-backed source auth metadata
- `@sealant/validators` for contract schemas shared with API and worker

## Scripts

- `pnpm --filter @sealant/sandboxes lint`
- `pnpm --filter @sealant/sandboxes test`
- `pnpm --filter @sealant/sandboxes typecheck`
