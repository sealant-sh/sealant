---
title: Effect and API conventions
description:
  The five-service wiring pattern every control-plane API route follows, from Postgres repository to
  HTTP handler.
---

This is the conventions guide for API work in `apps/api` — from `@sealant/db` repositories to HTTP
handlers. Use it when adding or reviewing any new route domain. The GitHub route group
(`apps/api/src/routes/github/*`) is the current production example; new domains should follow the
same shape.

## The five services

Wire every domain from persistence to transport, in this order:

1. **DB service** (`packages/db/src/client.ts`) — one typed Drizzle DB service tag. Provides
   `SealantDB` via `SealantDBLive`. No route or business logic here.
2. **Repository services** (`packages/db/src/repositories/*.ts`) — one service per aggregate/table
   boundary. Each exports a service interface, a `Context.Tag`, and a `*Live` layer built with
   `Layer.effect`. Persistence only — no HTTP or provider calls.
3. **Capability services** (e.g. `packages/source-integrations/src/github/*`) — external/provider
   logic behind a service tag and a live layer (GitHub App auth is the current example). No imports
   from `apps/api`.
4. **HTTP contract service** (`packages/api-contracts/src/core-api/*`) — endpoint IDs, request/query
   schemas, response schemas, and typed API errors as an `HttpApi` group. Schemas and types only —
   no side effects, no repository access, no layer wiring.
5. **Per-domain HTTP implementation** (`apps/api/src/routes/<domain>/*`) — endpoint behavior as
   plain Effects in `<domain>.module.ts`, bound to the contract in a thin `<domain>.http-api.ts` via
   `HttpApiBuilder.group(...)`.

Consumes/provides chain:

```text
Service 1 (DB) -> Service 2 (Repos) -> Service 5 (HTTP impl)
                           \-> Service 3 (Capability) -/
Service 4 (HTTP contract) -----------------------------> Service 5 (HTTP impl)
Service 5 (HTTP impl) ---------------------------------> Runtime bootstrap (apps/api/src/index.ts)
```

If a new route can be explained with this same five-service chain, the wiring is correct for this
repo.

## Concrete example: the GitHub route

Repository service and live layer (`packages/db/src/repositories/github-installations.ts`):

```ts
export class GitHubInstallationRepo extends Context.Tag("GitHubInstallationRepo")<
  GitHubInstallationRepo,
  GitHubInstallationRepoService
>() {}

export const GitHubInstallationRepoLive = Layer.effect(
  GitHubInstallationRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;
    return {
      getInstallationById: (id) =>
        withGitHubInstallationRepoError(
          "getInstallationById",
          Effect.gen(function* () {
            const [installation] = yield* db
              .select()
              .from(githubAppInstallations)
              .where(eq(githubAppInstallations.id, id))
              .limit(1);
            return installation;
          }),
        ),
      // ...other repository operations
    };
  }),
);
```

Repo bundle layer (`packages/db/src/layers.ts`):

```ts
export const GitHubDataAccessLive = Layer.mergeAll(
  GitHubInstallationRepoLive,
  GitHubInstallationRepositoryCacheRepoLive,
  GitHubWebhookDeliveryRepoLive,
  RepositoryProfileRepoLive,
);
```

HTTP contract (`packages/api-contracts/src/core-api/github.ts` and `control-plane.ts`):

```ts
export const GitHubGroup = HttpApiGroup.make("github").add(
  HttpApiEndpoint.get("listInstallations", "/installations", {
    query: githubInstallationsQuerySchema,
    success: listGitHubInstallationsResponseSchema,
    error: [GitHubServiceUnavailableError, GitHubInternalServerError],
  }),
);

export const ControlPlaneAPI = HttpApi.make("sealantControlPlaneApi").add(
  GitHubGroup.prefix("/v1/github"),
);
```

Domain use-case (`apps/api/src/routes/github/github.module.ts`):

```ts
export const listInstallations = (query: GitHubInstallationsQuery) => {
  return Effect.gen(function* () {
    const installationRepo = yield* GitHubInstallationRepo;
    const installations = yield* withInternalError(
      installationRepo.listInstallationsForUser({ userId: query.userId, status: "active" }),
      "Failed to list GitHub installations.",
    );
    return {
      items: installations.map(toInstallationSummary),
    } satisfies ListGitHubInstallationsResponse;
  });
};
```

Thin handler binding (`apps/api/src/routes/github/github.http-api.ts`):

```ts
const GitHubHandlersLive = HttpApiBuilder.group(ControlPlaneAPI, "github", (handlers) => {
  return handlers
    .handle("listInstallations", ({ query }) => listInstallations(query))
    .handle("importInstallation", ({ payload }) => importInstallation(payload));
});
```

Runtime composition (`apps/api/src/index.ts`) provides layers bottom-up:

