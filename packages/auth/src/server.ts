import {
  createDatabaseClientFromEnv,
  runMigrations,
  schema,
  type DatabaseClient,
} from "@sealant/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";

import { authEnv, type AuthEnv } from "./env.js";

export interface CreateSealantAuthOptions {
  readonly databaseClient?: DatabaseClient;
  readonly env?: AuthEnv;
}

let migrationsPromise: Promise<void> | undefined;

const ensureDatabaseReady = (env: AuthEnv) => {
  if (env.NODE_ENV === "production") {
    return Promise.resolve();
  }

  migrationsPromise ??= runMigrations();
  return migrationsPromise;
};

const toTrustedOrigins = (env: AuthEnv): Array<string> => {
  const trustedOrigins = new Set(env.BETTER_AUTH_TRUSTED_ORIGINS);

  if (env.BETTER_AUTH_URL !== undefined) {
    trustedOrigins.add(new URL(env.BETTER_AUTH_URL).origin);
  }

  return [...trustedOrigins];
};

export const createSealantAuth = async (options: CreateSealantAuthOptions = {}) => {
  const resolvedEnv = options.env ?? authEnv;

  if (options.databaseClient === undefined) {
    await ensureDatabaseReady(resolvedEnv);
  }

  const resolvedDatabaseClient = options.databaseClient ?? (await createDatabaseClientFromEnv());
  const trustedOrigins = toTrustedOrigins(resolvedEnv);

  return betterAuth({
    appName: resolvedEnv.BETTER_AUTH_APP_NAME,
    ...(resolvedEnv.BETTER_AUTH_SECRET === undefined
      ? {}
      : {
          secret: resolvedEnv.BETTER_AUTH_SECRET,
        }),
    ...(resolvedEnv.BETTER_AUTH_URL === undefined
      ? {}
      : {
          baseURL: resolvedEnv.BETTER_AUTH_URL,
        }),
    ...(trustedOrigins.length === 0
      ? {}
      : {
          trustedOrigins,
        }),
    database: drizzleAdapter(resolvedDatabaseClient.db, {
      provider: "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    advanced: {
      useSecureCookies: resolvedEnv.NODE_ENV === "production",
    },
    plugins: [tanstackStartCookies()],
  });
};

export type SealantAuth = Awaited<ReturnType<typeof createSealantAuth>>;

let authPromise: Promise<SealantAuth> | undefined;

export const getSealantAuth = (options: CreateSealantAuthOptions = {}) => {
  if (options.databaseClient !== undefined || options.env !== undefined) {
    return createSealantAuth(options);
  }

  authPromise ??= createSealantAuth();
  return authPromise;
};
