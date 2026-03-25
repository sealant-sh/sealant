import type {
  GitHubAppInstallation,
  GitHubInstallationRepository,
  GitHubInstallationRepositoryCacheRepository,
  GitHubInstallationRepositoryRecord,
  GitHubInstallationUserGrant,
  RepositoryProfileRepository,
  SandboxAttemptRepository,
  SandboxRepository,
  SandboxRuntimeInstance,
  SandboxRuntimeInstanceRepository,
  WorkspaceBuildJob,
  WorkspaceBuildJobRepository,
} from "@sealant/db";
import {
  packageResolutionSchema,
  type PackageStandardizer,
  type PackageTargetOs,
} from "@sealant/package-standardization";
import type { RegistryClient } from "@sealant/registry-integration";
import type {
  GitHubRemoteInstallation,
  GitHubRemoteInstallationRepository,
  GitHubSourceIntegration,
} from "@sealant/source-integrations";
import { normalizeUserWorkspaceSpec } from "@sealant/workspace-composition";
import { describe, expect, it } from "vitest";

import { createApiApp } from "./app.js";
import type { AppEnv } from "./env.js";
import type { WorkspaceBuildJobPublisher } from "./lib/types.js";

const testEnv: AppEnv = {
  DATABASE_BUSY_TIMEOUT_MS: 5000,
  DATABASE_FILE_PATH: ":memory:",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001",
  NODE_ENV: "test",
  PORT: 3000,
  RABBITMQ_URL: "amqp://sealant:sealant@127.0.0.1:5673",
  REGISTRY_NAME: "default",
  REGISTRY_BASE_URL: "http://127.0.0.1:5000",
  REGISTRY_PUSH_REGISTRY: "127.0.0.1:5000",
  REPOLOGY_API_BASE_URL: "https://repology.org/api/v1",
  REPOLOGY_USER_AGENT: "sealant-tests/0.1 (+https://github.com/sealant-ops/sealant)",
  REPOLOGY_REQUEST_TIMEOUT_MS: 10_000,
  REPOLOGY_MINIMUM_INTERVAL_MS: 1_000,
  GITHUB_API_BASE_URL: "https://api.github.com",
  WORKSPACE_BUILD_QUEUE_PREFETCH: 1,
};

const testUserId = "user_test";

type SandboxAttemptRecord = Awaited<ReturnType<SandboxAttemptRepository["createQueuedAttempt"]>>;
type SandboxAttemptSnapshotRecord = Awaited<
  ReturnType<SandboxAttemptRepository["setAttemptSnapshot"]>
>;
type SandboxRecord = Awaited<ReturnType<SandboxRepository["createSandbox"]>>;
type RepositoryRecord = Awaited<ReturnType<RepositoryProfileRepository["upsertRepository"]>>;

const createRegistryClientStub = (): RegistryClient => {
  return {
    ping: async () => undefined,
    repositoryExists: async () => true,
    listTags: async () => ["latest", "opencode"],
    getManifest: async () => ({
      digest: "sha256:test",
      contentType: "application/vnd.oci.image.manifest.v1+json",
      body: {
        schemaVersion: 2,
      },
    }),
    headManifest: async () => "sha256:test",
    discoverExtensions: async () => [
      {
        name: "_zot",
        endpoints: ["/v2/_zot/ext/search"],
      },
    ],
    publishOciImage: async () => ({
      repository: "sealant/workspaces/demo",
      tag: "opencode",
      reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
      digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
      digest: "sha256:test",
    }),
  };
};

const createWorkspaceBuildJobRepositoryStub = (): WorkspaceBuildJobRepository => {
  const jobs = new Map<string, WorkspaceBuildJob>();

  const byCreatedAtDesc = (left: WorkspaceBuildJob, right: WorkspaceBuildJob) => {
    return right.createdAt.getTime() - left.createdAt.getTime();
  };

  const touchUpdatedAt = (job: WorkspaceBuildJob): WorkspaceBuildJob => {
    return {
      ...job,
      updatedAt: new Date(),
    };
  };

  return {
    claimJobById: async () => null,
    claimNextQueuedJob: async () => null,
    getJobById: async (id) => jobs.get(id),
    getJobByIdempotencyKey: async (idempotencyKey) => {
      return [...jobs.values()].find((job) => job.idempotencyKey === idempotencyKey);
    },
    getLatestJobByRunId: async (runId) => {
      return [...jobs.values()].filter((job) => job.runId === runId).sort(byCreatedAtDesc)[0];
    },
    insertQueuedJob: async (input) => {
      const now = new Date();
      const job: WorkspaceBuildJob = {
        id: input.id,
        runId: input.runId ?? null,
        status: "queued",
        registryId: input.registryId,
        repository: input.repository,
        tag: input.tag,
        requestPayload: input.requestPayload,
        idempotencyKey: input.idempotencyKey ?? null,
        attemptCount: 0,
        maxAttempts: input.maxAttempts ?? 3,
        availableAt: input.availableAt ?? now,
        claimedAt: null,
        leaseExpiresAt: null,
        workerId: null,
        startedAt: null,
        finishedAt: null,
        executorId: null,
        resultPayload: null,
        publishedReference: null,
        publishedDigestReference: null,
        publishedDigest: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };

      jobs.set(job.id, job);

      return job;
    },
    listJobsByStatus: async (status) => {
      return [...jobs.values()].filter((job) => job.status === status);
    },
    listLatestJobsByRunIds: async (runIds) => {
      const latestJobsByRunId = new Map<string, WorkspaceBuildJob>();

      for (const runId of runIds) {
        const latestJob = [...jobs.values()]
          .filter((job) => job.runId === runId)
          .sort(byCreatedAtDesc)[0];

        if (latestJob !== undefined) {
          latestJobsByRunId.set(runId, latestJob);
        }
      }

      return latestJobsByRunId;
    },
    markJobFailed: async (input) => {
      const existing = jobs.get(input.id);

      if (existing === undefined) {
        return null;
      }

      const next = touchUpdatedAt({
        ...existing,
        status: "failed",
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage,
        finishedAt: input.finishedAt ?? new Date(),
        leaseExpiresAt: null,
      });

      jobs.set(next.id, next);
      return next;
    },
    markJobRunning: async (input) => {
      const existing = jobs.get(input.id);

      if (existing === undefined) {
        return null;
      }

      const now = input.now ?? new Date();
      const next = touchUpdatedAt({
        ...existing,
        status: "running",
        workerId: input.workerId,
        claimedAt: now,
        startedAt: now,
        leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs),
      });

      jobs.set(next.id, next);
      return next;
    },
    markJobSucceeded: async (input) => {
      const existing = jobs.get(input.id);

      if (existing === undefined) {
        return null;
      }

      const next = touchUpdatedAt({
        ...existing,
        status: "succeeded",
        executorId: input.executorId,
        resultPayload: input.resultPayload ?? null,
        publishedReference: input.publishedReference,
        publishedDigestReference: input.publishedDigestReference,
        publishedDigest: input.publishedDigest,
        finishedAt: input.finishedAt ?? new Date(),
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
      });

      jobs.set(next.id, next);
      return next;
    },
  } satisfies WorkspaceBuildJobRepository;
};

