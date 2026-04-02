import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import { databaseEnv, type DatabaseEnv } from "./runtime-env.js";
import * as schema from "./schema.js";

export interface DatabaseClientOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly idleTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
}

export type PostgresDatabaseConnection = Pool;

export type SealantDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseClient {
  readonly connection: PostgresDatabaseConnection;
  readonly db: SealantDatabase;
}

const toPoolConfig = (options: DatabaseClientOptions): PoolConfig => {
  return {
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMillis: options.idleTimeoutMs }),
    ...(options.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMs }),
  };
};

export const createPostgresConnection = async (
  options: DatabaseClientOptions,
): Promise<PostgresDatabaseConnection> => {
  const connection = new Pool(toPoolConfig(options));

  try {
    await connection.query("select 1");
    return connection;
  } catch (error) {
    await connection.end();
    throw error;
  }
};

export const createDatabaseClient = async (
  options: DatabaseClientOptions,
): Promise<DatabaseClient> => {
  const connection = await createPostgresConnection(options);

  return {
    connection,
    db: drizzle({
      client: connection,
      schema,
      casing: "snake_case",
    }),
  };
};

export const createDatabaseClientFromEnv = async (
  env: DatabaseEnv = databaseEnv,
): Promise<DatabaseClient> => {
  return createDatabaseClient({
    connectionString: env.DATABASE_URL,
  });
};

export const closeDatabaseClient = async (client: DatabaseClient) => {
  await client.connection.end();
};
