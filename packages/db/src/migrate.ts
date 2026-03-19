import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/libsql/migrator";

import { closeDatabaseClient, createDatabaseClientFromEnv } from "./client.js";

export const runMigrations = async () => {
  const client = await createDatabaseClientFromEnv();

  try {
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  } finally {
    closeDatabaseClient(client);
  }
};
