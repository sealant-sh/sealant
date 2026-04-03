# DB Effect + PostgreSQL Rollout Plan

Date: 2026-04-03 Owner: engineering Status: draft

## Objective

Move `@sealant/db` from SQLite to PostgreSQL and adopt an Effect-first DB service boundary, using
Drizzle's Effect integrations:

- `drizzle-orm/effect-postgres`
- `drizzle-orm/effect-schema`

This plan is intentionally split into small, targeted PRs with clear blast radius and acceptance
criteria.

## Delivery Constraints

- **Cutover strategy:** clean break to PostgreSQL (no SQLite->Postgres data migration tooling).
- **Architecture:** service contract first, live implementation layered separately.
- **Language contract:** keep product-facing terms centered on `sandboxes` and `issue workflows`.
- **Repo defaults:** run `pnpm format:fix` after changes; use `pnpm typecheck` (`tsgo`) for
  type-checking.

## Non-Goals

- No backward compatibility for SQLite runtime paths.
- No long-lived dual-database mode.
- No broad API behavior changes beyond DB backend migration requirements.

## PR Sizing Rules

- Keep each PR focused on one boundary (db package, consumers, infra/docs).
- Keep PRs independently reviewable and buildable.
- Avoid mixing schema conversion and app behavior changes in the same PR when possible.

## Targeted PR Sequence

## PR 1 - Drizzle Beta + Dependency Baseline

**Goal**

Upgrade the DB package stack to a Drizzle version that supports Effect Postgres + Effect Schema.

**Primary targets**

- `packages/db/package.json`
- Workspace dependency catalog entries (if needed)

**Acceptance criteria**

- `@sealant/db` installs with required packages for Effect Postgres path.
- DB package still typechecks before functional migration starts.

**Validation**

- `pnpm --filter @sealant/db typecheck`

---

## PR 2 - Env Contract Migration to PostgreSQL

**Goal**

Replace SQLite env contract with PostgreSQL URL contract at validators boundary.

**Primary targets**

- `packages/validators/src/env.ts`
- Env-focused tests in API/worker

**Key changes**

- Replace `DATABASE_FILE_PATH` / `DATABASE_BUSY_TIMEOUT_MS` with `DATABASE_URL`.
- Keep parser ergonomics and defaults suitable for local dev.

**Acceptance criteria**

- App and worker env parsers compile with PostgreSQL contract.
- Env tests updated and passing.

**Validation**

- `pnpm --filter @sealant/api test -- env.test.ts`
- `pnpm --filter @sealant/worker test -- env.test.ts`

---

## PR 3 - Schema Dialect Conversion (SQLite -> PostgreSQL)

**Goal**

Convert DB schema declarations to Postgres core types and table builders.

**Primary targets**

- `packages/db/src/schema/auth.ts`
- `packages/db/src/schema/control-plane.ts`
- `packages/db/src/schema/sandbox-build-jobs.ts`

**Key changes**

- `sqliteTable` -> `pgTable`
- Type conversions for booleans/timestamps/json/defaults
- Index/constraint name normalization for PostgreSQL identifier limits

**Acceptance criteria**

- Schema compiles under postgres dialect.
- No PostgreSQL identifier-length collisions.

**Validation**

- `pnpm --filter @sealant/db typecheck`

---

## PR 4 - Fresh PostgreSQL Migration Baseline

**Goal**

Create a clean PostgreSQL migration lineage for the new schema.

**Primary targets**

- `packages/db/drizzle.config.ts`
- `packages/db/drizzle/*`
- `packages/db/drizzle/meta/*`

**Key changes**

- Switch drizzle config to `dialect: "postgresql"`.
- Replace SQLite migration history with fresh PostgreSQL baseline files.

**Acceptance criteria**

- `db:generate` produces PostgreSQL-valid artifacts.
- Migration metadata is internally consistent.

**Validation**

- `pnpm --filter @sealant/db db:generate`
- `pnpm --filter @sealant/db typecheck`

---

## PR 5 - DB Client + Migrator PostgreSQL Runtime

**Goal**

