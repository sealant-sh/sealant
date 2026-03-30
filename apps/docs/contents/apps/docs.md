---
title: "@sealant/docs"
slug: /apps/docs
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/docs

## Purpose

`@sealant/docs` is the documentation site app.

At the moment, it serves two responsibilities:

- hosting the docs-site application shell
- storing framework-agnostic Markdown content under `apps/docs/contents`

## Current status

- Stack: TanStack Start + TanStack Router
- Deployment tooling: Cloudflare via `wrangler`
- Custom domain target: `docs.sealant.dev`
- Existing route shell is still minimal starter content
- Canonical authored docs now live under:
  - `apps/docs/contents/packages`
  - `apps/docs/contents/architecture`
  - `apps/docs/contents/apps`

## Why content is in `contents/`

The repo can continue documenting architecture and contracts before finalizing docs rendering
decisions.

This keeps source content stable if the presentation layer changes later.

## Runtime scripts

- `pnpm --filter @sealant/docs dev`
- `pnpm --filter @sealant/docs build`
- `pnpm --filter @sealant/docs test`
- `pnpm --filter @sealant/docs typecheck`
- `pnpm --filter @sealant/docs deploy`
