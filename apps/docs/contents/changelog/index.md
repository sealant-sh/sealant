---
title: Changelog
slug: /changelog
status: draft
owner: engineering
updated: 2026-04-12
---

The changelog is the canonical implementation history for architecture-significant changes.

It is optimized for fast PR review and incident/debug context.

## Entry Shape (required)

Each entry must include all of the following fields:

- `id`: stable id in format `CHG-YYYY-MM-DD-###`
- `title`: one-line change summary
- `status`: `draft`, `in_review`, `merged`, `released`, `rolled_back`
- `owners`: primary engineers/teams
- `scope`: touched surfaces (apps/packages)
- `tags`: searchable labels
- `links`: PR link (or equivalent), commit(s), and related issue/audit references
- `context`: why this change existed
- `decision`: architecture/implementation choice
- `implementation`: concrete file-level changes
- `validation`: commands/tests and outcomes
- `risk`: known risks + mitigation
- `follow_ups`: explicit next steps

## Tag Taxonomy

Use concise tags so reviewers can grep quickly:

- `area:*` (for example `area:api`, `area:rabbitmq`, `area:docs`)
- `domain:*` (for example `domain:sandboxes`, `domain:issue-workflows`)
- `kind:*` (for example `kind:refactor`, `kind:feature`, `kind:fix`)
- `risk:*` (`risk:low`, `risk:medium`, `risk:high`)
- `arch:*` (for example `arch:effect`, `arch:lifecycle`)

## Tag Index

| Tag                          | Entries                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `arch:effect`                | `CHG-2026-04-03-001`, `CHG-2026-04-02-001`                       |
| `area:api`                   | `CHG-2026-04-03-001`, `CHG-2026-04-02-001`                       |
| `area:auth`                  | `CHG-2026-04-03-001`                                             |
| `area:db`                    | `CHG-2026-04-12-001`, `CHG-2026-04-03-001`                       |
| `area:docs`                  | `CHG-2026-04-12-001`, `CHG-2026-04-03-001`, `CHG-2026-04-02-001` |
| `area:rabbitmq`              | `CHG-2026-04-02-001`                                             |
| `area:worker`                | `CHG-2026-04-03-001`                                             |
| `domain:source-integrations` | `CHG-2026-04-12-001`                                             |
| `domain:issue-workflows`     | `CHG-2026-04-03-001`                                             |
| `domain:sandboxes`           | `CHG-2026-04-03-001`                                             |
| `kind:fix`                   | `CHG-2026-04-12-001`                                             |
| `kind:feature`               | `CHG-2026-04-03-001`                                             |
| `kind:refactor`              | `CHG-2026-04-02-001`                                             |
| `risk:low`                   | `CHG-2026-04-12-001`                                             |
| `risk:high`                  | `CHG-2026-04-03-001`                                             |
| `risk:medium`                | `CHG-2026-04-02-001`                                             |

## Entries (newest first)

### CHG-2026-04-12-001 - Align Effect DB Casing with PostgreSQL Schema for GitHub Installations

| Field    | Value                                                                                       |
| -------- | ------------------------------------------------------------------------------------------- |
| `status` | `in_review`                                                                                 |
| `owners` | `engineering`                                                                               |
| `scope`  | `packages/db`, `apps/docs`                                                                  |
| `tags`   | `arch:effect`, `area:db`, `area:docs`, `domain:source-integrations`, `kind:fix`, `risk:low` |
| `links`  | PR: `TBD (this PR)`, commits: `TBD`                                                         |

**PR Description (copy-ready)**

This PR fixes a PostgreSQL column-resolution regression in the Effect Drizzle client used by
control-plane services and documents the fix using the changelog contract.

**Key changes**

- **Snake-case query generation for Effect DB client:** Configure Drizzle Effect PostgreSQL client
  with `casing: "snake_case"` so generated SQL aligns with migrated PostgreSQL columns such as
  `created_at` and `updated_at`.
- **Explicit relations import for DB client wiring:** Point DB client relation import to
  `./schema/relations.js` to keep runtime schema/relations wiring consistent.
- **DB export parity for auth and non-auth consumers:** Re-export Better Auth DB client constructors
  from `@sealant/db` package root.
- **Changelog-first PR discipline:** Add this entry as the canonical implementation log for review,
  rollback context, and follow-up tracking.

**Scope in this PR**

- Update Effect Drizzle DB construction in `packages/db/src/client.ts`.
- Update package exports in `packages/db/src/index.ts`.
- Record implementation details in `apps/docs/contents/changelog/index.md`.

