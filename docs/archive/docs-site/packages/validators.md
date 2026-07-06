---
title: "@sealant/validators"
slug: /packages/validators
status: draft
owner: engineering
updated: 2026-03-31
---

## Purpose

`@sealant/validators` owns shared schema contracts used across app boundaries.

It provides the canonical API request/response schemas and workspace message/payload schemas used by
API and worker flows.

## Module map

- `src/api/*`
  - API contract schemas for common, workspaces, registries, packages, github, and system routes
- `src/workspaces/workspace-blueprint.ts`
  - canonical workspace blueprint/spec schema
- `src/workspaces/builder.ts`
  - builder support and compile result contracts
- `src/workspaces/buildkit.ts`
  - BuildKit-specific contract schemas
- `src/workspaces/messages.ts`
  - workspace queue message schemas
- `src/workspaces/payloads.ts`
  - workspace build payload schemas used by API/worker persistence boundaries

## Public surface

Exports are defined in `packages/validators/src/index.ts` and re-export API schemas and workspace
contracts in one package.

## Cross-package usage

- `@sealant/api` consumes API request/response and workspace schemas
- `@sealant/workspaces` consumes builder/buildkit/messages/payload schemas
- `@sealant/web` can consume API contracts for strongly typed integration paths

## Dependency model

- Internal package dependencies: none
- External runtime dependencies: `zod`

## Scripts

- `pnpm --filter @sealant/validators lint`
- `pnpm --filter @sealant/validators typecheck`
