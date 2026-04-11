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

| Tag                          | Entries                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `arch:effect`                | `CHG-2026-04-12-002`, `CHG-2026-04-12-001`, `CHG-2026-04-03-001`, `CHG-2026-04-02-001` |
| `area:api`                   | `CHG-2026-04-12-002`, `CHG-2026-04-12-001`, `CHG-2026-04-03-001`, `CHG-2026-04-02-001` |
| `area:auth`                  | `CHG-2026-04-12-001`, `CHG-2026-04-03-001`                                             |
| `area:db`                    | `CHG-2026-04-12-001`, `CHG-2026-04-03-001`                                             |
| `area:docs`                  | `CHG-2026-04-12-002`, `CHG-2026-04-12-001`, `CHG-2026-04-03-001`, `CHG-2026-04-02-001` |
| `area:rabbitmq`              | `CHG-2026-04-02-001`                                                                   |
| `area:web`                   | `CHG-2026-04-12-001`                                                                   |
| `area:worker`                | `CHG-2026-04-12-001`, `CHG-2026-04-03-001`                                             |
| `domain:source-integrations` | `CHG-2026-04-12-001`                                                                   |
| `domain:issue-workflows`     | `CHG-2026-04-12-001`, `CHG-2026-04-03-001`                                             |
| `domain:sandboxes`           | `CHG-2026-04-12-002`, `CHG-2026-04-12-001`, `CHG-2026-04-03-001`                       |
| `kind:fix`                   | `CHG-2026-04-12-001`                                                                   |
| `kind:feature`               | `CHG-2026-04-03-001`                                                                   |
| `kind:refactor`              | `CHG-2026-04-12-002`, `CHG-2026-04-02-001`                                             |
| `risk:high`                  | `CHG-2026-04-03-001`                                                                   |
| `risk:medium`                | `CHG-2026-04-12-002`, `CHG-2026-04-12-001`, `CHG-2026-04-02-001`                       |

## Entries (newest first)

### CHG-2026-04-12-002 - Complete Control-Plane Route Migration from Hono to Effect HttpApi

| Field    | Value                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| `status` | `in_review`                                                                                |
| `owners` | `engineering`                                                                              |
| `scope`  | `apps/api`, `packages/api-contracts`, `apps/docs`                                          |
| `tags`   | `arch:effect`, `area:api`, `area:docs`, `domain:sandboxes`, `kind:refactor`, `risk:medium` |
| `links`  | PR: `TBD (this PR)`, commit: `c56686f`                                                     |

**PR Description (copy-ready)**

This PR completes migration of the remaining control-plane API domains from legacy Hono route files
to Effect `HttpApi` contracts and handlers, and wires them into a single control-plane API layer.

**Key changes**

- **Contract-first expansion:** Add Effect HTTP contracts for `system`, `packages`, `registries`,
  and `sandboxes` in `@sealant/api-contracts` and register all groups in `ControlPlaneAPI`.
- **Per-domain Effect modules:** Implement route behavior in `*.module.ts` files and keep
  `*.http-api.ts` as thin endpoint-to-use-case bindings.
- **Unified control-plane composition:** Add a composed API layer in
  `apps/api/src/routes/control-plane.http-api.ts` and switch `apps/api/src/index.ts` to consume it.
- **Capability service boundaries:** Add Effect services for package standardization, registry
  access, and sandbox build-job publishing in `apps/api/src/services/control-plane-capabilities.ts`.
- **Error boundary mapping:** Preserve domain-level 4xx/5xx behavior by mapping Promise-based and
  repository failures into typed contract errors.

**Scope in this PR**

- Add new contracts in
  `packages/api-contracts/src/core-api/{system,packages,registries,sandboxes}.ts`.
- Update `packages/api-contracts/src/core-api/control-plane.ts` and
  `packages/api-contracts/src/index.ts` exports.
- Add Effect domain modules and bindings in
  `apps/api/src/routes/{system,packages,registries,sandboxes}/*`.
- Add composed route layer in `apps/api/src/routes/control-plane.http-api.ts`.
- Update API startup wiring in `apps/api/src/index.ts` to use `ControlPlaneDataAccessLive` plus
  control-plane capability layers.

**Non-goals (explicitly not changed)**