**Non-goals (explicitly not changed)**

- No schema migration changes.
- No API contract or payload shape changes.
- No product-domain behavior changes for sandbox or issue workflow lifecycle flows.

**Design decision**

- Standardize all PostgreSQL Drizzle clients on snake-case query generation whenever schema columns
  are snake_case.
- Keep repository and service contracts unchanged to minimize rollout risk while restoring query
  compatibility.

**Reviewer guide (recommended order)**

1. `packages/db/src/client.ts` - Effect Drizzle `casing` and relation import alignment.
2. `packages/db/src/index.ts` - package-root export parity for auth DB client utilities.
3. `apps/docs/contents/changelog/index.md` - changelog entry structure and PR narrative.

**Key before/after snippets**

Effect Drizzle casing:

```ts
// Before
const dbEffect = PgDrizzle.makeWithDefaults({ schema, relations });

// After
const dbEffect = PgDrizzle.makeWithDefaults({ schema, relations, casing: "snake_case" });
```

Package exports:

```ts
// Before
export { createSealantDB, createSealantDBFromEnv, ... } from "./client.js";

// After
export { createBetterAuthDatabaseClient, createBetterAuthDatabaseClientFromEnv, ... } from "./better-auth-client.js";
export { createSealantDB, createSealantDBFromEnv, ... } from "./client.js";
```

**Implementation summary**

- Added `casing: "snake_case"` to Effect PostgreSQL Drizzle configuration in
  `packages/db/src/client.ts`.
- Switched DB client relation import to `./schema/relations.js` in `packages/db/src/client.ts`.
- Added package-root exports for Better Auth DB clients in `packages/db/src/index.ts`.
- Added this changelog entry and updated tag index in `apps/docs/contents/changelog/index.md`.

**Validation and results**

- `pnpm format:fix`
- `pnpm typecheck`

Both commands passed during implementation.

**Risk and mitigation**

- Primary risk is accidental query-shape drift between DB clients.
- Mitigated by explicitly setting `casing: "snake_case"` in the Effect client and preserving schema
  mappings.
- Mitigated further by keeping this change isolated from schema and API contracts.

**Follow-ups**

- Add a small repository-level regression test that exercises a read path over
  `github_app_installations` through the Effect client.
- Keep `links` updated with final PR URL and commit hash once merged.

### CHG-2026-04-03-001 - Control-plane DB Migration to PostgreSQL and Effect Service

| Field    | Value                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status` | `in_review`                                                                                                                                              |
| `owners` | `engineering`                                                                                                                                            |
| `scope`  | `packages/db`, `packages/validators`, `packages/auth`, `apps/api`, `apps/worker`, `apps/docs`, `compose.yaml`, root `README.md`                          |
| `tags`   | `arch:effect`, `area:db`, `area:api`, `area:worker`, `area:auth`, `area:docs`, `domain:sandboxes`, `domain:issue-workflows`, `kind:feature`, `risk:high` |
| `links`  | PR: `https://github.com/get-sealant/sealant/pull/51`, commit: `0859797`, rollout plan: `DB_EFFECT_POSTGRES_ROLLOUT_PLAN.md`                              |

**PR Description (copy-ready)**

This PR migrates the shared control-plane data layer from SQLite/libsql to PostgreSQL and adds an
Effect-style database service boundary for runtime composition.

**Key changes**

- **PostgreSQL as the source of truth:** Replaces SQLite file-path configuration with
  `DATABASE_URL`, updates Drizzle configuration to PostgreSQL, and introduces a new baseline
  PostgreSQL migration.
- **Effect database service boundary:** Adds a DB service contract/tag + layer constructors in
  `@sealant/db` so callers can compose runtime dependencies at boundaries instead of ad-hoc
  initialization.
- **Consumer runtime updates:** Wires API, worker, and auth integration to the PostgreSQL client
  lifecycle and provider settings.
- **Operational/docs alignment:** Updates local compose topology and docs so local development,
  scripts, and environment docs all describe PostgreSQL-first flow.

**Scope in this PR**

- Migrate `@sealant/db` client + migrator from libsql to `pg`.
- Convert schema definitions from SQLite builders/types to PostgreSQL builders/types.
- Replace Zod generation path in DB validation with `drizzle-orm/effect-schema`.
- Add `packages/db/src/service.ts` and export service/layer helpers.
- Update API/worker/auth integration points and tests for the `DATABASE_URL` env contract.
- Replace old SQLite migration history files with a PostgreSQL baseline migration snapshot.

