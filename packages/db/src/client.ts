import * as PgClient from "@effect/sql-pg/PgClient";
import { parseDatabaseEnv } from "@sealant/validators/env";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as schema from "./schema.js";
import { relations } from "./schema/relations.js";

// Build an Effect that, when run with required dependencies (PgClient + defaults),
// creates a Drizzle DB instance typed with schema and relations.
const dbEffect = PgDrizzle.makeWithDefaults({ schema, relations, casing: "snake_case" });

// Extract the "success value" type from that Effect.
// This becomes the actual DB type (schema-aware).
export type DB = Effect.Effect.Success<typeof dbEffect>;

// Define a typed service tag named "SealantDB".
// Anywhere you `yield* SealantDB`, you'll get a value of type `DB`.
export class SealantDB extends Context.Tag("SealantDB")<SealantDB, DB>() {}

// Export a type alias for the service tag, so you can refer to it as `TSealantDB` in your code.
export type TSealantDB = Context.Tag.Service<typeof SealantDB>;

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
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* SealantDB;
    }).pipe(Effect.provide(makeSealantDBLayer(databaseUrl))),
  );
};

export const createSealantDBFromEnv = async (
  input: Record<string, string | undefined> = process.env,
): Promise<DB> => {
  const env = parseDatabaseEnv(input);
  return createSealantDB(env.DATABASE_URL);
};
