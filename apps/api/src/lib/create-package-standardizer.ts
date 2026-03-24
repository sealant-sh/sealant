import type { PackageResolutionCacheRepository } from "@sealant/db";
import {
  createPackageStandardizer,
  createRepologyClient,
  packageResolutionSchema,
  type PackageResolutionCacheStore,
  type PackageStandardizer,
} from "@sealant/package-standardization";

import type { AppEnv } from "../env.js";

const createCacheStore = (
  repository: PackageResolutionCacheRepository,
): PackageResolutionCacheStore => {
  let cacheUnavailable = false;

  return {
    getByQuery: async (query) => {
      if (cacheUnavailable) {
        return null;
      }

      let entry: Awaited<ReturnType<PackageResolutionCacheRepository["getByQuery"]>>;

      try {
        entry = await repository.getByQuery(query);
      } catch (error) {
        cacheUnavailable = true;
        const message = error instanceof Error ? error.message : "Unknown cache read error.";

        console.error("[packages.resolve] disabling package cache after read failure", {
          query,
          error: message,
          stack: error instanceof Error ? error.stack : undefined,
        });

        return null;
      }

      if (entry === null) {
        return null;
      }

      const parsed = packageResolutionSchema.safeParse(entry.resolutionPayload);

      return {
        query,
        payload: parsed.success ? parsed.data : entry.resolutionPayload,
        expiresAt: entry.expiresAt,
      };
    },
    setByQuery: async (input) => {
      if (cacheUnavailable) {
        return;
      }

      const parsed = packageResolutionSchema.parse(input.payload);

      try {
        await repository.upsertByQuery({
          query: input.query,
          resolutionPayload: parsed,
          expiresAt: input.expiresAt,
        });
      } catch (error) {
        cacheUnavailable = true;
        const message = error instanceof Error ? error.message : "Unknown cache write error.";

        console.error("[packages.resolve] disabling package cache after write failure", {
          query: input.query,
          error: message,
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    },
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
    resolvePackage: async ({ query, targetOs: _targetOs }) => {
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
    },
  };
};