**Non-goals (explicitly not changed)**

- No data migration path from existing SQLite files (clean-break migration strategy).
- No API endpoint contract or payload shape changes.
- No product-domain behavior changes for sandbox or issue workflow lifecycles.

**Design decision**

- Adopt PostgreSQL as the canonical control-plane persistence backend.
- Keep DB access ergonomics through existing repository APIs while adding Effect service composition
  support.
- Ship migration as a clean baseline to minimize rollout complexity and de-risk hybrid behavior.

**Reviewer guide (recommended order)**

1. `packages/db/src/client.ts` - Postgres pool + Drizzle client creation lifecycle.
2. `packages/db/src/service.ts` - DB service tag/contract and layer constructors.
3. `packages/db/src/schema/control-plane.ts` - largest schema dialect migration surface.
4. `packages/db/src/validation.ts` - `effect-schema` generation switch.
5. `apps/api/src/app.ts` and `apps/api/src/index.ts` - async app bootstrap with DB init moved to
   startup boundary.
6. `compose.yaml` - local infra contract update for PostgreSQL service.

**Key before/after snippets**

Environment contract:

```ts
// Before
DATABASE_FILE_PATH;
DATABASE_BUSY_TIMEOUT_MS;

// After
DATABASE_URL;
```

Auth adapter provider:

```ts
// Before
provider: "sqlite";

// After
provider: "pg";
```

API startup boundary:

```ts
// Before
const databaseClient = await createDatabaseClientFromEnv(env);
const app = createApiApp({ ... });

// After
export const createDefaultApiApp = async () => {
  const databaseClient = await createDatabaseClientFromEnv(env);
  return createApiApp({ ... });
};
```

**Implementation summary**

- Updated `packages/validators/src/env.ts` to define `DATABASE_URL` as shared DB runtime contract.
- Migrated DB package dependencies and scripts in `packages/db/package.json` for PostgreSQL +
  Drizzle beta tooling compatibility.
- Reworked DB runtime in `packages/db/src/client.ts` and `packages/db/src/migrate.ts` to use
  `pg`/`node-postgres` migrator.
- Converted schema files in `packages/db/src/schema/*.ts` from SQLite to PostgreSQL types, including
  index-name normalization for PostgreSQL identifier limits.
- Added `packages/db/src/service.ts` and exported service helpers via `packages/db/src/index.ts`.
- Updated consumer wiring in `packages/auth/src/server.ts`, `apps/api/src/app.ts`, and
  `apps/worker/src/workers/sandboxes.ts`.
- Added PostgreSQL local service in `compose.yaml` and updated project docs/READMEs accordingly.

**Validation and results**

- `pnpm --filter @sealant/db db:generate`
- `pnpm --filter @sealant/db db:migrate` (validated with local `postgres` compose service)
- `pnpm typecheck`
- `pnpm format:fix`

All commands passed during implementation.

**Risk and mitigation**

- Main risk is migration impact from clean-break replacement of prior SQLite migration history.
- Mitigated by making migration strategy explicit, validating generation + migration + typecheck,
  and keeping repository interfaces stable.
- Mitigated operationally by updating local infra/docs in the same PR to avoid env/runtime drift.

**Follow-ups**

- Split follow-up rollout into targeted PR slices from `DB_EFFECT_POSTGRES_ROLLOUT_PLAN.md` where
  needed for incremental review.
- Add explicit test-layer DB service variants once broader Effect service composition is adopted in
  runtime boundaries.
- Keep this entry synchronized with PR body/status through merge.

### CHG-2026-04-02-001 - Initial Effect Service Runtime Wiring

| Field    | Value                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `status` | `merged`                                                                                                                 |
| `owners` | `engineering`                                                                                                            |
| `scope`  | `apps/api`, `apps/web`, `apps/docs`, `apps/worker`, `packages/rabbitmq`, `packages/sandboxes`, repo policy docs          |
| `tags`   | `arch:effect`, `area:api`, `area:rabbitmq`, `area:docs`, `kind:refactor`, `risk:medium`                                  |
| `links`  | PR: `https://github.com/get-sealant/sealant/pull/49`, commits: `8c69885`, `d3bed5d`, audit: `TECH_DEBT_CLEANUP_AUDIT.md` |

**PR Description (copy-ready)**

This PR refactors API and RabbitMQ dependency wiring to leverage the Effect service composition
pattern.

**Key changes**

