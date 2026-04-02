import { Context, Effect, Layer } from "effect";

import {
  closeDatabaseClient,
  createDatabaseClient,
  type DatabaseClient,
  type DatabaseClientOptions,
  type SealantDatabase,
} from "./client.js";
import { databaseEnv, type DatabaseEnv } from "./runtime-env.js";

export class DatabaseServiceConfig extends Context.Tag("@sealant/db/DatabaseServiceConfig")<
  DatabaseServiceConfig,
  DatabaseClientOptions
>() {}

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

export const databaseServiceLayer = (options: DatabaseClientOptions) => {
  const configLayer = Layer.succeed(DatabaseServiceConfig, options);

  return databaseServiceLiveLayer.pipe(Layer.provide(configLayer));
};

export const databaseServiceFromEnvLayer = (env: DatabaseEnv = databaseEnv) => {
  return databaseServiceLayer(toClientOptions(env));
};

export const createDatabaseService = async (
  options: DatabaseClientOptions,
): Promise<DatabaseService> => {
  return Effect.runPromise(DatabaseServiceTag.pipe(Effect.provide(databaseServiceLayer(options))));
};

export const createDatabaseServiceFromEnv = async (
  env: DatabaseEnv = databaseEnv,
): Promise<DatabaseService> => {
  return Effect.runPromise(
    DatabaseServiceTag.pipe(Effect.provide(databaseServiceFromEnvLayer(env))),
  );
};
