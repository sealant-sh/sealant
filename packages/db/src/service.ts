import { Context, Effect, Layer } from "effect";

import {
  closeDatabaseClient,
  createDatabaseClient,
  type DatabaseClient,
  type DatabaseClientOptions,
  type SealantDatabase,
} from "./client.js";
import { databaseEnv, type DatabaseEnv } from "./runtime-env.js";

/** Configuration tag for providing DB client options into the live service layer. */
export class DatabaseServiceConfig extends Context.Tag("@sealant/db/DatabaseServiceConfig")<
  DatabaseServiceConfig,
  DatabaseClientOptions
>() {}

/**
 * Runtime DB service contract used by Effect-based composition.
 *
 * Exposes both the raw client and typed Drizzle instance so existing repositories can keep their
 * current APIs while adopting service boundaries.
 */
export class DatabaseServiceTag extends Context.Tag("@sealant/db/DatabaseService")<
  DatabaseServiceTag,
  {
    readonly client: DatabaseClient;
    readonly db: SealantDatabase;
    readonly close: () => Promise<void>;
  }
>() {}

export type DatabaseService = Context.Tag.Service<typeof DatabaseServiceTag>;

const toClientOptions = (env: DatabaseEnv): DatabaseClientOptions => {
  return {
    connectionString: env.DATABASE_URL,
  };
};

/** Live DB service implementation backed by `createDatabaseClient`. */
export const databaseServiceLiveLayer = Layer.effect(
  DatabaseServiceTag,
  Effect.gen(function* () {
    const options = yield* DatabaseServiceConfig;
    const client = yield* Effect.promise(() => createDatabaseClient(options));

    return {
      client,
      db: client.db,
      close: () => closeDatabaseClient(client),
    };
  }),
);

/** Builds a live DB service layer from explicit client options. */
export const databaseServiceLayer = (options: DatabaseClientOptions) => {
  const configLayer = Layer.succeed(DatabaseServiceConfig, options);

  return databaseServiceLiveLayer.pipe(Layer.provide(configLayer));
};

/** Builds a live DB service layer from runtime environment values. */
export const databaseServiceFromEnvLayer = (env: DatabaseEnv = databaseEnv) => {
  return databaseServiceLayer(toClientOptions(env));
};

/** Materializes the DB service contract from explicit options. */
export const createDatabaseService = async (
  options: DatabaseClientOptions,
): Promise<DatabaseService> => {
  return Effect.runPromise(DatabaseServiceTag.pipe(Effect.provide(databaseServiceLayer(options))));
};

/** Materializes the DB service contract from runtime environment values. */
export const createDatabaseServiceFromEnv = async (
  env: DatabaseEnv = databaseEnv,
): Promise<DatabaseService> => {
  return Effect.runPromise(
    DatabaseServiceTag.pipe(Effect.provide(databaseServiceFromEnvLayer(env))),
  );
};
