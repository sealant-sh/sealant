import type { PackageResolutionCacheRepository } from "@sealant/db";
import {
  createPackageStandardizer,
  createRepologyClient,
  type PackageResolutionCacheStore,
  type PackageResolutionCacheValue,
  type PackageStandardizer,
} from "@sealant/sandboxes";
import { packageResolutionSchema } from "@sealant/validators";
import type { AppEnv } from "@sealant/validators/env";
import { Effect } from "effect";

/**
 * Adapts the Effect-native cache repository into the standardizer's cache port.
 *
 * The repository's effects are composed directly (no per-call `Effect.runPromise`): the store is
 * run once, inside the request fiber, by whoever runs the standardizer. Both methods are total —
 * the first read/write failure trips a circuit breaker that disables the cache for the lifetime of
 * this store so cache trouble degrades resolution gracefully instead of failing it.
 */
const createCacheStore = (
  repository: PackageResolutionCacheRepository,
): PackageResolutionCacheStore => {
  let cacheUnavailable = false;

  return {
    getByQuery: (query) =>
      Effect.suspend(() => {
        if (cacheUnavailable) {
          return Effect.succeed(null);
        }

        return repository.getByQuery(query).pipe(
          Effect.map((entry): PackageResolutionCacheValue | null => {
            if (entry === null) {
              return null;
            }

            const parsed = packageResolutionSchema.safeParse(entry.resolutionPayload);

            return {
              query,
              payload: parsed.success ? parsed.data : entry.resolutionPayload,
              expiresAt: entry.expiresAt,
            };
          }),
          Effect.catch((error) => {
            cacheUnavailable = true;
            const message = error instanceof Error ? error.message : "Unknown cache read error.";

            console.error("[packages.resolve] disabling package cache after read failure", {
              query,
              error: message,
              stack: error instanceof Error ? error.stack : undefined,
            });

            return Effect.succeed(null);
          }),
        );
      }),
    setByQuery: (input) =>
      Effect.suspend(() => {
        if (cacheUnavailable) {
          return Effect.void;
        }

        const parsed = packageResolutionSchema.safeParse(input.payload);

        if (!parsed.success) {
          // The payload should already be a valid resolution; skip caching rather than fail.
          return Effect.void;
        }

        return repository
          .upsertByQuery({
            query: input.query,
            resolutionPayload: parsed.data,
            expiresAt: input.expiresAt,
          })
          .pipe(
            Effect.asVoid,
            Effect.catch((error) => {
              cacheUnavailable = true;
              const message = error instanceof Error ? error.message : "Unknown cache write error.";

              console.error("[packages.resolve] disabling package cache after write failure", {
                query: input.query,
                error: message,
                stack: error instanceof Error ? error.stack : undefined,
              });

              return Effect.void;
            }),
          );
      }),
  };
};

export const createApiPackageStandardizer = (options: {
  env: AppEnv;
  cacheRepository: PackageResolutionCacheRepository;
}): PackageStandardizer => {
  const repologyClient = createRepologyClient({
    baseUrl: options.env.REPOLOGY_API_BASE_URL,
    userAgent: options.env.REPOLOGY_USER_AGENT,
    requestTimeoutMs: options.env.REPOLOGY_REQUEST_TIMEOUT_MS,
    minimumIntervalMs: options.env.REPOLOGY_MINIMUM_INTERVAL_MS,
  });

  return createPackageStandardizer({
    repologyClient,
    cacheStore: createCacheStore(options.cacheRepository),
  });
};

export const createPassthroughPackageStandardizer = (): PackageStandardizer => {
  return {
    resolvePackage: ({ query, targetOs: _targetOs }) =>
      Effect.sync(() => {
        const normalized = query.trim().toLowerCase();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 1000 * 60 * 5);

        return packageResolutionSchema.parse({
        requested: query,
        normalized,
        status: "resolved",
        source: "override",
        canonicalId: normalized,
        selectedProject: normalized,
        osSupport: {
          arch: {
            supported: true,
            packageName: normalized,
          },
          fedora: {
            supported: true,
            packageName: normalized,
          },
          nix: {
            supported: true,
            packageName: normalized,
          },
        },
        alternatives: [],
        fetchedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      }),
  };
};
