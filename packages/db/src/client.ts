import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient, type Client as LibsqlClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { databaseEnv, type DatabaseEnv } from "./runtime-env.js";
import * as schema from "./schema.js";

export interface DatabaseClientOptions {
  readonly filePath: string;
  readonly busyTimeoutMs?: number;
}

export type SqliteDatabaseConnection = LibsqlClient;

export type SealantDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseClient {
  readonly connection: SqliteDatabaseConnection;
  readonly db: SealantDatabase;
}

const ensureDatabaseDirectoryExists = (filePath: string) => {
  if (filePath === ":memory:" || filePath === "file::memory:") {
    return;
  }

  mkdirSync(dirname(filePath), {
    recursive: true,
  });
};

const toLibsqlUrl = (filePath: string): string => {
  if (filePath === ":memory:" || filePath === "file::memory:") {
    return "file::memory:";
  }

  if (filePath.startsWith("file:")) {
    return filePath;
  }

  return pathToFileURL(resolve(filePath)).toString();
};

export const createSqliteConnection = async (
  options: DatabaseClientOptions,
): Promise<SqliteDatabaseConnection> => {
  ensureDatabaseDirectoryExists(options.filePath);

  const connection = createClient({
    url: toLibsqlUrl(options.filePath),
  });

  await connection.execute("PRAGMA journal_mode = WAL");
  await connection.execute("PRAGMA foreign_keys = ON");
  await connection.execute(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);

  return connection;
};

export const createDatabaseClient = async (
  options: DatabaseClientOptions,
): Promise<DatabaseClient> => {
  const connection = await createSqliteConnection(options);

  return {
    connection,
    db: drizzle(connection, {
      schema,
      casing: "snake_case",
    }),
  };
};

export const createDatabaseClientFromEnv = async (
  env: DatabaseEnv = databaseEnv,
): Promise<DatabaseClient> => {
  return createDatabaseClient({
    filePath: env.DATABASE_FILE_PATH,
    busyTimeoutMs: env.DATABASE_BUSY_TIMEOUT_MS,
  });
};

export const closeDatabaseClient = (client: DatabaseClient) => {
  client.connection.close();
};