- No DB schema migrations.
- No queue topology changes.
- No additional frontend/web behavior changes.

**Design decision**

- Follow the five-service SOP in `api-route-effect-approach.mdx`: repository services + capability
  services + API contract services feeding thin per-domain HTTP bindings at the app boundary.
- Keep non-Effect dependencies behind explicit `Effect.tryPromise` boundaries in domain modules
  until those packages expose native Effect services.

**Reviewer guide (recommended order)**

1. `packages/api-contracts/src/core-api/control-plane.ts` and new contract files - endpoint shapes
   and error contracts.
2. `apps/api/src/routes/control-plane.http-api.ts` - composed handler wiring.
3. `apps/api/src/routes/sandboxes/sandboxes.module.ts` - largest behavior migration surface.
4. `apps/api/src/routes/{packages,registries,system}/*.module.ts` - remaining migrated domains.
5. `apps/api/src/services/control-plane-capabilities.ts` and `apps/api/src/index.ts` - runtime
   composition and layer provisioning.

**Implementation summary**

- Added four new Effect contract groups and attached them to `ControlPlaneAPI`.
- Added Effect module + binding pairs for `system`, `packages`, `registries`, and `sandboxes`.
- Introduced `ControlPlaneCapabilitiesLive` to centralize Promise-backed integration boundaries.
- Switched app bootstrap from GitHub-only API layer to full control-plane API layer.
- Preserved GitHub group behavior and exported `GitHubHandlersLive` for merged composition.

**Validation and results**

- `pnpm format:fix`
- `pnpm typecheck`

Both commands passed after migration and wiring updates.

**Risk and mitigation**

- Primary risk is behavior drift on sandbox endpoints due to migration size.
- Mitigated by retaining existing persistence/service dependencies, preserving route shapes, and
  validating with full monorepo typecheck.
- Mitigated by keeping contracts explicit in `@sealant/api-contracts` and using typed boundary
  errors in modules.

**Follow-ups**

- Add focused API tests for migrated `packages`, `registries`, and `sandboxes` Effect handlers.
- Remove or archive deprecated Hono route files once migration confidence gates are complete.
- Replace `TBD` in `links` with final PR URL and set `status` to `merged` after merge.

### CHG-2026-04-12-001 - Stabilize DB Client Wiring and Effect Repository Access

| Field    | Value                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status` | `in_review`                                                                                                                                                                                      |
| `owners` | `engineering`                                                                                                                                                                                    |
| `scope`  | `packages/db`, `packages/auth`, `packages/sandboxes`, `apps/api`, `apps/web`, `apps/worker`, `apps/docs`, `flake.nix`                                                                            |
| `tags`   | `arch:effect`, `area:db`, `area:api`, `area:web`, `area:worker`, `area:auth`, `area:docs`, `domain:sandboxes`, `domain:issue-workflows`, `domain:source-integrations`, `kind:fix`, `risk:medium` |
| `links`  | PR: `https://github.com/get-sealant/sealant/pull/55`, commits: `ba6ae9e`, `ea094d8`, `f6e0e67`                                                                                                   |

**PR Description (copy-ready)**

This PR stabilizes control-plane DB usage across API/web/worker/auth flows by aligning Drizzle
client construction, moving sandbox worker paths onto Effect repository services, and documenting
the change with the changelog contract.

**Key changes**

- **Split DB client responsibilities by runtime:** Add a dedicated promise-based
  `createBetterAuthDatabaseClient*` for Better Auth while keeping Effect-based `createSealantDB*`
  for service-layer consumers.
- **Fix casing drift for PostgreSQL queries:** Set Effect Drizzle client `casing: "snake_case"` and
  wire explicit schema relations to prevent generated SQL from requesting camelCase columns.
- **Adopt relation-driven repository reads:** Move repository read paths in GitHub installations,
  profiles, repository profiles, sandboxes, issue workflows, and issue workflow executions to
  `db.query.*` + `with` loading patterns.
- **Move sandbox worker DB access to Effect services:** Replace direct repository constructor usage
  with repository tags/layers in sandbox build orchestration and GitHub installation auth resolver.
- **Strengthen app boundary wiring:** Update API package standardizer calls, worker startup DB
  wiring, web imports, and auth startup to use the updated DB client contracts.
