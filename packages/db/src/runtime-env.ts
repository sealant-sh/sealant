import { databaseEnvSchema, parseDatabaseEnv, type DatabaseEnv } from "@sealant/validators/env";

export { databaseEnvSchema, parseDatabaseEnv, type DatabaseEnv };

export const databaseEnv = parseDatabaseEnv(process.env);
