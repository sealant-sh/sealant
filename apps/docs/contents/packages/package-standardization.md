---
title: "@sealant/package-standardization"
slug: /packages/package-standardization
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/package-standardization

## Purpose

`@sealant/package-standardization` resolves package requests into normalized, cross-OS package
resolution results.

It is designed to answer "what package name should we install on each target OS?" for workspace
composition and build planning.

## Why this package exists

- Handle package-name differences across Arch, Fedora, and Nix.
- Provide typed resolution statuses (`resolved`, `ambiguous`, `unsupported`, `not-found`,
  `invalid`).
- Combine local overrides, remote Repology metadata, and optional cache storage.

## Module map

- `src/index.ts`
  - public package resolution exports
- `src/client.ts`
  - Repology client and request helpers
- `src/standardizer.ts`
  - package standardization workflow
- `src/cache.ts`
  - cache store interface and helpers
- `src/catalog.ts`
  - built-in override catalog and package mapping rules

## Resolution model

The package answers three questions:

1. Is this package supported on the requested target OS?
2. What install name(s) should we use on that target OS?
3. What are the alternate or fallback names if the package is ambiguous?

## Resolution status meanings

- `resolved`: a clear install path exists
- `ambiguous`: multiple possible package matches exist
- `unsupported`: the target OS does not support the package
- `not-found`: no provider match could be found
- `invalid`: the request itself is malformed

## Public surface

- target/schema exports:
  - `packageTargetOsSchema`
  - `packageResolutionStatusSchema`
  - `packageResolutionSchema`
- parser export:
  - `parsePackageResolution(input)`
- client and service creation:
  - `createRepologyClient(options)`
  - `createPackageStandardizer(options)`
- core interfaces:
  - `RepologyClient`
  - `PackageResolutionCacheStore`
  - `PackageStandardizer`

Exports are defined in `packages/package-standardization/src/index.ts`.

## Resolution strategy (current)

1. Normalize and validate query.
2. Try cache (if configured and not expired).
3. Try built-in catalog overrides for common tools.
4. Query Repology project endpoint, then search endpoint as fallback.
5. Compute per-OS support and alternatives.
6. Persist to cache (if configured).

## Cross-package dependency

- Used by `@sealant/api` for package lookup and preview flows.
- Used by `@sealant/os-integration-buildkit` when rendering distro image plans.
- Can persist results into `@sealant/db` package-resolution cache tables.

## Internal dependencies

- Internal package dependencies: none
- External runtime dependencies: `zod`, network access to Repology API (when not cache-hit)

## Scripts

- `pnpm --filter @sealant/package-standardization lint`
- `pnpm --filter @sealant/package-standardization typecheck`
