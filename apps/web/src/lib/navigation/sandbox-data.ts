export type RunStatus = "active" | "failed" | "completed";

export interface RunRecord {
  readonly id: string;
  readonly repoId: string;
  readonly profileId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly trigger: string;
}

export interface RepositoryRecord {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly branch: string;
  readonly health: string;
}

export interface ProfileRecord {
  readonly id: string;
  readonly name: string;
  readonly environment: string;
  readonly packageCount: number;
  readonly secretCount: number;
  readonly access: string;
}

export const RUNS: readonly RunRecord[] = [
  {
    id: "run-1042",
    repoId: "kitchen-api",
    profileId: "staging-smoke",
    status: "active",
    startedAt: "2m ago",
    trigger: "Issue queue",
  },
  {
    id: "run-1039",
    repoId: "floor-console",
    profileId: "pre-service-brief",
    status: "failed",
    startedAt: "34m ago",
    trigger: "Manual launch",
  },
  {
    id: "run-1037",
    repoId: "inventory-sync",
    profileId: "nightly-refresh",
    status: "completed",
    startedAt: "1h ago",
    trigger: "Scheduled",
  },
  {
    id: "run-1033",
    repoId: "kitchen-api",
    profileId: "nightly-refresh",
    status: "completed",
    startedAt: "3h ago",
    trigger: "Scheduled",
  },
];

export const REPOSITORIES: readonly RepositoryRecord[] = [
  {
    id: "kitchen-api",
    name: "operations/kitchen-api",
    owner: "Kitchen Platform",
    branch: "main",
    health: "Stable",
  },
  {
    id: "floor-console",
    name: "operations/floor-console",
    owner: "Floor Systems",
    branch: "release",
    health: "Watch",
  },
  {
    id: "inventory-sync",
    name: "operations/inventory-sync",
    owner: "Supply Ops",
    branch: "main",
    health: "Stable",
  },
];

export const PROFILES: readonly ProfileRecord[] = [
  {
    id: "staging-smoke",
    name: "Staging Smoke",
    environment: "Staging",
    packageCount: 18,
    secretCount: 6,
    access: "Bastion",
  },
  {
    id: "pre-service-brief",
    name: "Pre Service Brief",
    environment: "Preview",
    packageCount: 12,
    secretCount: 4,
    access: "Readonly SSH",
  },
  {
    id: "nightly-refresh",
    name: "Nightly Refresh",
    environment: "Staging",
    packageCount: 21,
    secretCount: 9,
    access: "Bastion",
  },
];

export function getRunById(runId: string): RunRecord | null {
  return RUNS.find((run) => run.id === runId) ?? null;
}

export function getRepositoryById(repoId: string): RepositoryRecord | null {
  return REPOSITORIES.find((repository) => repository.id === repoId) ?? null;
}

export function getProfileById(profileId: string): ProfileRecord | null {
  return PROFILES.find((profile) => profile.id === profileId) ?? null;
}
