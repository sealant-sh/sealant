---
title: "@sealant/web"
slug: /apps/web
status: draft
owner: engineering
updated: 2026-03-28
---

## Purpose

`@sealant/web` is the main product app for user-facing sandbox and run surfaces.

It is where users authenticate, create/manage sandboxes, and review runs as evidence.

## Current shape

- Stack: TanStack Start + TanStack Router
- Shared package usage:
  - `@sealant/auth`
  - `@sealant/db`
  - `@sealant/ui`
- Route groups in `src/routes` include:
  - auth routes (`_auth/*`)
  - authenticated product shell (`_authenticated/*`)
  - API routes (`api/auth/*`, `api/trpc/*`)

Observed authenticated areas include sandboxes, repositories, profiles, and registry views.

## Design source of truth

Web UI and interaction conventions are defined in:

- `apps/web/DESIGN.md`

This document sets the visual/typographic system and interaction guardrails for product surfaces.

## Runtime scripts

- `pnpm --filter @sealant/web dev`
- `pnpm --filter @sealant/web build`
- `pnpm --filter @sealant/web test`
- `pnpm --filter @sealant/web typecheck`

## Notes

- The current `apps/web/README.md` is still starter template content and can be replaced with a
  project-specific guide.
