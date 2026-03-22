import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

export const packageTargetOsSchema = z.enum(["arch", "fedora", "nix"]);

export const packageResolutionStatusSchema = z.enum([
  "resolved",
  "ambiguous",
  "unsupported",
  "not-found",
  "invalid",
]);

const packageResolutionSourceSchema = z.enum(["cache", "repology", "override"]);

export const packageOsSupportSchema = z.strictObject({
  supported: z.boolean(),
  repo: z.string().trim().min(1).optional(),
  packageName: z.string().trim().min(1).optional(),
  projectName: z.string().trim().min(1).optional(),
  version: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
});

export const packageResolutionAlternativeSchema = z.strictObject({
  projectName: z.string().trim().min(1),
});

export const packageResolutionSchema = z.strictObject({
  requested: z.string().trim().min(1),
  normalized: z.string().trim().min(1),
  status: packageResolutionStatusSchema,
  source: packageResolutionSourceSchema,
  canonicalId: z.string().trim().min(1).optional(),
  selectedProject: z.string().trim().min(1).optional(),
  osSupport: z.strictObject({
    arch: packageOsSupportSchema,
    fedora: packageOsSupportSchema,
    nix: packageOsSupportSchema,
  }),
  alternatives: z.array(packageResolutionAlternativeSchema).default([]),
  fetchedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type PackageTargetOs = z.infer<typeof packageTargetOsSchema>;
export type PackageResolutionStatus = z.infer<typeof packageResolutionStatusSchema>;
export type PackageResolution = z.infer<typeof packageResolutionSchema>;

type RepologyProjectResponseEntry = {
  readonly repo?: string;
  readonly subrepo?: string;
  readonly srcname?: string;
  readonly binname?: string;
  readonly visiblename?: string;
  readonly version?: string;
  readonly status?: string;
};

type RepologySearchResponse = Record<string, readonly RepologyProjectResponseEntry[]>;

const repologyRepoByTargetOs: Record<PackageTargetOs, string> = {
  arch: "arch",
  fedora: "fedora_41",
  nix: "nix_unstable",
};

const packageQueryPattern = /^[a-z0-9][a-z0-9._:+-]*$/;

type CatalogOsMapping = {
  readonly packageName: string;
};

type CatalogEntry = {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly targets: Partial<Record<PackageTargetOs, CatalogOsMapping>>;
};

const catalogEntries: readonly CatalogEntry[] = [
  {
    id: "bash",
    aliases: ["bash"],
    targets: {
      arch: { packageName: "bash" },
      fedora: { packageName: "bash" },
      nix: { packageName: "bash" },
    },
  },
  {
    id: "curl",
    aliases: ["curl"],
    targets: {
      arch: { packageName: "curl" },
      fedora: { packageName: "curl" },
      nix: { packageName: "curl" },
    },
  },
  {
    id: "fish",
    aliases: ["fish"],
    targets: {
      arch: { packageName: "fish" },
      fedora: { packageName: "fish" },
      nix: { packageName: "fish" },
    },
  },
  {
    id: "git",
    aliases: ["git"],
    targets: {
      arch: { packageName: "git" },
      fedora: { packageName: "git" },
      nix: { packageName: "git" },
    },
  },
  {
    id: "jq",
    aliases: ["jq"],
    targets: {
      arch: { packageName: "jq" },
      fedora: { packageName: "jq" },
      nix: { packageName: "jq" },
    },
  },
  {
    id: "neovim",
    aliases: ["neovim", "nvim"],
    targets: {
      arch: { packageName: "neovim" },
      fedora: { packageName: "neovim" },
      nix: { packageName: "neovim" },
    },
  },
  {
    id: "nodejs",
    aliases: ["node", "nodejs"],
    targets: {
      arch: { packageName: "nodejs" },
      fedora: { packageName: "nodejs" },
      nix: { packageName: "nodejs" },
    },
  },
  {
    id: "pnpm",
    aliases: ["pnpm"],
    targets: {
      arch: { packageName: "pnpm" },
      fedora: { packageName: "pnpm" },
      nix: { packageName: "pnpm" },
    },
  },
  {
    id: "ripgrep",
    aliases: ["ripgrep", "rg"],
    targets: {
      arch: { packageName: "ripgrep" },
      fedora: { packageName: "ripgrep" },
      nix: { packageName: "ripgrep" },
    },
  },
  {
    id: "tmux",
    aliases: ["tmux"],
    targets: {
      arch: { packageName: "tmux" },
      fedora: { packageName: "tmux" },
      nix: { packageName: "tmux" },
    },
  },
  {
    id: "zsh",
    aliases: ["zsh"],
    targets: {
      arch: { packageName: "zsh" },
      fedora: { packageName: "zsh" },
      nix: { packageName: "zsh" },
    },
  },
];

const catalogByAlias = (() => {
  const lookup = new Map<string, CatalogEntry>();

  for (const entry of catalogEntries) {
    for (const alias of entry.aliases) {
      lookup.set(alias, entry);
    }
  }

  return lookup;
})();

const normalizePackageQuery = (value: string): string => {
  return value.trim().toLowerCase();
};

const sourceNameFromEntry = (entry: RepologyProjectResponseEntry): string | undefined => {
  if (entry.visiblename !== undefined && entry.visiblename.length > 0) {
    return entry.visiblename;
  }

  if (entry.binname !== undefined && entry.binname.length > 0) {
    return entry.binname;
  }

  if (entry.srcname !== undefined && entry.srcname.length > 0) {
    const parts = entry.srcname.split("/");
    const tail = parts[parts.length - 1];
    return tail === undefined || tail.length === 0 ? entry.srcname : tail;
  }

  return undefined;
};

const scoreEntry = (entry: RepologyProjectResponseEntry, normalizedQuery: string): number => {
  const visible = entry.visiblename?.toLowerCase() ?? "";
  const binary = entry.binname?.toLowerCase() ?? "";
  const source = sourceNameFromEntry(entry)?.toLowerCase() ?? "";
  const status = entry.status?.toLowerCase() ?? "";

  let score = 0;

  if (visible === normalizedQuery) {
    score += 15;
  }

  if (binary === normalizedQuery) {
    score += 12;
  }

  if (source === normalizedQuery) {
    score += 10;
  }

  if (visible.includes(normalizedQuery)) {
    score += 3;
  }

  if (binary.includes(normalizedQuery)) {
    score += 2;
  }

  if (status === "newest" || status === "rolling") {
    score += 2;
  }

  if (entry.subrepo === "updates" || entry.subrepo === "extra") {
    score += 1;
  }

  return score;
};

const getBestRepoEntry = (
  entries: readonly RepologyProjectResponseEntry[],
  repo: string,
  normalizedQuery: string,
): RepologyProjectResponseEntry | undefined => {
  return entries
    .filter((entry) => entry.repo === repo)
    .sort(
      (left, right) => scoreEntry(right, normalizedQuery) - scoreEntry(left, normalizedQuery),
    )[0];
};

const emptyOsSupport = {
  arch: { supported: false },
  fedora: { supported: false },
  nix: { supported: false },
} as const;

const toNowIso = (value: Date): string => {
  return value.toISOString();
};

const buildCatalogResolution = (input: {
  requested: string;
  normalized: string;
  entry: CatalogEntry;
  now: Date;
}): PackageResolution => {
  const expiresAt = new Date(input.now.getTime() + 1000 * 60 * 60 * 24 * 30);

  return packageResolutionSchema.parse({
    requested: input.requested,
    normalized: input.normalized,
    status: "resolved",
    source: "override",
    canonicalId: input.entry.id,
    selectedProject: input.entry.id,
    osSupport: {
      arch:
        input.entry.targets.arch === undefined
          ? emptyOsSupport.arch
          : {
              supported: true,
              repo: repologyRepoByTargetOs.arch,
              packageName: input.entry.targets.arch.packageName,
              projectName: input.entry.id,
            },
      fedora:
        input.entry.targets.fedora === undefined
          ? emptyOsSupport.fedora
          : {
              supported: true,
              repo: repologyRepoByTargetOs.fedora,
              packageName: input.entry.targets.fedora.packageName,
              projectName: input.entry.id,
            },
      nix:
        input.entry.targets.nix === undefined
          ? emptyOsSupport.nix
          : {
              supported: true,
              repo: repologyRepoByTargetOs.nix,
              packageName: input.entry.targets.nix.packageName,
              projectName: input.entry.id,
            },
    },
    alternatives: [],
    fetchedAt: toNowIso(input.now),
    expiresAt: toNowIso(expiresAt),
  });
};

const buildRepologyResolution = (input: {
  requested: string;
  normalized: string;
  selectedProject: string;
  entries: readonly RepologyProjectResponseEntry[];
  source: "repology" | "override";
  alternatives?: readonly string[];
  now: Date;
}): PackageResolution => {
  const archEntry = getBestRepoEntry(input.entries, repologyRepoByTargetOs.arch, input.normalized);
  const fedoraEntry = getBestRepoEntry(
    input.entries,
    repologyRepoByTargetOs.fedora,
    input.normalized,
  );
  const nixEntry = getBestRepoEntry(input.entries, repologyRepoByTargetOs.nix, input.normalized);

  const osSupport = {
    arch:
      archEntry === undefined
        ? emptyOsSupport.arch
        : {
            supported: true,
            repo: repologyRepoByTargetOs.arch,
            packageName: sourceNameFromEntry(archEntry),
            projectName: input.selectedProject,
            version: archEntry.version,
            status: archEntry.status,
          },
    fedora:
      fedoraEntry === undefined
        ? emptyOsSupport.fedora
        : {
            supported: true,
            repo: repologyRepoByTargetOs.fedora,
            packageName: sourceNameFromEntry(fedoraEntry),
            projectName: input.selectedProject,
            version: fedoraEntry.version,
            status: fedoraEntry.status,
          },
    nix:
      nixEntry === undefined
        ? emptyOsSupport.nix
        : {
            supported: true,
            repo: repologyRepoByTargetOs.nix,
            packageName: sourceNameFromEntry(nixEntry),
            projectName: input.selectedProject,
            version: nixEntry.version,
            status: nixEntry.status,
          },
  };

  const supportedCount = Object.values(osSupport).filter((item) => item.supported).length;

  const status: PackageResolutionStatus =
    supportedCount > 0
      ? "resolved"
      : input.entries.length > 0
        ? "unsupported"
        : (input.alternatives?.length ?? 0) > 0
          ? "ambiguous"
          : "not-found";

  const isResolvedAcrossAllTargets = Object.values(osSupport).every((item) => item.supported);

  const defaultTtlMs = 1000 * 60 * 60 * 24 * 7;
  const shortTtlMs = 1000 * 60 * 60 * 24;
  const expiresAt = new Date(
    input.now.getTime() +
      (status === "resolved" || isResolvedAcrossAllTargets ? defaultTtlMs : shortTtlMs),
  );

  return packageResolutionSchema.parse({
    requested: input.requested,
    normalized: input.normalized,
    status,
    source: input.source,
    selectedProject: input.selectedProject,
    osSupport,
    alternatives: (input.alternatives ?? []).map((projectName) => ({ projectName })),
    fetchedAt: toNowIso(input.now),
    expiresAt: toNowIso(expiresAt),
  });
};

const bestProjectFromSearch = (
  searchResult: RepologySearchResponse,
  normalizedQuery: string,
): {
  projectName: string;
  entries: readonly RepologyProjectResponseEntry[];
  alternatives: string[];
} | null => {
  const candidates = Object.entries(searchResult)
    .map(([projectName, entries]) => {
      const lower = projectName.toLowerCase();
      const targetHits = [
        getBestRepoEntry(entries, repologyRepoByTargetOs.arch, normalizedQuery),
        getBestRepoEntry(entries, repologyRepoByTargetOs.fedora, normalizedQuery),
        getBestRepoEntry(entries, repologyRepoByTargetOs.nix, normalizedQuery),
      ].filter((entry) => entry !== undefined).length;

      const exact = lower === normalizedQuery ? 10 : 0;

      return {
        projectName,
        entries,
        score: exact + targetHits * 3,
      };
    })
    .sort((left, right) => right.score - left.score);

  if (candidates.length === 0) {
    return null;
  }

  const first = candidates[0];
  const second = candidates[1];

  if (first === undefined) {
    return null;
  }

  if (second !== undefined && first.score - second.score <= 1 && first.score < 10) {
    return {
      projectName: first.projectName,
      entries: first.entries,
      alternatives: candidates.slice(0, 5).map((item) => item.projectName),
    };
  }

  return {
    projectName: first.projectName,
    entries: first.entries,
    alternatives: candidates.slice(1, 6).map((item) => item.projectName),
  };
};

export interface PackageResolutionCacheValue {
  readonly query: string;
  readonly payload: unknown;
  readonly expiresAt: Date;
}

export interface PackageResolutionCacheStore {
  getByQuery(query: string): Promise<PackageResolutionCacheValue | null>;
  setByQuery(input: PackageResolutionCacheValue): Promise<void>;
}

export interface RepologyClient {
  getProject(projectName: string): Promise<readonly RepologyProjectResponseEntry[]>;
  searchProjects(query: string): Promise<RepologySearchResponse>;
}

export interface RepologyClientOptions {
  readonly baseUrl?: string;
  readonly userAgent: string;
  readonly requestTimeoutMs?: number;
  readonly minimumIntervalMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

export const createRepologyClient = (options: RepologyClientOptions): RepologyClient => {
  const baseUrl = options.baseUrl ?? "https://repology.org/api/v1";
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const minimumIntervalMs = options.minimumIntervalMs ?? 1_000;

  let gate = Promise.resolve();
  let lastRequestAt = 0;

  const paceRequests = async (): Promise<void> => {
    const previous = gate;
    let release: (() => void) | undefined;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    const now = Date.now();
    const elapsed = now - lastRequestAt;
    const remaining = minimumIntervalMs - elapsed;

    if (remaining > 0) {
      await sleep(remaining);
    }

    lastRequestAt = Date.now();
    release?.();
  };

  const fetchJson = async <T>(path: string): Promise<T> => {
    await paceRequests();

    try {
      const response = await fetchImplementation(`${baseUrl}${path}`, {
        headers: {
          "user-agent": options.userAgent,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      if (!response.ok) {
        const responseBody = await response.text();
        const responsePreview = responseBody.trim().slice(0, 200);

        throw new Error(
          `Repology API request failed for ${path} with status ${response.status}. ${responsePreview}`,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Repology API request failed for ${path}. ${message}`);
    }
  };

  return {
    getProject: async (projectName) => {
      return fetchJson<readonly RepologyProjectResponseEntry[]>(
        `/project/${encodeURIComponent(projectName)}`,
      );
    },
    searchProjects: async (query) => {
      return fetchJson<RepologySearchResponse>(
        `/projects/?search=${encodeURIComponent(query)}&inrepo=${encodeURIComponent(repologyRepoByTargetOs.arch)}`,
      );
    },
  };
};

export interface PackageStandardizer {
  resolvePackage(input: { query: string }): Promise<PackageResolution>;
}

export interface CreatePackageStandardizerOptions {
  readonly repologyClient: RepologyClient;
  readonly cacheStore?: PackageResolutionCacheStore;
}

const invalidResolution = (requested: string, normalized: string, now: Date): PackageResolution => {
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60);

  return packageResolutionSchema.parse({
    requested,
    normalized,
    status: "invalid",
    source: "override",
    osSupport: emptyOsSupport,
    alternatives: [],
    fetchedAt: toNowIso(now),
    expiresAt: toNowIso(expiresAt),
  });
};

const parseCachedResolution = (payload: unknown): PackageResolution | null => {
  const parsed = packageResolutionSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
};

export const createPackageStandardizer = (
  options: CreatePackageStandardizerOptions,
): PackageStandardizer => {
  return {
    resolvePackage: async ({ query }) => {
      const requested = query.trim();
      const normalized = normalizePackageQuery(requested);
      const now = new Date();

      if (normalized.length === 0 || !packageQueryPattern.test(normalized)) {
        return invalidResolution(requested.length > 0 ? requested : query, normalized, now);
      }

      if (options.cacheStore !== undefined) {
        const cached = await options.cacheStore.getByQuery(normalized);

        if (cached !== null && cached.expiresAt.getTime() > now.getTime()) {
          const parsed = parseCachedResolution(cached.payload);

          if (parsed !== null) {
            return packageResolutionSchema.parse({
              ...parsed,
              source: "cache",
            });
          }
        }
      }

      const catalogEntry = catalogByAlias.get(normalized);

      if (catalogEntry !== undefined) {
        const resolution = buildCatalogResolution({
          requested,
          normalized,
          entry: catalogEntry,
          now,
        });

        if (options.cacheStore !== undefined) {
          await options.cacheStore.setByQuery({
            query: normalized,
            payload: resolution,
            expiresAt: new Date(resolution.expiresAt),
          });
        }

        return resolution;
      }

      const directProjectEntries = await options.repologyClient.getProject(normalized);

      let resolution: PackageResolution;

      if (directProjectEntries.length > 0) {
        resolution = buildRepologyResolution({
          requested,
          normalized,
          selectedProject: normalized,
          entries: directProjectEntries,
          source: "repology",
          now,
        });
      } else {
        const searchResult = await options.repologyClient.searchProjects(normalized);
        const bestProject = bestProjectFromSearch(searchResult, normalized);

        if (bestProject === null) {
          resolution = buildRepologyResolution({
            requested,
            normalized,
            selectedProject: normalized,
            entries: [],
            source: "repology",
            now,
          });
        } else {
          resolution = buildRepologyResolution({
            requested,
            normalized,
            selectedProject: bestProject.projectName,
            entries: bestProject.entries,
            alternatives: bestProject.alternatives,
            source: "repology",
            now,
          });
        }
      }

      if (options.cacheStore !== undefined) {
        await options.cacheStore.setByQuery({
          query: normalized,
          payload: resolution,
          expiresAt: new Date(resolution.expiresAt),
        });
      }

      return resolution;
    },
  };
};

export const parsePackageResolution = (input: unknown): PackageResolution => {
  return packageResolutionSchema.parse(input);
};
