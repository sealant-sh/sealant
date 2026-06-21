import { parseDatabaseEnv } from "@sealant/validators/env";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import { relations } from "./schema/relations.js";

// Better Auth's Drizzle adapter expects promise-based query execution.
// Keep this client scoped to auth flows only; use `createSealantDB*` for Effect services.
export type BetterAuthDatabaseClient = NodePgDatabase<typeof relations>;

export const createBetterAuthDatabaseClient = (databaseUrl: string): BetterAuthDatabaseClient => {
  return drizzle({
    connection: databaseUrl,
    relations,
  });
};

export const createBetterAuthDatabaseClientFromEnv = (
  input: Record<string, string | undefined> = process.env,
): BetterAuthDatabaseClient => {
  const env = parseDatabaseEnv(input);
  return createBetterAuthDatabaseClient(env.DATABASE_URL);
};
