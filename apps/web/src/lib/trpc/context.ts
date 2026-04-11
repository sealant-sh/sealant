import { createSealantAuth, type SealantAuth } from "@sealant/auth/server";
import { getAuthSession, type MaybeAuthSession } from "@sealant/auth/session";
import { createSealantDBFromEnv, type DB } from "@sealant/db";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";

import { createCoreApiClient, type CoreApiClient } from "@/lib/api/core-api-client";

interface TrpcServerResources {
  readonly auth: SealantAuth;
  readonly db: DB;
  readonly coreApi: CoreApiClient;
}

const parseCookies = (cookieHeader: string | null): ReadonlyMap<string, string> => {
  if (cookieHeader === null) {
    return new Map<string, string>();
  }

  const parsedCookies = new Map<string, string>();

  for (const segment of cookieHeader.split(";")) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const name = decodeURIComponent(segment.slice(0, separatorIndex).trim());
    const value = decodeURIComponent(segment.slice(separatorIndex + 1).trim());

    if (name.length === 0) {
      continue;
    }

    parsedCookies.set(name, value);
  }

  return parsedCookies;
};

const createDatabaseFromEnv = (): Promise<DB> => createSealantDBFromEnv();

let trpcServerResourcesPromise: Promise<TrpcServerResources> | undefined;

const getTrpcServerResources = (): Promise<TrpcServerResources> => {
  trpcServerResourcesPromise ??= (async () => {
    const db = await createDatabaseFromEnv();
    const auth = await createSealantAuth();
    const coreApi = createCoreApiClient();

    return { auth, coreApi, db };
  })();

  return trpcServerResourcesPromise;
};

export interface TrpcContext {
  readonly auth: SealantAuth;
  readonly db: DB;
  readonly coreApi: CoreApiClient;
  readonly session: MaybeAuthSession;
  readonly headers: Headers;
  readonly cookies: ReadonlyMap<string, string>;
  readonly responseHeaders: Headers;
  readonly request: Request;
}

export const createTrpcContext = async (
  options: FetchCreateContextFnOptions,
): Promise<TrpcContext> => {
  const resources = await getTrpcServerResources();
  const session = await getAuthSession(resources.auth, options.req);
  const cookieHeader = options.req.headers.get("cookie");

  return {
    auth: resources.auth,
    coreApi: resources.coreApi,
    db: resources.db,
    session,
    headers: options.req.headers,
    cookies: parseCookies(cookieHeader),
    responseHeaders: options.resHeaders,
    request: options.req,
  };
};
