---
title: Changelog
slug: /changelog
status: draft
owner: engineering
updated: 2026-04-03
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

| Tag             | Entries              |
| --------------- | -------------------- |
| `arch:effect`   | `CHG-2026-04-02-001` |
| `area:api`      | `CHG-2026-04-02-001` |
| `area:rabbitmq` | `CHG-2026-04-02-001` |
| `area:docs`     | `CHG-2026-04-02-001` |
| `kind:refactor` | `CHG-2026-04-02-001` |
| `risk:medium`   | `CHG-2026-04-02-001` |

## Entries (newest first)

### CHG-2026-04-02-001 - Initial Effect Service Runtime Wiring

| Field    | Value                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `status` | `in_review`                                                                                                              |
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