- **Explicit service contracts:** Replaces scattered runtime lookups (`c.get(...)`) and ad-hoc
  utility calls (`new Date()`, `randomUUID()`, direct logging) with clear service contracts.
- **Centralized composition:** Moves dependency composition to application boundaries instead of
  wiring dependencies inside handlers.
- **Typed runtime model:** Handlers now consume a consistent, strongly-typed runtime, improving
  safety, predictability, and testability.

**Scope in this PR**

- Add API runtime service composition and inject once at API bootstrap.
- Migrate API handlers to runtime-provided dependencies (GitHub, sandboxes, packages, registries).
- Add RabbitMQ service contract + live layer + composition helper, then route queue
  publish/consume/topology calls through that boundary.
- Codify the Effect pattern in `AGENTS.md` and establish changelog discipline in docs.

**Non-goals (explicitly not changed)**

- No HTTP endpoint contract changes.
- No response schema changes.
- No queue topology or message shape changes.
- No product language changes.

**Design decision**

- Adopt service file shape: `tag/contract -> type -> live/test layers -> composition helpers`.
- Compose dependencies once at boundaries (`createApiRuntime`, `createRabbitMqService`).
- Keep this as a behavior-preserving refactor to de-risk rollout.

**Reviewer guide (recommended order)**

1. `apps/api/src/lib/create-api-runtime.ts` - new service composition boundary.
2. `apps/api/src/lib/create-app.ts` - runtime injection point (`c.set("runtime", runtime)`).
3. `apps/api/src/routes/github/github.handlers.ts` - dependency usage migrated to runtime.
4. `apps/api/src/routes/sandboxes/sandboxes.handlers.ts` - same migration pattern at larger scale.
5. `packages/rabbitmq/src/service.ts` - service contract/type/live layer/composition helper.
6. `AGENTS.md` - repository policy update for Effect workflow and file shape.

**Key before/after snippets**

`apps/api/src/routes/github/github.handlers.ts` dependency access:

```ts
// Before
const installationRepository = c.get("gitHubInstallationRepository");
const now = new Date();
id: existing?.id ?? randomUUID();

// After
const runtime = getRuntime(c);
const installationRepository = runtime.gitHubInstallationRepository;
const now = runtime.clock.now();
id: existing?.id ?? runtime.idGenerator.randomUuid();
```

`apps/api/src/lib/create-app.ts` bootstrap composition:

```ts
// Before
c.set("env", config.env);
c.set("sandboxRepository", config.sandboxRepository);

// After
const runtime = createApiRuntime(config);
c.set("runtime", runtime);
```

`packages/rabbitmq/src/service.ts` service pattern:

```ts
export class RabbitMqServiceTag extends Context.Tag("@sealant/rabbitmq/RabbitMqService")<...>() {}
export type RabbitMqService = Context.Tag.Service<typeof RabbitMqServiceTag>;
export const rabbitMqServiceLiveLayer = Layer.effect(...);
export const rabbitMqServiceLayer = (connectionUrl: string) => ...;
```

**Implementation summary**

- Added API runtime composition with services and layers in
  `apps/api/src/lib/create-api-runtime.ts`.
- Added runtime contract types in `apps/api/src/lib/types.ts` and runtime injection in
  `apps/api/src/lib/create-app.ts`.
- Migrated GitHub and sandbox handlers to runtime dependencies in
  `apps/api/src/routes/github/github.handlers.ts` and
  `apps/api/src/routes/sandboxes/sandboxes.handlers.ts`.
- Added RabbitMQ service boundary in `packages/rabbitmq/src/service.ts` and exports in
  `packages/rabbitmq/src/index.ts`.
- Updated Effect guidance in `AGENTS.md` and aligned `effect` dependency usage to catalog-managed
  references where required by this change.

**Validation and results**

- `pnpm format:fix`
- `pnpm --filter @sealant/rabbitmq typecheck`
- `pnpm --filter @sealant/api typecheck`
- `pnpm --filter @sealant/api test`
- `pnpm typecheck`

All commands passed during implementation.

**Risk and mitigation**

- Main risk is wiring regressions where runtime-bound dependencies differ from previous ad-hoc
  context access.
- Mitigated via targeted checks and full typecheck.
- Mitigated further by centralizing runtime shape in `apps/api/src/lib/types.ts`.

**Follow-ups**

- Continue queue/worker migration onto the RabbitMQ service boundary.
- Add test-layer variants for runtime infrastructure services.
- Keep this entry in sync with PR/body changes until merge.
