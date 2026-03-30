---
title: "@sealant/ui"
slug: /packages/ui
status: draft
owner: engineering
updated: 2026-03-28
---

## Purpose

`@sealant/ui` is the shared React UI package for Sealant product surfaces.

It provides reusable primitives, feature components, hooks, and styling utilities so apps can share
consistent interaction patterns.

## Why this package exists

- Avoid duplicate component implementations across web-facing apps.
- Keep shared visual and interaction primitives in one workspace package.
- Make product UI composition faster while preserving consistency.

## Module map

- `src/index.ts`
  - re-export surface for primitives, utilities, hooks, layout, logo, and registry components
- `src/components/ui/*`
  - shared primitive components
- `src/components/layout/*`
  - product shell layout components
- `src/components/registry/*`
  - registry-oriented feature components
- `src/lib/utils`
  - className and helper utilities
- `src/hooks/use-mobile`
  - responsive hook used by product surfaces

## Public surface

From `packages/ui/src/index.ts`, this package exports:

- a large set of Base UI/shadcn-style primitives under `components/ui/*`
- shared utilities from `lib/utils`
- shared hooks (for example `use-mobile`)
- layout shell components (`top-app-bar`, `bottom-nav-bar`)
- logo component (`Logo`)
- registry-related components:
  - `registry-card`
  - `repository-row`
  - `repository-list`
  - `manifest-detail`

## Export groups

- primitives: accordion, alert, button, card, dialog, dropdown-menu, form, input, select, table,
  tabs, tooltip, and more
- utilities: `lib/utils`
- hooks: `use-mobile`
- layout: `top-app-bar`, `bottom-nav-bar`
- brand: `Logo`
- registry views: `registry-card`, `repository-row`, `repository-list`, `manifest-detail`

## Design alignment

This package should match `apps/web/DESIGN.md` for product surfaces that use it.

The UI system should preserve the repo's Swiss/operational visual language rather than introducing
generic component-library styling.

## Cross-package dependency

- Used by `@sealant/web` as the shared product UI layer.
- Can also be reused by other Sealant apps that need product-consistent components.

## Dependency model

- Peer dependencies:
  - `react` `^19.0.0`
  - `react-dom` `^19.0.0`
- Runtime dependencies include Base UI, TanStack form/router utilities, and component helper libs
  such as `class-variance-authority`, `clsx`, and `tailwind-merge`.

## Internal dependencies

- Internal package dependencies: none
- External runtime dependencies: React component ecosystem + Tailwind utilities

## Scripts

- `pnpm --filter @sealant/ui lint`
- `pnpm --filter @sealant/ui typecheck`
