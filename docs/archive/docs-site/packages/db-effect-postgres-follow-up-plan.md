---
title: "@sealant/db effect-postgres follow-up plan"
slug: /packages/db/effect-postgres-follow-up-plan
status: draft
owner: engineering
updated: 2026-04-03
---

## Objective

Migrate DB runtime integration from Drizzle `node-postgres` to Drizzle `connect-effect-postgres`
while preserving the current service-first architecture:

- service tag defines API
- live integration layer owns resource lifecycle
- app boundaries provide layers once

## Current state

- We use `drizzle-orm/node-postgres` in `packages/db/src/client.ts`.
- We already use Effect layers for DB service composition in `packages/db/src/service.ts`.
- We already use `drizzle-orm/effect-schema` in `packages/db/src/validation.ts`.

## Target state

- DB integration uses Drizzle `effect-postgres` connector.
- DB client lifecycle remains managed by scoped Effect layers.
- Consumer-facing repository APIs remain stable.

## Incremental PR plan

### PR 1 - Baseline and compatibility check

**Goal**

Confirm package/runtime compatibility for `drizzle-orm/effect-postgres` with current Drizzle beta
and Effect versions.

**Changes**

- Verify dependency versions in `packages/db/package.json`.
- Add a small compile-time smoke path in `packages/db/src/client.ts` (or a separate temporary file)
  to ensure the `effect-postgres` connector types resolve correctly.

**Acceptance criteria**

- `@sealant/db` compiles with `effect-postgres` imports available.
- No lockfile-policy regressions.

**Validation**

- `pnpm --filter @sealant/db typecheck`

---

### PR 2 - Client integration switch

**Goal**

Replace low-level client construction in `client.ts` with the `connect-effect-postgres` path while
preserving exported DB client shape expected by repositories.

**Changes**

- Update `packages/db/src/client.ts` to build Drizzle DB through `effect-postgres` integration.
- Keep `createDatabaseClient` public API stable where possible.
- Keep explicit startup connectivity failure behavior (fail fast).

**Acceptance criteria**

- Repositories compile without signature changes.
- DB client can still be created from `DATABASE_URL`.

**Validation**

- `pnpm --filter @sealant/db typecheck`
- `pnpm --filter @sealant/db db:migrate`

---

### PR 3 - Service layer lifecycle alignment

**Goal**

Ensure `DatabaseServiceTag` integration remains purely layer-scoped and avoids imperative
materialization patterns.

**Changes**

- Keep `DatabaseServiceTag` API focused on DB capabilities.
- Keep resource acquisition/release entirely in `databaseServiceLiveLayer`.
- Ensure layer provisioning is done at app boundaries.

**Acceptance criteria**

- No new imperative service materialization helpers introduced.
- Layer-scoped cleanup remains deterministic.

**Validation**

- `pnpm --filter @sealant/db typecheck`
- `pnpm typecheck`

---

### PR 4 - Consumer boundary adoption

**Goal**

Adopt layer-first DB provisioning in API/worker/auth/web boundary code where practical, reducing
direct imperative client factory usage.

**Changes**

- Update app boundary composition code incrementally.
- Preserve existing runtime behavior and contracts.

**Acceptance criteria**

- API, worker, auth, and web typecheck against updated DB integration.
- Startup and test ergonomics remain intact.

**Validation**

- `pnpm --filter @sealant/api typecheck`
- `pnpm --filter @sealant/worker typecheck`
- `pnpm --filter @sealant/auth typecheck`
- `pnpm --filter @sealant/web typecheck`
- `pnpm typecheck`

## Risks and mitigations

- **Connector/API drift in Drizzle beta:** contain changes to `@sealant/db` first and validate
  package-only before consumer rollout.
- **Lifecycle regressions:** keep `Layer.scoped` + acquire/release as non-negotiable service
  integration contract.
- **Scope creep:** split into small PRs and avoid mixed behavioral changes.

## Out of scope

- Any SQLite fallback path.
- Any data migration tooling.
- Any API contract changes unrelated to DB integration mechanics.