Switch runtime client and migrator from libsql/sqlite to PostgreSQL.

**Primary targets**

- `packages/db/src/client.ts`
- `packages/db/src/migrate.ts`
- `packages/db/src/runtime-env.ts`
- `packages/db/src/index.ts`

**Key changes**

- Use PostgreSQL Drizzle driver.
- Update migration runner to PostgreSQL migrator path.
- Keep stable public factory API where practical.

**Acceptance criteria**

- DB client creation uses `DATABASE_URL`.
- Migration runner works with PostgreSQL.

**Validation**

- `pnpm --filter @sealant/db db:migrate`
- `pnpm --filter @sealant/db typecheck`

---

## PR 6 - Effect DB Service Boundary

**Goal**

Introduce explicit DB service contract + layer composition in `@sealant/db`, aligned with existing
Effect service patterns in the repo.

**Primary targets**

- `packages/db/src/service.ts` (new)
- `packages/db/src/index.ts`

**Key changes**

- `Context.Tag` for DB service contract
- Config service/tag for URL-driven wiring
- Live layer and helper constructor for imperative call-sites

**Acceptance criteria**

- Service contract is separated from live implementation.
- Consumers can acquire DB via layer-based composition.

**Validation**

- `pnpm --filter @sealant/db typecheck`

---

## PR 7 - Validation Layer Migration to Effect Schema

**Goal**

Move DB validation generation from `drizzle-zod` to `drizzle-orm/effect-schema`.

**Primary targets**

- `packages/db/src/validation.ts`
- `packages/db/package.json`
- `packages/db/src/index.ts`

**Acceptance criteria**

- Generated DB-facing schemas use Effect Schema.
- Exports remain clear and consumable.

**Validation**

- `pnpm --filter @sealant/db typecheck`

---

## PR 8 - Consumer Integration (API, Worker, Auth, Web Server Context)

**Goal**

Migrate DB consumers to PostgreSQL env and DB service usage where appropriate.

**Primary targets**

- `apps/api/src/app.ts`, `apps/api/src/index.ts`
- `apps/worker/src/workers/sandboxes.ts`, `apps/worker/src/index.ts`
- `packages/auth/src/server.ts`
- `apps/web/src/lib/trpc/context.ts`

**Key changes**

- Remove SQLite-specific logs/messages/config usage.
- Update Better Auth Drizzle adapter provider to PostgreSQL.
- Ensure startup/bootstrap does not force unwanted DB connection in unit tests.

**Acceptance criteria**

- API, worker, auth, and web server context compile against PostgreSQL DB contract.
- Existing tests updated for new env contract and startup behavior.

**Validation**

- `pnpm --filter @sealant/api typecheck`
- `pnpm --filter @sealant/worker typecheck`
- `pnpm --filter @sealant/auth typecheck`
- `pnpm --filter @sealant/web typecheck`

---

## PR 9 - Local Infra + Docs Cutover

**Goal**

Align local development and docs with PostgreSQL runtime.

**Primary targets**

- `compose.yaml`
- `packages/db/README.md`
- `apps/docs/contents/packages/db.md`
- `apps/docs/contents/getting-started/environment-variables.md`
- `apps/docs/contents/getting-started/local-development.md`
- app readmes referencing SQLite

**Acceptance criteria**

- Local dev docs reflect PostgreSQL setup and env vars.
- Compose stack includes/uses PostgreSQL for app runtime.

**Validation**

- Docs consistency pass + smoke runbook check

## Cross-PR Risk Controls

- Keep migrations and schema changes isolated from app logic changes.
- Update tests in the same PR that changes env/runtime contract.
- Prefer additive service APIs before deleting legacy helpers, then clean up in follow-up PR.

## Final Definition of Done

- `@sealant/db` runs on PostgreSQL with Drizzle Effect Postgres connection path.
- DB service contract/layer is available and used by runtime boundaries.
- DB validation generation uses Drizzle Effect Schema.
- API, worker, auth, and web server contexts compile and run with `DATABASE_URL`.
- Docs and local dev instructions no longer reference SQLite as the default backend.
