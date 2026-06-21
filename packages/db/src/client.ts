import * as PgClient from "@effect/sql-pg/PgClient";
import { parseDatabaseEnv } from "@sealant/validators/env";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";

import { relations } from "./schema/relations.js";

// Build an Effect that, when run with required dependencies (PgClient + defaults),
// creates a Drizzle DB instance typed with schema and relations.
const dbEffect = PgDrizzle.makeWithDefaults({ relations });

// Extract the "success value" type from that Effect.
// This becomes the actual DB type (schema-aware).
export type DB = Effect.Success<typeof dbEffect>;

// Define a typed service tag named "SealantDB".
// Anywhere you `yield* SealantDB`, you'll get a value of type `DB`.
export class SealantDB extends Context.Service<SealantDB, DB>()("SealantDB") {}

// Export a type alias for the service tag, so you can refer to it as `TSealantDB` in your code.
export type TSealantDB = Context.Service.Shape<typeof SealantDB>;

// Create a Layer that provides the SealantDB service by running `dbEffect`.
export const SealantDBLive = Layer.effect(SealantDB, dbEffect);

export const makeSealantDBLayer = (databaseUrl: string) => {
  return SealantDBLive.pipe(
    Layer.provide(
      PgClient.layer({
        url: Redacted.make(databaseUrl),
      }),
    ),
  );
};

export const createSealantDB = async (databaseUrl: string): Promise<DB> => {
  // The Postgres pool is a scoped resource of `PgClient.layer`. Extracting the DB through
  // `Effect.provide(...)` + `runPromise` would close that scope as soon as the handle is returned,
  // releasing the pool and breaking every later query/transaction ("Failed to acquire connection
  // for transaction"). Build the layer into a scope that lives for the whole process instead, so
  // the pool stays open for the lifetime of the returned handle.
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(makeSealantDBLayer(databaseUrl), scope),
  );
  return Context.get(context, SealantDB);
};

export const createSealantDBFromEnv = async (
  input: Record<string, string | undefined> = process.env,
): Promise<DB> => {
  const env = parseDatabaseEnv(input);
  return createSealantDB(env.DATABASE_URL);
};