```ts
const databaseClientLayer = SealantDBLive.pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(env.DATABASE_URL) })),
);
const databaseLayer = GitHubDataAccessLive.pipe(Layer.provide(databaseClientLayer));
const apiLayer = makeGitHubHttpApiLayer().pipe(
  Layer.provide(gitHubSourceIntegrationLayer({ apiBaseUrl: env.GITHUB_API_BASE_URL })),
  Layer.provide(databaseLayer),
);
```

That is the full stack, from Drizzle repository implementation to served HTTP handler:
`PgClient.layer(...)` → `SealantDBLive` → `GitHubDataAccessLive` → the capability layer → the
`HttpApi` layer → OpenAPI/Scalar and CORS middleware → `HttpApiBuilder.serve()` +
`NodeHttpServer.layer(...)`.

## The DB service tag (`packages/db/src/client.ts`)

`@sealant/db` exposes Postgres access as one Effect service, `SealantDB`:

- `SealantDB` — a `Context.Service` tag whose shape is the typed Drizzle instance (schema- and
  relations-aware, built via `PgDrizzle.makeWithDefaults`).
- `SealantDBLive` — `Layer.effect(SealantDB, dbEffect)`, the live layer. It still needs a
  `PgClient.layer(...)` provided underneath it for the actual connection.
- `makeSealantDBLayer(databaseUrl)` — convenience wrapper that provides
  `PgClient.layer({ url: ... })` for you.
- `createSealantDB(databaseUrl)` / `createSealantDBFromEnv(env)` — imperative escape hatches for
  non-Effect call sites (migration scripts, seed scripts) that need a plain `DB` handle without
  building a full Effect runtime. These build the layer into a process-lifetime `Scope` so the
  connection pool doesn't close underneath the returned handle.

Repository services (`packages/db/src/repositories/*.ts`) depend only on `SealantDB`, never on
`PgClient` directly — that keeps the Postgres/pooling concern isolated to one place while repository
implementations stay stable. Usage inside an Effect program:

```ts
import { Effect } from "effect";
import { SealantDB, makeSealantDBLayer } from "@sealant/db";

const program = Effect.gen(function* () {
  const db = yield* SealantDB;
  return yield* Effect.promise(() => db.query.repositories.findMany());
});

const runnable = program.pipe(Effect.provide(makeSealantDBLayer(databaseUrl)));
```

`packages/db/src/layers.ts` then bundles repository layers into convenience aggregates —
`GitHubDataAccessLive` for the GitHub-only surface, `ControlPlaneDataAccessLive` as the "most
repositories" default most of `apps/api` provides. Neither constructs `SealantDB` itself; the app
boundary (`apps/api/src/index.ts`) provides it.

## Error strategy

Two stages:

1. **Internal errors** — repository errors (`*RepoInvariantError`, `*RepoUnexpectedError`) and
   capability errors (`GitHubSourceIntegration*Error`).
2. **Boundary errors** — API contract errors in `@sealant/api-contracts` (400/401/403/404/500/503).

Map internal errors to boundary errors inside `apps/api/src/routes/*/*.module.ts`. Never return raw
repository or capability errors over HTTP.

## Service granularity

- One repository service per repository, in `@sealant/db`.
- One capability service per external provider/integration package.
- Endpoint behavior as plain exported Effects in `*.module.ts` — not one service per handler.

Introduce an additional domain service in `apps/api` only when behavior must be shared across
multiple runtimes (HTTP + worker + scheduled job, for example).

## Route implementation checklist

1. Add or extend repository services in `@sealant/db`.
2. Add or extend capability package services for external systems.
3. Define HTTP schemas/errors/endpoints in `packages/api-contracts`.
4. Implement domain behavior in `apps/api/src/routes/<domain>/<domain>.module.ts`.
5. Bind handlers in `apps/api/src/routes/<domain>/<domain>.http-api.ts`.
6. Provide the required layers in `apps/api/src/index.ts`.
7. Add tests for success paths and error mapping.

## What to avoid

- Business logic in `*.http-api.ts` — keep it a thin binding layer.
- Importing app route code from capability or `@sealant/db` packages — the dependency direction only
  goes one way: `apps/api` depends on `packages/api-contracts`, `packages/db`, and capability
  packages, never the reverse.
- Returning raw internal repository/capability errors over HTTP.
- Runtime layer composition inside `packages/api-contracts` — it defines shape only.

## Reference

- `apps/api/src/index.ts` — layer composition and server bootstrap.
- `packages/db/src/client.ts`, `packages/db/src/service.ts`, `packages/db/src/layers.ts`.
- `packages/api-contracts/src/core-api/control-plane.ts`.
- Effect patterns generally: consult `pnpm exec effect-solutions list` /
  `pnpm exec effect-solutions show <topic>` before writing new Effect code — see `AGENTS.md`.
