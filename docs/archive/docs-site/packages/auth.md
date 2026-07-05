---
title: "@sealant/auth"
slug: /packages/auth
status: draft
owner: engineering
updated: 2026-03-28
---

## Purpose

`@sealant/auth` is the shared Better Auth package for Sealant product apps.

It provides a common server/client/session layer backed by `@sealant/db`.

## Why this package exists

- Keep authentication setup consistent across apps.
- Centralize Better Auth environment parsing and session helpers.
- Avoid duplicate auth bootstrap logic in each app.

## Module map

- `src/client.ts`
  - browser/client auth helper creation
- `src/env.ts`
  - auth env parsing and defaults
- `src/server.ts`
  - Better Auth server bootstrap and shared auth instance access
- `src/session.ts`
  - session lookup and required-session helpers
- `src/index.ts`
  - public exports

## Public surface

- server-side auth:
  - `createSealantAuth`
  - `getSealantAuth`
- client-side factory:
  - `createSealantAuthClient`
- session helpers:
  - `getAuthSession`
  - `requireAuthSession`
- env parsing:
  - `authEnvSchema`
  - `parseAuthEnv`

## Runtime behavior

- `createSealantAuth(...)` builds a server-side auth instance.
- `getSealantAuth(...)` returns the shared auth singleton.
- `createSealantAuthClient(...)` creates a client helper for product apps.
- `getAuthSession(...)` returns a nullable session result.
- `requireAuthSession(...)` throws or redirects on unauthenticated access, depending on usage.

Exports are defined in `packages/auth/src/index.ts`.

## Cross-package dependency

- Depends on `@sealant/db` for auth tables and persistence.
- Used by `@sealant/web` and other product apps for shared sign-in/session flows.

## Environment

- `NODE_ENV` (default: `development`)
- `BETTER_AUTH_APP_NAME` (default: `Sealant`)
- `BETTER_AUTH_SECRET` (recommended in non-local deployments)
- `BETTER_AUTH_URL`
- `BETTER_AUTH_TRUSTED_ORIGINS` (comma-separated)

## Internal dependencies

- Internal package dependencies: `@sealant/db`
- External runtime dependencies: `better-auth`, `zod`

## Scripts

- `pnpm --filter @sealant/auth lint`
- `pnpm --filter @sealant/auth typecheck`
