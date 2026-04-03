---
title: "@sealant/db Effect service layer"
slug: /packages/db/effect-service-layer
status: draft
owner: engineering
updated: 2026-04-03
---

## Purpose

This page explains how `@sealant/db` composes PostgreSQL access with an Effect service tag and a
live integration layer.

It is the step-by-step reference for `packages/db/src/service.ts` and how it uses
`packages/db/src/client.ts`.

## Architecture at a glance

- `client.ts` is the low-level Postgres integration adapter.
- `service.ts` defines the Effect service contract and integration layers.
- Consumers should depend on the service tag contract and provide layers at boundaries.

## Step-by-step flow

1. **Config tag defines required inputs**

   `DatabaseServiceConfig` is a tag for `DatabaseClientOptions` (currently centered on
   `connectionString`).

2. **Service tag defines API surface**

   `DatabaseServiceTag` is the runtime contract. It currently exposes only one capability: `db`
   (typed Drizzle instance).

3. **Acquire phase reads config and opens connection**

   `makeDatabaseClientResource` reads `DatabaseServiceConfig` and calls
   `createDatabaseClient(options)` from `client.ts`.

4. **Release phase closes the pool**

   `releaseDatabaseClientResource` calls `closeDatabaseClient(client)` to drain and close the
   Postgres pool.

5. **Live layer manages resource lifecycle**

   `databaseServiceLiveLayer` uses `Layer.scoped` + `Effect.acquireRelease` so opening and closing
   the DB client is automatic and bound to layer scope.

6. **Configured layer wires config into live layer**

   `databaseServiceLayer(options)` builds `databaseServiceConfigLayer(options)` and provides it to
   `databaseServiceLiveLayer`.

7. **Env helper composes from runtime env**

   `databaseServiceFromEnvLayer(env)` maps `DATABASE_URL` into client options, then delegates to
   `databaseServiceLayer(...)`.

## Why `client.ts` and `service.ts` are separate

- `client.ts` keeps integration details (`pg` pool, Drizzle construction, probe query).
- `service.ts` keeps dependency injection shape (tags, layers, scope).
- This separation lets repositories stay stable while runtime composition evolves.

## Typical usage pattern

Provide once at an app boundary, then consume the service in effects.

```ts
import { Effect } from "effect";
import { DatabaseServiceTag, databaseServiceFromEnvLayer } from "@sealant/db";

const program = Effect.gen(function* () {
  const dbService = yield* DatabaseServiceTag;
  return yield* dbService.db.query.repositories.findMany();
});

const runnable = program.pipe(Effect.provide(databaseServiceFromEnvLayer()));
```

## Current notes

- Some existing app/package call sites still use imperative DB factories while migration is in
  progress.
- The target architecture is service-tag contract first, integration in layers, and boundary-level
  composition.
