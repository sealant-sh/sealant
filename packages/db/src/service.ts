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
 */
export class DatabaseServiceTag extends Context.Tag("@sealant/db/DatabaseService")<
  DatabaseServiceTag,
  {
    readonly db: SealantDatabase;
  }
>() {}

export type DatabaseService = Context.Tag.Service<typeof DatabaseServiceTag>;

const toClientOptions = (env: DatabaseEnv): DatabaseClientOptions => {
  return {
    connectionString: env.DATABASE_URL,
  };
};

const makeDatabaseClientResource = Effect.gen(function* () {
  const options = yield* DatabaseServiceConfig;

  return yield* Effect.promise(() => createDatabaseClient(options));
});

const releaseDatabaseClientResource = (client: DatabaseClient) => {
  return Effect.promise(() => closeDatabaseClient(client));
};

/** Live DB service integration layer with managed Postgres pool lifecycle. */
export const databaseServiceLiveLayer = Layer.scoped(
  DatabaseServiceTag,
  Effect.acquireRelease(makeDatabaseClientResource, releaseDatabaseClientResource).pipe(
    Effect.map((client): DatabaseService => {
      return {
        db: client.db,
      };
    }),
  ),
);

/** Builds a DB config layer from explicit client options. */
export const databaseServiceConfigLayer = (options: DatabaseClientOptions) => {
  return Layer.succeed(DatabaseServiceConfig, options);
};

/** Builds a live DB service layer from explicit client options. */
export const databaseServiceLayer = (options: DatabaseClientOptions) => {
  const configLayer = databaseServiceConfigLayer(options);

  return databaseServiceLiveLayer.pipe(Layer.provide(configLayer));
};

/** Builds a live DB service layer from runtime environment values. */
export const databaseServiceFromEnvLayer = (env: DatabaseEnv = databaseEnv) => {
  return databaseServiceLayer(toClientOptions(env));
};

/** Accessor effect for the typed Drizzle DB instance from service context. */
export const database = Effect.map(DatabaseServiceTag, (service) => service.db);
