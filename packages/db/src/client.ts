import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import { databaseEnv, type DatabaseEnv } from "./runtime-env.js";
import * as schema from "./schema.js";

export interface DatabaseClientOptions {
  /**
   * Full PostgreSQL connection URL, for example:
   * `postgresql://user:password@127.0.0.1:5432/database_name`
   */
  readonly connectionString: string;
  /** Maximum number of pooled Postgres connections. */
  readonly maxConnections?: number;
  /** Idle timeout for pooled connections in milliseconds. */
  readonly idleTimeoutMs?: number;
  /** Connection establishment timeout in milliseconds. */
  readonly connectionTimeoutMs?: number;
}

export type PostgresDatabaseConnection = Pool;

export type SealantDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseClient {
  /** Raw node-postgres pool. */
  readonly connection: PostgresDatabaseConnection;
  /** Drizzle database instance typed against Sealant schema exports. */
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

/**
 * Creates a Postgres connection pool and verifies connectivity with a probe query.
 */
export const createPostgresConnection = async (
  options: DatabaseClientOptions,
): Promise<PostgresDatabaseConnection> => {
  // Create pool first, then verify connectivity eagerly so startup fails fast.
  const connection = new Pool(toPoolConfig(options));

  try {
    await connection.query("select 1");
    return connection;
  } catch (error) {
    await connection.end();
    throw error;
  }
};

/**
 * Creates both the Postgres pool and the Drizzle database client.
 *
 * The returned client should be disposed with `closeDatabaseClient` at process shutdown.
 */
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

/** Creates a database client from validated runtime environment values. */
export const createDatabaseClientFromEnv = async (
  env: DatabaseEnv = databaseEnv,
): Promise<DatabaseClient> => {
  return createDatabaseClient({
    connectionString: env.DATABASE_URL,
  });
};

/** Gracefully drains and closes the Postgres pool. */
export const closeDatabaseClient = async (client: DatabaseClient) => {
  await client.connection.end();
};