const createSandboxRepositoryStub = (
  options: {
    knownUserIds?: readonly string[];
  } = {},
): SandboxRepository => {
  const sandboxes = new Map<string, SandboxRecord>();
  const links = new Map<string, { sandboxId: string; runId: string; linkedAt: Date }>();
  const knownUserIds = new Set(options.knownUserIds ?? [testUserId]);

  const touchUpdatedAt = (sandbox: SandboxRecord): SandboxRecord => {
    return {
      ...sandbox,
      updatedAt: new Date(),
    };
  };

  return {
    createSandbox: async (input) => {
      if (!knownUserIds.has(input.ownerUserId)) {
        throw new Error("FOREIGN KEY constraint failed");
      }

      if (input.requestedByUserId !== undefined && !knownUserIds.has(input.requestedByUserId)) {
        throw new Error("FOREIGN KEY constraint failed");
      }

      const now = new Date();
      const sandbox: SandboxRecord = {
        id: input.id,
        name: input.name,
        ownerUserId: input.ownerUserId,
        repositoryId: input.repositoryId ?? null,
        repositoryProfileRevisionId: input.repositoryProfileRevisionId ?? null,
        profileRevisionId: input.profileRevisionId ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
        status: input.status ?? "queued",
        latestRunId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };

      sandboxes.set(sandbox.id, sandbox);
      return sandbox;
    },
    getSandboxByAttemptId: async (attemptId) => {
      const link = links.get(attemptId);
      if (link === undefined) {
        return undefined;
      }

      return sandboxes.get(link.sandboxId);
    },
    getSandboxById: async (id) => sandboxes.get(id),
    linkSandboxAttempt: async (input) => {
      const sandbox = sandboxes.get(input.sandboxId);

      if (sandbox === undefined) {
        throw new Error(`Sandbox not found: ${input.sandboxId}`);
      }

      const linkedAt = input.linkedAt ?? new Date();
      links.set(input.attemptId, {
        sandboxId: input.sandboxId,
        runId: input.attemptId,
        linkedAt,
      });

      sandboxes.set(
        sandbox.id,
        touchUpdatedAt({
          ...sandbox,
          latestRunId: input.attemptId,
        }),
      );

      return {
        sandboxId: input.sandboxId,
        runId: input.attemptId,
        relation: input.relation ?? "launch",
        linkedAt,
      };
    },
    listSandboxAttemptLinks: async (sandboxId, limit = 100) => {
      return [...links.values()]
        .filter((link) => link.sandboxId === sandboxId)
        .sort((a, b) => b.linkedAt.getTime() - a.linkedAt.getTime())
        .slice(0, limit)
        .map((link) => {
          return {
            sandboxId: link.sandboxId,
            runId: link.runId,
            relation: "launch" as const,
            linkedAt: link.linkedAt,
          };
        });
    },
    listSandboxes: async (input = {}) => {
      return [...sandboxes.values()]
        .filter((sandbox) =>
          input.ownerUserId === undefined ? true : sandbox.ownerUserId === input.ownerUserId,
        )
        .filter((sandbox) =>
          input.repositoryId === undefined ? true : sandbox.repositoryId === input.repositoryId,
        )
        .filter((sandbox) =>
          input.statuses === undefined || input.statuses.length === 0
            ? true
            : input.statuses.includes(sandbox.status),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, input.limit ?? 100);
    },
    setSandboxStatus: async (input) => {
      const existing = sandboxes.get(input.id);

      if (existing === undefined) {
        return null;
      }

      const next = touchUpdatedAt({
        ...existing,
        status: input.status,
      });
      sandboxes.set(next.id, next);
      return next;
    },
    setSandboxName: async (input) => {
      const existing = sandboxes.get(input.id);

      if (existing === undefined) {
        return null;
      }

      const next = touchUpdatedAt({
        ...existing,
        name: input.name,
      });
      sandboxes.set(next.id, next);
      return next;
    },
  } satisfies SandboxRepository;
};

