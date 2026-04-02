# Sealant Tech Debt Cleanup Audit

Date: 2026-03-31

## Goal

Find high-confidence cases of over-engineering (extra guards, redundant parsing, unnecessary
indirection), and identify where Effect services can simplify dependency management.

## Scope

- Reviewed `apps/*` and key `packages/*` used by API, web, and worker flows.
- Focused on concrete, actionable findings with file-level evidence.
- Prioritized issues that reduce complexity without changing product behavior.

## Execution Status (2026-04-03)

- Phase 1 quick wins completed:
  - API schema pass-through files removed and routes now import validators directly.
  - Duplicate TRPC list input parse removed in web router.
  - Theme parsing flow simplified to parse once at edge in docs app.
  - Cached package resolution flow no longer re-parses already typed data.
  - Impossible hex guard path removed in web appearance utilities.
- Phase 2 targeted refactors completed:
  - Worker GitHub installation auth resolution logic extracted to dedicated module.
  - Runtime env loading normalized across API, worker, and ssh-gateway via validators env parsers.
- Phase 3 Effect-first model completed for API + RabbitMQ boundaries:
  - Introduced `ApiRuntime` composition with `Clock`, `IdGenerator`, `Logger`, and config/dependency
    services.
  - Migrated API handlers to runtime service consumption (GitHub, sandboxes, packages, registries).
  - Introduced RabbitMQ service contract/layer boundary and migrated sandbox queue
    publish/consume/topology orchestration to that service.

Reference: `apps/docs/contents/changelog/index.md` (entry `CHG-2026-04-02-001`).

## Effect Services (What matters for this codebase)

Based on the Effect requirements management/services guidance:

1. Model infrastructure and cross-cutting dependencies as services, not globals.
2. Define small, explicit service interfaces (operations only), then provide implementations via
   layers.
3. Keep business logic dependent on service contracts, not concrete clients.
4. Separate service definition from live/test implementations.
5. Use composition at the boundary (main/app bootstrap), not ad-hoc wiring inside handlers.
6. Avoid hidden singleton state where lifecycle and teardown matter.
7. Prefer testable, replaceable services for time, ids, logging, config, and external APIs.
8. Keep requirements explicit so missing dependencies fail at composition time.

## Findings: Over-Engineered Patterns

### 1) Redundant runtime validation and guards

#### High priority

- `apps/web/src/routes/_authenticated/sandboxes/$sandboxId/index.tsx:94`
  - `toSandboxSummary` uses heavy manual runtime guards and object-shape checks for fields already
    validated at API client boundary.
  - Upstream parse exists at `apps/web/src/lib/api/core-api-client.ts:341` using
    `sandboxDetailsSchema`.
  - Cleanup: remove duplicate deep guards and map directly from typed result.

- `apps/web/src/routes/_authenticated/sandboxes/$sandboxId/index.tsx:112`
  - Re-runs `safeParse` on `spec` even though response object is already schema-validated.
  - Cleanup: parse once at boundary, avoid re-validation in view mapping.

- `apps/web/src/routes/_authenticated/sandboxes/$sandboxId/index.tsx:149`
  - `blueprint` mapping branch guarded with many checks, but `blueprint` is not in schema
    (`packages/validators/src/api/sandboxes.ts:104`).
  - Cleanup: remove dead branch or add schema support if `blueprint` is truly needed.

- `apps/web/src/lib/trpc/router.ts:172`
  - Optional input is already validated by `protectedProcedure.input(...)`, then parsed again
    manually.
  - Cleanup: drop second parse; use inferred typed input.

#### Medium priority

- `apps/docs/src/lib/ThemeProvider.tsx:22`
- `apps/docs/src/lib/ThemeProvider.tsx:33`
- `apps/docs/src/lib/ThemeProvider.tsx:102`
  - `UserTheme` values are parsed repeatedly in one flow.
  - Cleanup: validate once at the edge, pass typed value through.

- `packages/sandboxes/src/package-standardization.ts:605`
- `packages/sandboxes/src/package-standardization.ts:630`
  - Cached resolution is `safeParse`d and then immediately `parse`d again after only `source`
    override.
  - Cleanup: avoid second full parse when data is already typed.

- `apps/web/src/lib/theme/appearance.ts:38`
  - Checks `rawHex === undefined` after regex destructuring where `undefined` is not possible.
  - Cleanup: remove impossible guard.

- `apps/web/src/routes/_authenticated/sandboxes/new.tsx:2094`
- `apps/web/src/routes/_authenticated/sandboxes/new.tsx:2098`
- `apps/web/src/routes/_authenticated/sandboxes/new.tsx:2106`
  - Duplicate trim wrappers with same behavior.
  - Cleanup: centralize into one helper.

### 2) Thin pass-through files and extra indirection

#### High confidence

- `apps/api/src/lib/schemas.ts:1`
  - Pure re-export from `@sealant/validators`.

