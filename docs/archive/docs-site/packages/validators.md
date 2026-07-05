---
title: "@sealant/validators"
slug: /packages/validators
status: draft
owner: engineering
updated: 2026-03-31
---

## Purpose

`@sealant/validators` owns shared schema contracts used across app boundaries.

It provides the canonical API request/response schemas and sandbox message/payload schemas used by
API and worker flows.

## Module map

- `src/api/*`
  - API contract schemas for common, sandboxes, registries, packages, github, and system routes
- `src/sandboxes/sandbox-blueprint.ts`
  - canonical sandbox blueprint/spec schema
- `src/sandboxes/builder.ts`
  - builder support and compile result contracts
- `src/sandboxes/buildkit.ts`
  - BuildKit-specific contract schemas
- `src/sandboxes/messages.ts`
  - sandbox queue message schemas
- `src/sandboxes/payloads.ts`
  - sandbox build payload schemas used by API/worker persistence boundaries

## Public surface

Exports are defined in `packages/validators/src/index.ts` and re-export API schemas and sandbox
contracts in one package.

## Cross-package usage

- `@sealant/api` consumes API request/response and sandbox schemas
- `@sealant/sandboxes` consumes builder/buildkit/messages/payload schemas
- `@sealant/web` can consume API contracts for strongly typed integration paths

## Dependency model

- Internal package dependencies: none
- External runtime dependencies: `zod`

## Scripts

- `pnpm --filter @sealant/validators lint`
- `pnpm --filter @sealant/validators typecheck`
