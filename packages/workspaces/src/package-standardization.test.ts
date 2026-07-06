import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import {
  createPackageStandardizer,
  packageResolutionSchema,
  PackageResolutionError,
  type PackageResolutionCacheStore,
  type PackageResolutionCacheValue,
  type RepologyClient,
} from "./package-standardization.js";

const fakeRepologyClient = (overrides: Partial<RepologyClient> = {}): RepologyClient => ({
  getProject: vi.fn(async () => []),
  searchProjects: vi.fn(async () => ({})),
  ...overrides,
});

const fakeCacheStore = (
  overrides: Partial<PackageResolutionCacheStore> = {},
): PackageResolutionCacheStore => ({
  getByQuery: vi.fn(() => Effect.succeed(null)),
  setByQuery: vi.fn(() => Effect.void),
  ...overrides,
});

const validResolution = (selectedProject: string) =>
  packageResolutionSchema.parse({
    requested: selectedProject,
    normalized: selectedProject,
    status: "resolved",
    source: "repology",
    selectedProject,
    osSupport: {
      arch: { supported: true, packageName: selectedProject },
      fedora: { supported: true, packageName: selectedProject },
      nix: { supported: true, packageName: selectedProject },
    },
    alternatives: [],
    fetchedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

describe("createPackageStandardizer.resolvePackage", () => {
  it.effect("returns an invalid resolution without touching repology or cache", () => {
    const repologyClient = fakeRepologyClient();
    const cacheStore = fakeCacheStore();
    const standardizer = createPackageStandardizer({ repologyClient, cacheStore });

    return Effect.gen(function* () {
      const resolution = yield* standardizer.resolvePackage({ query: "!!!", targetOs: "fedora" });

      expect(resolution.status).toBe("invalid");
      expect(repologyClient.getProject).not.toHaveBeenCalled();
      expect(cacheStore.getByQuery).not.toHaveBeenCalled();
    });
  });

  it.effect("serves a fresh cache hit without calling repology", () => {
    const cached: PackageResolutionCacheValue = {
      query: "fedora:ripgrep",
      payload: validResolution("ripgrep"),
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    const repologyClient = fakeRepologyClient();
    const cacheStore = fakeCacheStore({ getByQuery: vi.fn(() => Effect.succeed(cached)) });
    const standardizer = createPackageStandardizer({ repologyClient, cacheStore });

    return Effect.gen(function* () {
      const resolution = yield* standardizer.resolvePackage({
        query: "ripgrep",
        targetOs: "fedora",
      });

      expect(resolution.source).toBe("cache");
      expect(resolution.selectedProject).toBe("ripgrep");
      expect(cacheStore.getByQuery).toHaveBeenCalledWith("fedora:ripgrep");
      expect(repologyClient.getProject).not.toHaveBeenCalled();
    });
  });

  it.effect("resolves a catalog entry and writes it to the cache", () => {
    const repologyClient = fakeRepologyClient();
    const cacheStore = fakeCacheStore();
    const standardizer = createPackageStandardizer({ repologyClient, cacheStore });

    return Effect.gen(function* () {
      const resolution = yield* standardizer.resolvePackage({ query: "git", targetOs: "fedora" });

      expect(resolution.source).not.toBe("cache");
      expect(repologyClient.getProject).not.toHaveBeenCalled();
      expect(cacheStore.setByQuery).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("falls through to repology on a cache miss and caches the result", () => {
    const repologyClient = fakeRepologyClient({
      getProject: vi.fn(async () => [
        { repo: "some-repo", srcname: "libfoobar", version: "14.1.0", status: "newest" },
      ]),
    });
    const cacheStore = fakeCacheStore();
    const standardizer = createPackageStandardizer({ repologyClient, cacheStore });

    return Effect.gen(function* () {
      const resolution = yield* standardizer.resolvePackage({
        query: "libfoobar",
        targetOs: "fedora",
      });

      expect(resolution.source).toBe("repology");
      expect(repologyClient.getProject).toHaveBeenCalledTimes(1);
      expect(repologyClient.searchProjects).not.toHaveBeenCalled();
      expect(cacheStore.setByQuery).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("fails with PackageResolutionError when repology errors", () => {
    const repologyClient = fakeRepologyClient({
      getProject: vi.fn(async () => {
        throw new Error("repology unreachable");
      }),
    });
    const cacheStore = fakeCacheStore();
    const standardizer = createPackageStandardizer({ repologyClient, cacheStore });

    return Effect.gen(function* () {
      const error = yield* standardizer
        .resolvePackage({ query: "libfoobar", targetOs: "fedora" })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(PackageResolutionError);
      expect(error.message).toContain("repology unreachable");
    });
  });
});