- `apps/api/src/routes/packages/packages.schemas.ts:1`
  - Pure re-export only used by sibling route.

- `apps/api/src/routes/github/github.schemas.ts:1`
  - Pure re-export only used by sibling route.

- `apps/api/src/routes/sandboxes/sandboxes.schemas.ts:1`
  - Pure re-export only used by sibling route.

#### Suggested simplification

- Import schema symbols directly from `@sealant/validators` in route files.
- Remove `export * from "./*.schemas.js"` hops where they add no app-specific behavior.

### 3) Low-value wrappers (keep or fold based on preference)

- `apps/api/src/lib/create-registry-client.ts:5`
- `apps/api/src/lib/create-sandbox-build-job-publisher.ts:9`
- `apps/worker/src/workers/index.ts:4`

These files are small wrappers with minor value (boundary naming and assembly). They are not
harmful, but can be folded if you want fewer files and less navigation overhead.

## Effect Service Opportunities

### Priority A: high impact

1. RabbitMQ lifecycle service
   - Current pattern: module singleton state in `packages/rabbitmq/src/singleton.ts:11`.
   - Service boundary: `RabbitMq` service with `publish`, `consume`, `assertTopology`, scoped
     acquisition/release.
   - Benefit: remove hidden global state, deterministic startup/shutdown, simpler tests.

2. API runtime dependency service
   - Current pattern: `c.set/c.get` injection in `apps/api/src/lib/create-app.ts:41` and repeated
     optional checks in handlers (example: `apps/api/src/routes/github/github.handlers.ts:345`).
   - Service boundary: `ApiRuntime` + feature services (`GitHubService`, `SandboxService`,
     `RegistryService`).
   - Benefit: less repetitive guard code, clearer required vs optional dependencies.

3. Config and secret-loading services
   - Current pattern: duplicated env/path/file hydration across apps:
     - `apps/api/src/env.ts:94`
     - `apps/worker/src/env.ts:65`
     - `apps/ssh-gateway/src/env.ts:39`
   - Service boundary: `Config`, `DotenvLoader`, `SecretFileReader`.
   - Benefit: one policy for env loading and file-backed secret resolution.

### Priority B: medium impact

4. Auth + TRPC resources service
   - Current pattern: promise singletons in:
     - `packages/auth/src/server.ts:18`
     - `apps/web/src/lib/trpc/context.ts:40`
   - Service boundary: `AuthService`, `DbService`, `CoreApiService` with scoped runtime.
   - Benefit: explicit lifecycle, easier testing/mocking.

5. GitHub installation auth resolution service (worker)
   - Current pattern: repeated installation/repository/token resolution logic in:
     - `packages/sandboxes/src/worker/process-sandbox-build-job.ts:106`
     - `packages/sandboxes/src/worker/process-sandbox-build-job.ts:176`
   - Service boundary: `GitHubInstallationAuthResolver`.
   - Benefit: de-dup logic and consistent error handling.

6. Cross-cutting utility services
   - Current pattern: direct `randomUUID`, `new Date`, and ad-hoc `console` calls in handlers.
   - Service boundary: `IdGenerator`, `Clock`, `Logger`.
   - Benefit: deterministic tests and consistent observability.

## Recommended Cleanup Plan

### Phase 1 (quick wins, low risk)

1. Remove redundant re-exports in API schema files.
2. Remove duplicate parse/guard paths in web sandbox detail mapping.
3. Remove impossible guards and duplicate trim helpers.

Expected outcome: fewer lines, clearer data flow, lower cognitive load.

### Phase 2 (targeted refactors)

1. Extract GitHub auth-resolution logic in worker into one service-like module.
2. Normalize env loading/shared utilities across API/worker/ssh-gateway.

Expected outcome: less duplication and more consistent behavior.

### Phase 3 (Effect-first dependency model)

1. Introduce infrastructure services (`Clock`, `IdGenerator`, `Logger`, `Config`).
2. Introduce `RabbitMq` and `ApiRuntime` service layers.
3. Migrate handler orchestration to depend on service interfaces.

Expected outcome: explicit requirements, cleaner composition, improved testability.

## Risk Notes

- Most Phase 1 changes are behavior-preserving if schema boundaries stay intact.
- Biggest migration risk is over-broad service introduction all at once; adopt incrementally by
  boundary.
- Keep product language stable in user-facing surfaces: focus on `sandboxes` and `issue workflows`
  terminology.

## Appendix: Candidate Backlog Tickets

1. Remove API schema passthrough files and import directly from validators.
2. Simplify `toSandboxSummary` and delete dead `blueprint` branch.
3. Remove duplicate TRPC input parsing.
4. Consolidate theme parse flow in docs app.
5. Refactor package standardization cache parse flow.
6. Add `Clock` and `IdGenerator` abstractions at API boundary.
7. Introduce RabbitMQ service layer with scoped lifecycle.
8. Introduce shared config/secret loading service utilities.
