---
title: "@sealant/runtime-adapters-api"
slug: /packages/runtime-adapters-api
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/runtime-adapters-api

## Purpose

`@sealant/runtime-adapters-api` defines the runtime launch contract between the control plane and
concrete runtime adapters.

It also exports built-in adapter implementations used by the current system.

## Why this package exists

- Keep runtime-launch APIs consistent across Docker and future runtimes.
- Isolate adapter selection policy in one place.
- Allow new runtime targets without rewriting control-plane call sites.

## Module map

- `src/index.ts`
  - public runtime-adapter exports
- `src/*`
  - adapter schemas, selection logic, and built-in adapter implementations

## Public surface

Contract and selection exports:

- adapter ids and schemas (`runtimeAdapterIdSchema`, launch/support schemas)
- parse helpers for launch/support input/output
- `selectRuntimeAdapter(...)`
- shared types (`RuntimeAdapter`, `RuntimeAdapterBlueprint`, `PublishedImage`, etc.)

## Runtime contract

The package defines the handoff between published images and launch-time adapters.

Adapters receive an image/reference plus runtime intent and return a structured launch result that
the product can persist and surface.

Built-in adapters:

- `DockerRuntimeAdapter`
- `K8sRuntimeAdapter` (scaffold)
- `K3sRuntimeAdapter` (scaffold)

## Selection rules

- `auto` runtime family uses the default adapter.
- `require` mode must resolve to the requested adapter family.
- `prefer` mode tries the requested adapter first, then falls back.

## Cross-package dependency

- Consumes published image references from `@sealant/registry-integration`.
- Used by `@sealant/worker` to launch sandboxes after build completion.
- Uses `@sealant/workspace-composition` types for runtime-target intent.

Exports are defined in `packages/runtime-adapters-api/src/index.ts`.

## Selection behavior

- `target.runtime.family = auto`: use default adapter
- explicit runtime + `mode = require`: requested adapter must be selected
- explicit runtime + `mode = prefer`: requested adapter first, then fallback to default

## Typical flow

1. OS executor produces OCI artifact.
2. Registry integration publishes image and returns canonical references.
3. Adapter selection resolves concrete runtime adapter.
4. Selected adapter launches sandbox runtime.

## Internal dependencies

- Internal package dependencies: none
- External runtime dependencies: `zod`

## Scripts

- `pnpm --filter @sealant/runtime-adapters-api lint`
- `pnpm --filter @sealant/runtime-adapters-api test`
- `pnpm --filter @sealant/runtime-adapters-api typecheck`
