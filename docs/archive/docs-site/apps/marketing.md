---
title: "@sealant/marketing"
slug: /apps/marketing
status: draft
owner: engineering
updated: 2026-03-28
---

## Purpose

`@sealant/marketing` is the public-facing site and launch surface.

It communicates product positioning around sandboxes and runs and links to install/docs entrypoints.

## Current shape

- Stack: TanStack Start + TanStack Router + Vite
- Deployment tooling: Cloudflare via `wrangler`
- Primary route currently lives in `apps/marketing/src/routes/index.tsx`
- Messaging emphasizes:
  - tailored sandboxes
  - the run record: every run comes back with its evidence attached
  - open source/self-hosted positioning

## Runtime scripts

- `pnpm --filter @sealant/marketing dev`
- `pnpm --filter @sealant/marketing build`
- `pnpm --filter @sealant/marketing test`
- `pnpm --filter @sealant/marketing typecheck`
- `pnpm --filter @sealant/marketing deploy`