- **Changelog-first PR discipline:** Add this entry and update tag index for canonical review and
  incident/debug traceability.

**Scope in this PR**

- Add new Better Auth DB client construction utilities in `packages/db/src/better-auth-client.ts`
  and package exports in `packages/db/src/index.ts`.
- Update Effect DB construction and helpers in `packages/db/src/client.ts`.
- Add explicit relation definitions in `packages/db/src/schema/relations.ts` and adopt
  relation-aware query patterns in repository implementations.
- Update DB consumer wiring in `packages/auth/src/server.ts`,
  `apps/worker/src/workers/sandboxes.ts`, `apps/web/src/lib/trpc/context.ts`,
  `apps/api/src/lib/create-package-standardizer.ts`, and sandbox worker internals.
- Record implementation details in `apps/docs/contents/changelog/index.md`.

**Non-goals (explicitly not changed)**

- No schema migration shape changes.
- No HTTP API contract or payload schema changes.
- No queue topology changes for sandbox build orchestration.

**Design decision**

- Keep Better Auth on a promise-based Drizzle client while Effect services continue to consume
  Effect-native DB clients.
- Standardize Postgres query casing in Drizzle client config and centralize relation definitions to
  remove implicit relation inference.
- Prefer repository tag/layer composition at runtime boundaries over direct repository constructors.

**Reviewer guide (recommended order)**

1. `packages/db/src/better-auth-client.ts` and `packages/db/src/client.ts` - DB client split,
   casing, and helper constructors.
2. `packages/db/src/schema/relations.ts` - explicit relation map used by all Drizzle clients.
3. `packages/db/src/repositories/*.ts` (changed files) - relation-based read path rewrites.
4. `packages/sandboxes/src/worker/process-sandbox-build-job.ts` and
   `packages/sandboxes/src/worker/github-installation-auth-resolver.ts` - runtime Effect repository
   composition.
5. `packages/auth/src/server.ts`, `apps/worker/src/workers/sandboxes.ts`, and
   `apps/api/src/lib/create-package-standardizer.ts` - consumer wiring updates.
6. `apps/docs/contents/changelog/index.md` - changelog entry and tag index.

**Key before/after snippets**

DB client construction:

```ts
// Before
const dbEffect = PgDrizzle.makeWithDefaults({ schema, relations });

// After
const dbEffect = PgDrizzle.makeWithDefaults({ schema, relations, casing: "snake_case" });
```

Sandbox worker repository access:

```ts
// Before
const jobs = createSandboxBuildJobRepository(options.dbClient);
await jobs.claimJobById(...);

// After
const dbLayer = Layer.succeed(SealantDB, options.db);
const dataAccessLayer = Layer.mergeAll(SandboxBuildJobRepoLive, ...).pipe(Layer.provide(dbLayer));
const repos = await Effect.runPromise(Effect.gen(function* () { ... }).pipe(Effect.provide(dataAccessLayer)));
await Effect.runPromise(repos.jobs.claimJobById(...));
```

**Implementation summary**

- Added promise-based Better Auth DB client constructor utilities and exports at `@sealant/db` root.
- Added `createSealantDB*` helpers and `casing: "snake_case"` to Effect PostgreSQL Drizzle config.
- Added explicit schema relation definitions and updated repository read paths to use relation-aware
  query APIs.
- Updated sandbox worker internals to compose repository services via Effect layers.
- Updated API/auth/web/worker integration code to consume the new DB helpers and effectful
  repositories.
- Added this changelog entry and updated tag index.

**Validation and results**

- `pnpm format:fix`
- `pnpm typecheck`

Both commands passed during implementation.

**Risk and mitigation**

- Primary risk is runtime behavior drift while moving worker/repository access from direct
  constructors to Effect service composition.
- Mitigated by preserving repository interfaces and limiting this PR to wiring/query-path changes.
- Mitigated by full monorepo formatting and typecheck validation.

**Follow-ups**

- Add focused repository integration tests for relation-based `db.query.*` paths in
  `issue-workflows`, `profiles`, and `sandboxes` repositories.
- Add a regression test covering `github_app_installations.created_at`/`updated_at` selection
  through Effect DB clients.
- Keep `links` and `status` synchronized with final PR URL and merge state.

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
