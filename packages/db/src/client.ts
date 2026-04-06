import { defineRelations } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as schema from "./schema.js";

//Define relations
const relations = defineRelations(schema);

// Build an Effect that, when run with required dependencies (PgClient + defaults),
// creates a Drizzle DB instance typed with schema and relations.
const dbEffect = PgDrizzle.makeWithDefaults({ schema, relations });

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