const createSandboxAttemptRepositoryStub = (
  options: {
    knownUserIds?: readonly string[];
  } = {},
): SandboxAttemptRepository => {
  const runs = new Map<string, SandboxAttemptRecord>();
  const snapshots = new Map<string, SandboxAttemptSnapshotRecord>();
  const knownUserIds = new Set(options.knownUserIds ?? [testUserId]);

  const touchUpdatedAt = (run: SandboxAttemptRecord): SandboxAttemptRecord => {
    return {
      ...run,
      updatedAt: new Date(),
    };
  };

  const finalizeRun = (
    run: SandboxAttemptRecord,
    status: SandboxAttemptRecord["status"],
    finishedAt: Date,
  ) => {
    const durationMs =
      run.startedAt === null ? null : Math.max(0, finishedAt.getTime() - run.startedAt.getTime());

    return touchUpdatedAt({
      ...run,
      status,
      finishedAt,
      durationMs,
    });
  };

  return {
    createQueuedAttempt: async (input) => {
      if (!knownUserIds.has(input.ownerUserId)) {
        throw new Error("FOREIGN KEY constraint failed");
      }

      if (input.requestedByUserId !== undefined && !knownUserIds.has(input.requestedByUserId)) {
        throw new Error("FOREIGN KEY constraint failed");
      }

      const now = input.queuedAt ?? new Date();
      const run: SandboxAttemptRecord = {
        id: input.id,
        ownerUserId: input.ownerUserId,
        repositoryId: input.repositoryId ?? null,
        repositoryProfileRevisionId: input.repositoryProfileRevisionId ?? null,
        profileRevisionId: input.profileRevisionId ?? null,
        issueId: input.issueId ?? null,
        status: "queued",
        triggerType: input.triggerType ?? "manual",
        triggerRef: input.triggerRef ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
        retryOfRunId: input.retryOfRunId ?? null,
        cancelReason: null,
        queuedAt: now,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        createdAt: now,
        updatedAt: now,
      };

      runs.set(run.id, run);
      return run;
    },
    getAttemptById: async (id) => runs.get(id),
    getAttemptSnapshotByRunId: async (runId) => snapshots.get(runId),
    listAttempts: async (input = {}) => {
      const allRuns = [...runs.values()]
        .filter((run) =>
          input.ownerUserId === undefined ? true : run.ownerUserId === input.ownerUserId,
        )
        .filter((run) =>
          input.repositoryId === undefined ? true : run.repositoryId === input.repositoryId,
        )
        .filter((run) => (input.issueId === undefined ? true : run.issueId === input.issueId))
        .filter((run) =>
          input.statuses === undefined || input.statuses.length === 0
            ? true
            : input.statuses.includes(run.status),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      return allRuns.slice(0, input.limit ?? 100);
    },
    markAttemptCancelled: async (input) => {
      const existing = runs.get(input.id);

      if (existing === undefined) {
        return null;
      }

      const next = finalizeRun(existing, "cancelled", input.finishedAt ?? new Date());
      const cancelled = {
        ...next,
        cancelReason: input.cancelReason,
      };

      runs.set(cancelled.id, cancelled);
      return cancelled;
    },
    markAttemptFailed: async (input) => {
      const existing = runs.get(input.id);

      if (existing === undefined) {
        return null;
      }

      const next = finalizeRun(existing, "failed", input.finishedAt ?? new Date());
      runs.set(next.id, next);
      return next;
    },
    markAttemptRunning: async (input) => {
      const existing = runs.get(input.id);

      if (existing === undefined) {
        return null;
      }

      const next = touchUpdatedAt({
        ...existing,
        status: "running",
        startedAt: input.startedAt ?? new Date(),
      });

      runs.set(next.id, next);
      return next;
    },
    markAttemptSucceeded: async (input) => {
      const existing = runs.get(input.id);

      if (existing === undefined) {
        return null;
      }

      const next = finalizeRun(existing, "succeeded", input.finishedAt ?? new Date());
      runs.set(next.id, next);
      return next;
    },
    setAttemptSnapshot: async (input) => {
      const existing = snapshots.get(input.runId);
      const snapshot: SandboxAttemptSnapshotRecord = {
        runId: input.runId,
        userSpecPayload: input.userSpecPayload,
        resolvedSpecPayload: input.resolvedSpecPayload,
        blueprintPayload: input.blueprintPayload,
        profileConfigSnapshot: input.profileConfigSnapshot ?? null,
        repositoryProfileConfigSnapshot: input.repositoryProfileConfigSnapshot ?? null,
        createdAt: existing?.createdAt ?? new Date(),
      };

      snapshots.set(input.runId, snapshot);
      return snapshot;
    },
  } satisfies SandboxAttemptRepository;
};

const createSandboxRuntimeInstanceRepositoryStub = (
  options: {
    byRunId?: ReadonlyMap<string, SandboxRuntimeInstance>;
  } = {},
): SandboxRuntimeInstanceRepository => {
  const byRunId = new Map(options.byRunId ?? []);

  return {
    getRuntimeInstanceByRunId: async (runId) => byRunId.get(runId),
    listRuntimeInstancesByRunIds: async (runIds) => {
      const result = new Map<string, SandboxRuntimeInstance>();

      for (const runId of runIds) {
        const row = byRunId.get(runId);
        if (row !== undefined) {
          result.set(runId, row);
        }
      }

      return result;
    },
    upsertRuntimeInstance: async (input) => {
      const now = new Date();
      const existing = byRunId.get(input.runId);
      const next: SandboxRuntimeInstance = {
        runId: input.runId,
        status: input.status,
        adapter: input.adapter ?? existing?.adapter ?? null,
        resourceId: input.resourceId ?? existing?.resourceId ?? null,
        reference: input.reference ?? existing?.reference ?? null,
        endpoint: input.endpoint ?? existing?.endpoint ?? null,
        errorCode: input.errorCode ?? existing?.errorCode ?? null,
        errorMessage: input.errorMessage ?? existing?.errorMessage ?? null,
        launchedAt: input.launchedAt ?? existing?.launchedAt ?? null,
        finishedAt: input.finishedAt ?? existing?.finishedAt ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      byRunId.set(input.runId, next);
      return next;
    },
  } satisfies SandboxRuntimeInstanceRepository;
};

const createWorkspaceBuildJobPublisherStub = (): WorkspaceBuildJobPublisher => {
  return {
    publishRequested: async () => undefined,
  };
};

const createGitHubSourceIntegrationStub = (
  options: {
    installations?: readonly GitHubRemoteInstallation[];
    repositoriesByInstallationExternalId?: Readonly<
      Record<string, readonly GitHubRemoteInstallationRepository[]>
    >;
    isConfigured?: boolean;
    isWebhookVerificationConfigured?: boolean;
  } = {},
): GitHubSourceIntegration => {
  const installationsByExternalId = new Map(
    (options.installations ?? []).map((installation) => [
      installation.externalInstallationId,
      installation,
    ]),
  );
  const stub = {
    isConfigured: () => options.isConfigured ?? true,
    isWebhookVerificationConfigured: () => options.isWebhookVerificationConfigured ?? true,
    createAppJwt: () => "test-jwt",
    verifyWebhookSignature: () => true,
    createInstallationAccessToken: async () => ({
      token: "token",
      expiresAt: new Date("2026-03-25T12:00:00.000Z"),
    }),
    getInstallation: async (externalInstallationId: string) => {
      const installation = installationsByExternalId.get(externalInstallationId);

      if (installation === undefined) {
        throw new Error("GitHub installation request failed with status 404.");
      }

      return installation;
    },
    listInstallationRepositories: async (externalInstallationId) => {
      return options.repositoriesByInstallationExternalId?.[externalInstallationId] ?? [];
    },
  };

  return stub as unknown as GitHubSourceIntegration;
};

const createRepositoryProfileRepositoryStub = (): RepositoryProfileRepository => {
  const repositories = new Map<string, RepositoryRecord>();

  const stub = {
    getRepositoryByProviderExternalId: async (input: {
      readonly provider: string;
      readonly externalId: string;
    }) => {
      return [...repositories.values()].find((repository) => {
        return repository.provider === input.provider && repository.externalId === input.externalId;
      });
    },
    upsertRepository: async (input: {
      readonly id: string;
      readonly provider?: string;
      readonly externalId?: string;
      readonly owner: string;
      readonly name: string;
      readonly defaultBranch?: string;
      readonly url?: string;
      readonly isArchived?: boolean;
      readonly lastSyncedAt?: Date;
    }) => {
      const existing = repositories.get(input.id);
      const now = new Date();
      const repository: RepositoryRecord = {
        id: input.id,
        provider: (input.provider ?? existing?.provider ?? "git") as RepositoryRecord["provider"],
        externalId: input.externalId ?? existing?.externalId ?? null,
        owner: input.owner,
        name: input.name,
        defaultBranch: input.defaultBranch ?? existing?.defaultBranch ?? "main",
        url: input.url ?? existing?.url ?? null,
        isArchived: input.isArchived ?? existing?.isArchived ?? false,
        lastSyncedAt: input.lastSyncedAt ?? existing?.lastSyncedAt ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      repositories.set(repository.id, repository);
      return repository;
    },
  };

  return stub as unknown as RepositoryProfileRepository;
};

const createGitHubInstallationRepositoryStub = (
  options: {
    installations?: readonly GitHubAppInstallation[];
    grants?: readonly GitHubInstallationUserGrant[];
  } = {},
): GitHubInstallationRepository => {
  const installations = new Map((options.installations ?? []).map((row) => [row.id, row]));
  const grants = new Map(
    (options.grants ?? []).map((row) => [`${row.installationId}:${row.userId}`, row]),
  );

  return {
    getInstallationByExternalId: async (externalInstallationId) => {
      return [...installations.values()].find(
        (row) => row.externalInstallationId === externalInstallationId,
      );
    },
    getInstallationById: async (id) => installations.get(id),
    grantInstallationToUser: async (input) => {
      const grant: GitHubInstallationUserGrant = {
        installationId: input.installationId,
        userId: input.userId,
        grantedByUserId: input.grantedByUserId ?? null,
        grantedAt: input.grantedAt ?? new Date(),
        revokedAt: null,
      };
      grants.set(`${grant.installationId}:${grant.userId}`, grant);
      return grant;
    },
    listActiveInstallations: async () => {
      return [...installations.values()].filter((row) => row.status === "active");
    },
    listInstallationGrants: async (installationId) => {
      return [...grants.values()].filter((row) => row.installationId === installationId);
    },
    listInstallationsForUser: async (input) => {
      return [...installations.values()].filter((installation) => {
        const grant = grants.get(`${installation.id}:${input.userId}`);
        return (
          grant !== undefined &&
          grant.revokedAt === null &&
          (input.status === undefined || installation.status === input.status)
        );
      });
    },
    revokeInstallationGrant: async (input) => {
      const key = `${input.installationId}:${input.userId}`;
      const existing = grants.get(key);
      if (existing === undefined) {
        return null;
      }
      const next = {
        ...existing,
        revokedAt: input.revokedAt ?? new Date(),
      };
      grants.set(key, next);
      return next;
    },
    setInstallationStatus: async (input) => {
      const existing = installations.get(input.installationId);
      if (existing === undefined) {
        return null;
      }
      const next = {
        ...existing,
        status: input.status,
        suspendedAt:
          input.suspendedAt === undefined ? existing.suspendedAt : (input.suspendedAt ?? null),
        lastSyncedAt: input.lastSyncedAt ?? existing.lastSyncedAt,
        updatedAt: new Date(),
      };
      installations.set(next.id, next);
      return next;
    },
    upsertInstallation: async (input) => {
      const existing =
        installations.get(input.id) ??
        [...installations.values()].find(
          (row) => row.externalInstallationId === input.externalInstallationId,
        );
      const now = new Date();
      const installation: GitHubAppInstallation = {
        id: existing?.id ?? input.id,
        provider: "github",
        externalInstallationId: input.externalInstallationId,
        externalAccountId: input.externalAccountId ?? existing?.externalAccountId ?? null,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        targetType: input.targetType ?? existing?.targetType ?? null,
        status: input.status ?? existing?.status ?? "active",
        permissions: input.permissions ?? existing?.permissions ?? {},
        repositorySelection: input.repositorySelection ?? existing?.repositorySelection ?? "all",
        installedAt: input.installedAt ?? existing?.installedAt ?? null,
        suspendedAt:
          input.suspendedAt === undefined
            ? (existing?.suspendedAt ?? null)
            : (input.suspendedAt ?? null),
        lastSyncedAt: input.lastSyncedAt ?? existing?.lastSyncedAt ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      installations.set(installation.id, installation);
      return installation;
    },
    userHasInstallationGrant: async (input) => {
      const grant = grants.get(`${input.installationId}:${input.userId}`);
      return grant !== undefined && grant.revokedAt === null;
    },
  } satisfies GitHubInstallationRepository;
};

const createGitHubInstallationRepositoryCacheStub = (
  options: {
    repositories?: readonly GitHubInstallationRepositoryRecord[];
  } = {},
): GitHubInstallationRepositoryCacheRepository => {
  const repositories = new Map((options.repositories ?? []).map((row) => [row.id, row]));

  return {
    getInstallationRepositoryByExternalRepoId: async (input) => {
      return [...repositories.values()].find(
        (row) =>
          row.installationId === input.installationId &&
          row.externalRepositoryId === input.externalRepositoryId,
      );
    },
    getInstallationRepositoryById: async (id) => repositories.get(id),
    getInstallationRepositoryByRepoId: async (input) => {
      return [...repositories.values()].find(
        (row) =>
          row.installationId === input.installationId && row.repositoryId === input.repositoryId,
      );
    },
    listRepositoriesForInstallation: async (input) => {
      return [...repositories.values()]
        .filter((row) => row.installationId === input.installationId)
        .filter((row) => (input.includeRemoved ? true : row.removedAt === null))
        .filter((row) => (input.search === undefined ? true : row.fullName.includes(input.search)))
        .sort((left, right) => left.fullName.localeCompare(right.fullName));
    },
    listRepositoriesForUser: async (input) => {
      return [...repositories.values()]
        .filter((row) =>
          input.installationId === undefined ? true : row.installationId === input.installationId,
        )
        .filter((row) => row.removedAt === null)
        .filter((row) => (input.search === undefined ? true : row.fullName.includes(input.search)))
        .sort((left, right) => left.fullName.localeCompare(right.fullName));
    },
    markInstallationRepositoriesRemoved: async (input) => {
      let updated = 0;
      for (const repository of repositories.values()) {
        if (
          repository.installationId === input.installationId &&
          !input.preservedExternalRepositoryIds.includes(repository.externalRepositoryId)
        ) {
          repositories.set(repository.id, {
            ...repository,
            removedAt: input.removedAt ?? new Date(),
            updatedAt: new Date(),
          });
          updated += 1;
        }
      }
      return updated;
    },
    upsertInstallationRepository: async (input) => {
      const existing = repositories.get(input.id);
      const now = new Date();
      const repository: GitHubInstallationRepositoryRecord = {
        id: input.id,
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        externalRepositoryId: input.externalRepositoryId,
        owner: input.owner,
        name: input.name,
        fullName: input.fullName ?? `${input.owner}/${input.name}`,
        defaultBranch: input.defaultBranch ?? "main",
        isPrivate: input.isPrivate ?? true,
        isArchived: input.isArchived ?? false,
        pushedAt: input.pushedAt ?? null,
        lastSyncedAt: input.lastSyncedAt ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        removedAt: input.removedAt ?? null,
      };
      repositories.set(repository.id, repository);
      return repository;
    },
  } satisfies GitHubInstallationRepositoryCacheRepository;
};

const createPackageStandardizerStub = (
  calls: Array<{ query: string; targetOs?: PackageTargetOs }>,
) => {
  return {
    resolvePackage: async ({ query, targetOs }) => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 1000 * 60 * 5);
      calls.push({ query, targetOs });

      return packageResolutionSchema.parse({
        requested: query,
        normalized: query,
        status: "resolved",
        source: "override",
        canonicalId: query,
        selectedProject: query,
        osSupport: {
          arch: {
            supported: true,
            packageName: query,
          },
          fedora: {
            supported: true,
            packageName: query,
          },
          nix: {
            supported: true,
            packageName: query,
          },
        },
        alternatives: [],
        fetchedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
    },
  } satisfies PackageStandardizer;
};

describe("createApiApp", () => {
  it("serves the system health endpoint", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
    });
  });

  it("serves registry-backed tag lookup", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request(
      "/v1/registries/default/tags?repository=sealant/workspaces/demo",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repository: "sealant/workspaces/demo",
      tags: ["latest", "opencode"],
    });
  });

  it("resolves package requests through the package route", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/v1/packages/resolve?query=ripgrep");

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      osSupport: {
        arch: { supported: boolean; packageName?: string };
      };
    };

    expect(body.status).toBe("resolved");
    expect(body.osSupport.arch.supported).toBe(true);
    expect(body.osSupport.arch.packageName).toBe("ripgrep");
  });

  it("defaults package resolution target OS to fedora", async () => {
    const calls: Array<{ query: string; targetOs?: PackageTargetOs }> = [];
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      packageStandardizer: createPackageStandardizerStub(calls),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/v1/packages/resolve?query=ripgrep");

    expect(response.status).toBe(200);
    expect(calls[0]).toEqual({
      query: "ripgrep",
      targetOs: "fedora",
    });
  });

  it("uses explicit package resolution target OS when provided", async () => {
    const calls: Array<{ query: string; targetOs?: PackageTargetOs }> = [];
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      packageStandardizer: createPackageStandardizerStub(calls),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/v1/packages/resolve?query=ripgrep&targetOs=arch");

    expect(response.status).toBe(200);
    expect(calls[0]).toEqual({
      query: "ripgrep",
      targetOs: "arch",
    });
  });

  it("sets cors headers for configured origins", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/healthz", {
      headers: {
        origin: "http://localhost:3000",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("does not set cors headers for unknown origins", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/healthz", {
      headers: {
        origin: "https://untrusted.example.com",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves the generated OpenAPI document without run routes", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/openapi.json");

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      paths: Record<string, unknown>;
      info: {
        title: string;
      };
    };

    expect(body.info.title).toBe("Sealant Control Plane API");
    expect(body.paths["/v1/registries/{registryId}/ping"]).toBeDefined();
    expect(body.paths["/healthz"]).toBeDefined();
    expect(body.paths["/v1/workspace-build-jobs"]).toBeDefined();
    expect(body.paths["/v1/sandboxes"]).toBeDefined();
    expect(body.paths["/v1/sandboxes/{sandboxId}"]).toBeDefined();
    expect(body.paths["/v1/sandboxes/{sandboxId}/name"]).toBeDefined();
    expect(body.paths["/v1/sandboxes/{sandboxId}/attempts"]).toBeDefined();
    expect(body.paths["/v1/sandboxes/{sandboxId}/events"]).toBeDefined();
    expect(body.paths["/v1/github/installations"]).toBeDefined();
    expect(body.paths["/v1/github/installations/import"]).toBeDefined();
    expect(body.paths["/v1/github/installations/{installationId}/repositories"]).toBeDefined();
    expect(body.paths["/v1/github/webhooks"]).toBeDefined();
    expect(body.paths["/v1/runs/{runId}"]).toBeUndefined();
  });

  it("lists granted GitHub installations", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      gitHubInstallationRepository: createGitHubInstallationRepositoryStub({
        installations: [
          {
            id: "gh_installation_1",
            provider: "github",
            externalInstallationId: "1001",
            externalAccountId: "2001",
            accountLogin: "sealant-ops",
            accountType: "organization",
            targetType: "organization",
            status: "active",
            permissions: { contents: "read", metadata: "read" },
            repositorySelection: "all",
            installedAt: new Date("2026-03-20T12:00:00.000Z"),
            suspendedAt: null,
            lastSyncedAt: new Date("2026-03-24T12:00:00.000Z"),
            createdAt: new Date("2026-03-20T12:00:00.000Z"),
            updatedAt: new Date("2026-03-24T12:00:00.000Z"),
          },
        ],
        grants: [
          {
            installationId: "gh_installation_1",
            userId: testUserId,
            grantedByUserId: testUserId,
            grantedAt: new Date("2026-03-20T12:05:00.000Z"),
            revokedAt: null,
          },
        ],
      }),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request(`/v1/github/installations?userId=${testUserId}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          installationId: "gh_installation_1",
          externalInstallationId: "1001",
          accountLogin: "sealant-ops",
          accountType: "organization",
          status: "active",
          repositorySelection: "all",
          lastSyncedAt: "2026-03-24T12:00:00.000Z",
        },
      ],
    });
  });

  it("imports a GitHub installation without a webhook and syncs repositories", async () => {
    const installationRepository = createGitHubInstallationRepositoryStub();
    const installationRepositoryCache = createGitHubInstallationRepositoryCacheStub();
    const repositoryProfileRepository = createRepositoryProfileRepositoryStub();
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      gitHubSourceIntegration: createGitHubSourceIntegrationStub({
        installations: [
          {
            externalInstallationId: "1001",
            externalAccountId: "2001",
            accountLogin: "sealant-ops",
            accountType: "organization",
            targetType: "organization",
            permissions: { contents: "read", metadata: "read" },
            repositorySelection: "all",
          },
        ],
        repositoriesByInstallationExternalId: {
          "1001": [
            {
              externalRepositoryId: "3001",
              owner: "sealant-ops",
              name: "core",
              fullName: "sealant-ops/core",
              defaultBranch: "main",
              isPrivate: true,
              isArchived: false,
              url: "https://github.com/sealant-ops/core.git",
            },
          ],
        },
      }),
      gitHubInstallationRepository: installationRepository,
      gitHubInstallationRepositoryCacheRepository: installationRepositoryCache,
      repositoryProfileRepository,
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/v1/github/installations/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: testUserId,
        externalInstallationId: "1001",
      }),
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      installation: {
        installationId: string;
        externalInstallationId: string;
        accountLogin: string;
        accountType: string;
        status: string;
        repositorySelection: string;
        lastSyncedAt?: string;
      };
      syncedRepositoryCount: number;
      syncedAt: string;
    };

    expect(body.installation.externalInstallationId).toBe("1001");
    expect(body.installation.accountLogin).toBe("sealant-ops");
    expect(body.installation.status).toBe("active");
    expect(body.syncedRepositoryCount).toBe(1);
    expect(body.syncedAt).toBeDefined();
    expect(body.installation.lastSyncedAt).toBeDefined();

    const listedInstallationsResponse = await app.request(
      `/v1/github/installations?userId=${testUserId}`,
    );
    expect(listedInstallationsResponse.status).toBe(200);
    await expect(listedInstallationsResponse.json()).resolves.toEqual({
      items: [
        {
          installationId: body.installation.installationId,
          externalInstallationId: "1001",
          accountLogin: "sealant-ops",
          accountType: "organization",
          status: "active",
          repositorySelection: "all",
          lastSyncedAt: body.installation.lastSyncedAt,
        },
      ],
    });

    const repositoriesResponse = await app.request(
      `/v1/github/installations/${body.installation.installationId}/repositories?userId=${testUserId}`,
    );
    expect(repositoriesResponse.status).toBe(200);
    await expect(repositoriesResponse.json()).resolves.toEqual({
      items: [
        {
          installationRepositoryId: expect.any(String),
          installationId: body.installation.installationId,
          repositoryId: expect.any(String),
          externalRepositoryId: "3001",
          owner: "sealant-ops",
          name: "core",
          fullName: "sealant-ops/core",
          defaultBranch: "main",
          isPrivate: true,
          isArchived: false,
          lastSyncedAt: expect.any(String),
        },
      ],
    });
  });

  it("rejects manual repository sync when the user does not have a grant", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      gitHubSourceIntegration: createGitHubSourceIntegrationStub({
        repositoriesByInstallationExternalId: {
          "1001": [],
        },
      }),
      gitHubInstallationRepository: createGitHubInstallationRepositoryStub({
        installations: [
          {
            id: "gh_installation_1",
            provider: "github",
            externalInstallationId: "1001",
            externalAccountId: "2001",
            accountLogin: "sealant-ops",
            accountType: "organization",
            targetType: "organization",
            status: "active",
            permissions: { contents: "read", metadata: "read" },
            repositorySelection: "all",
            installedAt: new Date("2026-03-20T12:00:00.000Z"),
            suspendedAt: null,
            lastSyncedAt: new Date("2026-03-24T12:00:00.000Z"),
            createdAt: new Date("2026-03-20T12:00:00.000Z"),
            updatedAt: new Date("2026-03-24T12:00:00.000Z"),
          },
        ],
      }),
      gitHubInstallationRepositoryCacheRepository: createGitHubInstallationRepositoryCacheStub(),
      repositoryProfileRepository: createRepositoryProfileRepositoryStub(),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request(
      `/v1/github/installations/gh_installation_1/sync?userId=${testUserId}`,
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      message: `User ${testUserId} does not have access to GitHub installation gh_installation_1.`,
    });
  });

  it("creates and queues a workspace build job", async () => {
    const repository = createWorkspaceBuildJobRepositoryStub();
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: repository,
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/v1/workspace-build-jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ownerUserId: testUserId,
        registryId: "default",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        spec: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "nix",
        },
      }),
    });

    expect(response.status).toBe(202);

    const body = (await response.json()) as {
      jobId: string;
      runId: string;
      status: string;
      repository: string;
    };

    expect(body.runId).toBeDefined();
    expect(body.status).toBe("queued");
    expect(body.repository).toBe("sealant/workspaces/demo");

    const savedJob = await repository.getJobById(body.jobId);
    expect(savedJob?.status).toBe("queued");
    expect(savedJob?.runId).toBe(body.runId);
  });

  it("returns 404 when owner user does not exist", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      sandboxRepository: createSandboxRepositoryStub({
        knownUserIds: [testUserId],
      }),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub({
        knownUserIds: [testUserId],
      }),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/v1/workspace-build-jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ownerUserId: "missing-user",
        registryId: "default",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        spec: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "nix",
        },
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      message: "Unknown owner user: missing-user",
    });
  });

  it("returns durable workspace build job details", async () => {
    const repository = createWorkspaceBuildJobRepositoryStub();
    const queuedJob = await repository.insertQueuedJob({
      id: "job_test",
      registryId: "default",
      repository: "sealant/workspaces/demo",
      tag: "opencode",
      requestPayload: {
        source: "https://github.com/example/repo",
        harness: "opencode",
        os: "nix",
      },
    });

    await repository.markJobSucceeded({
      id: queuedJob.id,
      executorId: "nix",
      resultPayload: {
        executor: {
          id: "nix",
          osFamily: "nix",
        },
        artifacts: [
          {
            kind: "oci-image",
            name: "demo",
            path: "/tmp/demo.tar",
            reference: "demo:opencode",
            loader: "docker-load",
          },
        ],
      },
      publishedReference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
      publishedDigestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
      publishedDigest: "sha256:test",
    });

    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: repository,
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/v1/workspace-build-jobs/job_test");

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      jobId: string;
      status: string;
      publishedImage?: {
        digest: string;
      };
      executorId?: string;
    };

    expect(body.jobId).toBe("job_test");
    expect(body.status).toBe("succeeded");
    expect(body.executorId).toBe("nix");
    expect(body.publishedImage?.digest).toBe("sha256:test");
  });

  it("creates sandboxes via the sandbox route", async () => {
    const repository = createWorkspaceBuildJobRepositoryStub();
    const sandboxRepository = createSandboxRepositoryStub();
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: repository,
      sandboxRepository,
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/v1/sandboxes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ownerUserId: testUserId,
        registryId: "default",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        spec: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "nix",
        },
      }),
    });

    expect(response.status).toBe(202);

    const body = (await response.json()) as {
      sandboxId: string;
      name: string;
      status: string;
    };

    expect(body.sandboxId).toBeDefined();
    expect(body.name).toContain("Demo");
    expect(body.status).toBe("queued");
    expect(response.headers.get("location")).toBe(`/v1/sandboxes/${body.sandboxId}`);

    const savedSandbox = await sandboxRepository.getSandboxById(body.sandboxId);
    expect(savedSandbox?.name).toBe(body.name);
    expect(savedSandbox?.latestRunId).toBeDefined();

    const savedJob = [...(await repository.listJobsByStatus("queued"))][0];
    expect(savedJob?.runId).toBe(savedSandbox?.latestRunId ?? null);
  });

  it("creates sandboxes from a granted GitHub installation repository", async () => {
    const repository = createWorkspaceBuildJobRepositoryStub();
    const sandboxRepository = createSandboxRepositoryStub();
    const attemptRepository = createSandboxAttemptRepositoryStub();
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: repository,
      gitHubInstallationRepository: createGitHubInstallationRepositoryStub({
        installations: [
          {
            id: "gh_installation_1",
            provider: "github",
            externalInstallationId: "1001",
            externalAccountId: "2001",
            accountLogin: "sealant-ops",
            accountType: "organization",
            targetType: "organization",
            status: "active",
            permissions: { contents: "read", metadata: "read" },
            repositorySelection: "all",
            installedAt: new Date("2026-03-20T12:00:00.000Z"),
            suspendedAt: null,
            lastSyncedAt: new Date("2026-03-24T12:00:00.000Z"),
            createdAt: new Date("2026-03-20T12:00:00.000Z"),
            updatedAt: new Date("2026-03-24T12:00:00.000Z"),
          },
        ],
        grants: [
          {
            installationId: "gh_installation_1",
            userId: testUserId,
            grantedByUserId: testUserId,
            grantedAt: new Date("2026-03-20T12:05:00.000Z"),
            revokedAt: null,
          },
        ],
      }),
      gitHubInstallationRepositoryCacheRepository: createGitHubInstallationRepositoryCacheStub({
        repositories: [
          {
            id: "gh_installation_repo_1",
            installationId: "gh_installation_1",
            repositoryId: "repo_core",
            externalRepositoryId: "3001",
            owner: "sealant-ops",
            name: "core",
            fullName: "sealant-ops/core",
            defaultBranch: "main",
            isPrivate: true,
            isArchived: false,
            pushedAt: null,
            lastSyncedAt: new Date("2026-03-24T12:00:00.000Z"),
            createdAt: new Date("2026-03-24T12:00:00.000Z"),
            updatedAt: new Date("2026-03-24T12:00:00.000Z"),
            removedAt: null,
          },
        ],
      }),
      sandboxRepository,
      sandboxAttemptRepository: attemptRepository,
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/v1/sandboxes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ownerUserId: testUserId,
        registryId: "default",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        sourceSelection: {
          provider: "github",
          installationId: "gh_installation_1",
          installationRepositoryId: "gh_installation_repo_1",
          ref: "main",
        },
        spec: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "nix",
        },
      }),
    });

    expect(response.status).toBe(202);

    const body = (await response.json()) as {
      sandboxId: string;
    };
    const savedSandbox = await sandboxRepository.getSandboxById(body.sandboxId);

    expect(savedSandbox?.repositoryId).toBe("repo_core");
    expect(savedSandbox?.latestRunId).toBeDefined();

    const savedAttempt = await attemptRepository.getAttemptById(savedSandbox?.latestRunId ?? "");
    expect(savedAttempt?.repositoryId).toBe("repo_core");

    const savedJob = [...(await repository.listJobsByStatus("queued"))][0];
    expect(savedJob?.requestPayload.source).toEqual({
      kind: "git",
      provider: "github",
      url: "https://github.com/sealant-ops/core.git",
      ref: "main",
      authRef: "github-installation-repository:gh_installation_repo_1",
    });
  });

  it("renames sandboxes via the sandbox route", async () => {
    const sandboxRepository = createSandboxRepositoryStub();
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      sandboxRepository,
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const sandbox = await sandboxRepository.createSandbox({
      id: "sandbox_rename",
      name: "Demo Opencode",
      ownerUserId: testUserId,
      requestedByUserId: testUserId,
      status: "queued",
    });

    const response = await app.request(`/v1/sandboxes/${sandbox.id}/name`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Checkout Incident Repro",
      }),
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      sandboxId: string;
      name: string;
      updatedAt: string;
    };

    expect(body.sandboxId).toBe(sandbox.id);
    expect(body.name).toBe("Checkout Incident Repro");
    expect(body.updatedAt).toBeDefined();

    const renamedSandbox = await sandboxRepository.getSandboxById(sandbox.id);
    expect(renamedSandbox?.name).toBe("Checkout Incident Repro");
  });

  it("replays idempotent sandbox create with the same sandbox id", async () => {
    const repository = createWorkspaceBuildJobRepositoryStub();
    const sandboxRepository = createSandboxRepositoryStub();
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: repository,
      sandboxRepository,
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const requestBody = JSON.stringify({
      ownerUserId: testUserId,
      registryId: "default",
      repository: "sealant/workspaces/demo",
      tag: "opencode",
      spec: {
        source: "https://github.com/example/repo",
        harness: "opencode",
        os: "nix",
      },
    });

    const firstResponse = await app.request("/v1/sandboxes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-1",
      },
      body: requestBody,
    });
    const secondResponse = await app.request("/v1/sandboxes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-1",
      },
      body: requestBody,
    });

    const firstBody = (await firstResponse.json()) as { sandboxId: string };
    const secondBody = (await secondResponse.json()) as { sandboxId: string };

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(firstBody.sandboxId).toBe(secondBody.sandboxId);
  });

  it("lists and fetches sandbox lifecycle details by sandbox id", async () => {
    const repository = createWorkspaceBuildJobRepositoryStub();
    const sandboxRepository = createSandboxRepositoryStub();
    const runs = createSandboxAttemptRepositoryStub();
    const now = new Date();
    const sandbox = await sandboxRepository.createSandbox({
      id: "sandbox_ready",
      name: "Demo Opencode",
      ownerUserId: testUserId,
      requestedByUserId: testUserId,
      status: "queued",
    });
    const run = await runs.createQueuedAttempt({
      id: "run_ready",
      ownerUserId: testUserId,
      triggerType: "api",
      requestedByUserId: testUserId,
      queuedAt: now,
    });
    const requestSpec = {
      source: "https://github.com/example/repo",
      harness: "opencode",
      os: "nix",
    } as const;

    await runs.setAttemptSnapshot({
      runId: run.id,
      userSpecPayload: requestSpec,
      resolvedSpecPayload: requestSpec,
      blueprintPayload: normalizeUserWorkspaceSpec(requestSpec),
    });

    await sandboxRepository.linkSandboxAttempt({
      sandboxId: sandbox.id,
      attemptId: run.id,
      relation: "launch",
    });

    await runs.markAttemptRunning({ id: run.id, startedAt: new Date(now.getTime() + 10_000) });
    await runs.markAttemptSucceeded({ id: run.id, finishedAt: new Date(now.getTime() + 30_000) });

    const queuedJob = await repository.insertQueuedJob({
      id: "job_ready",
      runId: run.id,
      registryId: "default",
      repository: "sealant/workspaces/demo",
      tag: "opencode",
      requestPayload: {
        ...requestSpec,
      },
    });

    await repository.markJobSucceeded({
      id: queuedJob.id,
      executorId: "nix",
      resultPayload: {
        executor: {
          id: "nix",
          osFamily: "nix",
        },
        artifacts: [
          {
            kind: "oci-image",
            name: "demo",
            path: "/tmp/demo.tar",
            reference: "demo:opencode",
            loader: "docker-load",
          },
        ],
      },
      publishedReference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
      publishedDigestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
      publishedDigest: "sha256:test",
    });

    const runtimeInstances = createSandboxRuntimeInstanceRepositoryStub({
      byRunId: new Map([
        [
          run.id,
          {
            runId: run.id,
            status: "running",
            adapter: "docker",
            resourceId: "container_123",
            reference: "sealant-demo",
            endpoint: "ssh://root@127.0.0.1:40222",
            errorCode: null,
            errorMessage: null,
            launchedAt: new Date(now.getTime() + 20_000),
            finishedAt: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      ]),
    });

    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: repository,
      sandboxRepository,
      sandboxAttemptRepository: runs,
      sandboxRuntimeInstanceRepository: runtimeInstances,
    });

    const listResponse = await app.request(`/v1/sandboxes?ownerUserId=${testUserId}&limit=10`);
    expect(listResponse.status).toBe(200);

    const listBody = (await listResponse.json()) as {
      items: Array<{
        sandboxId: string;
        status: string;
        runtime?: {
          endpoint?: string;
        };
      }>;
    };

    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]?.sandboxId).toBe("sandbox_ready");
    expect(listBody.items[0]?.status).toBe("ready");
    expect(listBody.items[0]?.runtime?.endpoint).toBe("ssh://root@127.0.0.1:40222");

    const detailResponse = await app.request("/v1/sandboxes/sandbox_ready");
    expect(detailResponse.status).toBe(200);

    const detailBody = (await detailResponse.json()) as {
      sandboxId: string;
      status: string;
      spec?: {
        harness: string;
      };
      blueprint?: {
        sources?: {
          workspace?: {
            url: string;
            ref: string;
          };
        };
      };
    };

    expect(detailBody.sandboxId).toBe("sandbox_ready");
    expect(detailBody.status).toBe("ready");
    expect(detailBody.spec?.harness).toBe("opencode");
    expect(detailBody.blueprint?.sources?.workspace?.url).toBe("https://github.com/example/repo");
    expect(detailBody.blueprint?.sources?.workspace?.ref).toBe("main");

    const attemptsResponse = await app.request("/v1/sandboxes/sandbox_ready/attempts?limit=10");
    expect(attemptsResponse.status).toBe(200);

    const attemptsBody = (await attemptsResponse.json()) as {
      items: Array<{
        attemptId: string;
        relation: string;
        status: string;
        spec?: {
          harness: string;
        };
      }>;
    };

    expect(attemptsBody.items).toHaveLength(1);
    expect(attemptsBody.items[0]?.attemptId).toBe("run_ready");
    expect(attemptsBody.items[0]?.relation).toBe("launch");
    expect(attemptsBody.items[0]?.status).toBe("ready");
    expect(attemptsBody.items[0]?.spec?.harness).toBe("opencode");

    const eventsResponse = await app.request("/v1/sandboxes/sandbox_ready/events?limit=20");
    expect(eventsResponse.status).toBe(200);

    const eventsBody = (await eventsResponse.json()) as {
      items: Array<{
        type: string;
      }>;
    };

    expect(eventsBody.items.length).toBeGreaterThan(0);
    expect(eventsBody.items.some((event) => event.type === "sandbox.created")).toBe(true);
    expect(eventsBody.items.some((event) => event.type === "attempt.queued")).toBe(true);
    expect(eventsBody.items.some((event) => event.type === "attempt.running")).toBe(true);
    expect(eventsBody.items.some((event) => event.type === "image.published")).toBe(true);
    expect(eventsBody.items.some((event) => event.type === "runtime.running")).toBe(true);
    expect(eventsBody.items.some((event) => event.type === "attempt.succeeded")).toBe(true);
  });

  it("returns 404 for attempts and events when sandbox does not exist", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const attemptsResponse = await app.request("/v1/sandboxes/sandbox_missing/attempts");
    expect(attemptsResponse.status).toBe(404);
    await expect(attemptsResponse.json()).resolves.toEqual({
      message: "Sandbox not found: sandbox_missing",
    });

    const eventsResponse = await app.request("/v1/sandboxes/sandbox_missing/events");
    expect(eventsResponse.status).toBe(404);
    await expect(eventsResponse.json()).resolves.toEqual({
      message: "Sandbox not found: sandbox_missing",
    });
  });

  it("does not expose run detail routes", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      sandboxRepository: createSandboxRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
    });

    const response = await app.request("/v1/runs/run_test");
    expect(response.status).toBe(404);
  });
});
