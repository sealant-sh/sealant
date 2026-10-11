import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import { knownWorkspacePackageIds, WORKSPACE_PACKAGE_CATALOG } from "./buildkit/package-catalog.js";
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
      ubuntu: { supported: true, packageName: selectedProject },
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
      query: "fedora:libfoobar",
      payload: validResolution("libfoobar"),
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    const repologyClient = fakeRepologyClient();
    const cacheStore = fakeCacheStore({ getByQuery: vi.fn(() => Effect.succeed(cached)) });
    const standardizer = createPackageStandardizer({ repologyClient, cacheStore });

    return Effect.gen(function* () {
      const resolution = yield* standardizer.resolvePackage({
        query: "libfoobar",
        targetOs: "fedora",
      });

      expect(resolution.source).toBe("cache");
      expect(resolution.selectedProject).toBe("libfoobar");
      expect(cacheStore.getByQuery).toHaveBeenCalledWith("fedora:libfoobar");
      expect(repologyClient.getProject).not.toHaveBeenCalled();
    });
  });

  it.effect("answers a catalog id from the catalog, never from a cached answer", () => {
    // Cached before the catalog knew the id: a Repology answer with no catalog id, which Mend
    // refuses to save. It must not stand for its 30 days.
    const cached: PackageResolutionCacheValue = {
      query: "arch:bun",
      payload: validResolution("bun"),
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    const repologyClient = fakeRepologyClient();
    const cacheStore = fakeCacheStore({ getByQuery: vi.fn(() => Effect.succeed(cached)) });
    const standardizer = createPackageStandardizer({ repologyClient, cacheStore });

    return Effect.gen(function* () {
      const resolution = yield* standardizer.resolvePackage({ query: "bun", targetOs: "arch" });

      expect(resolution).toMatchObject({ source: "override", canonicalId: "bun" });
      expect(cacheStore.getByQuery).not.toHaveBeenCalled();
      expect(cacheStore.setByQuery).not.toHaveBeenCalled();
      expect(repologyClient.getProject).not.toHaveBeenCalled();
    });
  });

  it.effect("treats Docker as a runtime-managed service, not an OS package", () => {
    const repologyClient = fakeRepologyClient();
    const standardizer = createPackageStandardizer({
      repologyClient,
      cacheStore: fakeCacheStore(),
    });

    return Effect.gen(function* () {
      const resolution = yield* standardizer.resolvePackage({ query: "docker", targetOs: "arch" });

      expect(resolution.status).toBe("unsupported");
      expect(resolution.source).toBe("override");
      expect(resolution.osSupport.arch.supported).toBe(false);
      expect(repologyClient.getProject).not.toHaveBeenCalled();
      expect(repologyClient.searchProjects).not.toHaveBeenCalled();
    });
  });

  it.effect("resolves Mend's standard Arch toolchain without a network lookup", () => {
    const repologyClient = fakeRepologyClient();
    const standardizer = createPackageStandardizer({
      repologyClient,
      cacheStore: fakeCacheStore(),
    });

    return Effect.gen(function* () {
      const requested = [
        "pnpm",
        "python",
        "uv",
        "mise",
        "github-cli",
        "lazygit",
        "bat",
        "curl",
        "jq",
        "ripgrep",
        "fd",
        "fzf",
      ];
      const resolved: string[] = [];
      for (const query of requested) {
        const resolution = yield* standardizer.resolvePackage({ query, targetOs: "arch" });
        const packageName = resolution.osSupport.arch.packageName;
        if (packageName !== undefined) resolved.push(packageName);
      }

      expect(resolved).toEqual(requested);
      expect(repologyClient.getProject).not.toHaveBeenCalled();
      expect(repologyClient.searchProjects).not.toHaveBeenCalled();
    });
  });

  it.effect("resolves Mend's standard Nix toolchain without a network lookup", () => {
    const repologyClient = fakeRepologyClient();
    const standardizer = createPackageStandardizer({
      repologyClient,
      cacheStore: fakeCacheStore(),
    });

    return Effect.gen(function* () {
      const requested = [
        "pnpm",
        "python",
        "uv",
        "mise",
        "github-cli",
        "lazygit",
        "bat",
        "curl",
        "jq",
        "ripgrep",
        "fd",
        "fzf",
      ];
      const resolved: string[] = [];
      for (const query of requested) {
        const resolution = yield* standardizer.resolvePackage({ query, targetOs: "nix" });
        const packageName = resolution.osSupport.nix.packageName;
        if (packageName !== undefined) resolved.push(packageName);
      }

      expect(resolved).toEqual([
        "pnpm",
        "python3",
        "uv",
        "mise",
        "gh",
        "lazygit",
        "bat",
        "curl",
        "jq",
        "ripgrep",
        "fd",
        "fzf",
      ]);
      expect(repologyClient.getProject).not.toHaveBeenCalled();
      expect(repologyClient.searchProjects).not.toHaveBeenCalled();
    });
  });

  it.effect(
    "resolves the Ubuntu toolchain from the catalog, whether the archive or a release serves it",
    () => {
      const repologyClient = fakeRepologyClient();
      const standardizer = createPackageStandardizer({
        repologyClient,
        cacheStore: fakeCacheStore(),
      });

      return Effect.gen(function* () {
        // The Ubuntu 24.04 archive carries these (with its own naming quirks)…
        const supported = [
          ["python", "python3"],
          ["github-cli", "gh"],
          ["bat", "bat"],
          ["curl", "curl"],
          ["jq", "jq"],
          ["ripgrep", "ripgrep"],
          ["fd", "fd-find"],
          ["fzf", "fzf"],
          ["neovim", "neovim"],
          ["tmux", "tmux"],
          ["zsh", "zsh"],
        ] as const;
        for (const [query, packageName] of supported) {
          const resolution = yield* standardizer.resolvePackage({ query, targetOs: "ubuntu" });
          expect(resolution.osSupport.ubuntu).toEqual(
            expect.objectContaining({ supported: true, packageName }),
          );
        }

        // …and lacks these, which the image installs another way: from npm, or the release.
        for (const [query, packageName] of [
          ["pnpm", "pnpm"],
          ["uv", "uv"],
          ["mise", "mise"],
          ["lazygit", "lazygit"],
        ] as const) {
          const resolution = yield* standardizer.resolvePackage({ query, targetOs: "ubuntu" });
          expect(resolution.osSupport.ubuntu).toEqual(
            expect.objectContaining({ supported: true, packageName }),
          );
        }

        expect(repologyClient.getProject).not.toHaveBeenCalled();
        expect(repologyClient.searchProjects).not.toHaveBeenCalled();
      });
    },
  );

  // Mend's `DEFAULT_WORKSPACE_PACKAGES` (packages/domain/src/settings.ts in Mend). On an arm64
  // server they were refused for Arch (bun, unzip, starship, the zsh plugins, direnv), and more
  // for Fedora and Ubuntu, so the Setup page could not save its own defaults.
  const MEND_DEFAULTS = [
    "pnpm",
    "bun",
    "python",
    "uv",
    "mise",
    "github-cli",
    "lazygit",
    "bat",
    "curl",
    "unzip",
    "jq",
    "ripgrep",
    "fd",
    "fzf",
    "starship",
    "zsh-autosuggestions",
    "zsh-syntax-highlighting",
    "zsh-history-substring-search",
    "direnv",
  ] as const;

  it.effect("resolves Mend's defaults for Arch on arm64: each one Arch Linux ARM installs", () => {
    const repologyClient = fakeRepologyClient();
    const standardizer = createPackageStandardizer({
      repologyClient,
      cacheStore: fakeCacheStore(),
    });

    return Effect.gen(function* () {
      for (const query of MEND_DEFAULTS) {
        const resolution = yield* standardizer.resolvePackage({ query, targetOs: "arch" });
        expect(resolution, query).toMatchObject({ status: "resolved", canonicalId: query });
        expect(resolution.osSupport.arch.supported, query).toBe(true);
        // On aarch64 the image installs it from Arch Linux ARM's repositories, or from a release
        // with an aarch64 archive (bun and mise: Arch Linux ARM packages neither).
        const install = WORKSPACE_PACKAGE_CATALOG[query]?.arch;
        expect(
          (install?.packages?.length ?? 0) > 0 || install?.release?.archives.aarch64 !== undefined,
          query,
        ).toBe(true);
      }
      expect(WORKSPACE_PACKAGE_CATALOG.bun?.arch.release?.archives.aarch64.url).toContain(
        "bun-linux-aarch64.zip",
      );
      expect(repologyClient.getProject).not.toHaveBeenCalled();
      expect(repologyClient.searchProjects).not.toHaveBeenCalled();
    });
  });

  it.effect(
    "resolves every catalog id as supported on every family the image installs it on",
    () => {
      const standardizer = createPackageStandardizer({
        repologyClient: fakeRepologyClient(),
        cacheStore: fakeCacheStore(),
      });

      return Effect.gen(function* () {
        for (const query of [...MEND_DEFAULTS, ...knownWorkspacePackageIds()]) {
          for (const targetOs of ["arch", "fedora", "nix", "ubuntu"] as const) {
            const resolution = yield* standardizer.resolvePackage({ query, targetOs });
            expect(resolution.canonicalId, `${query} on ${targetOs}`).not.toBeNull();
            expect(resolution.osSupport[targetOs].supported, `${query} on ${targetOs}`).toBe(true);
          }
        }
      });
    },
  );

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
