import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const defaultDatabaseFilePath = resolve(packageDirectory, ".data", "sealant-control-plane.sqlite");

export const databaseEnvSchema = z.object({
  DATABASE_FILE_PATH: z.string().trim().min(1).default(defaultDatabaseFilePath),
  DATABASE_BUSY_TIMEOUT_MS: z.coerce.number().int().min(0).default(5000),
});

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

export const parseDatabaseEnv = (input: Record<string, string | undefined>): DatabaseEnv => {
  return databaseEnvSchema.parse(input);
};

const runtimeProcess = globalThis as typeof globalThis & {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

export const databaseEnv = parseDatabaseEnv(runtimeProcess.process?.env ?? {});
