import type {
  WorkspaceBuildJob,
  WorkspaceBuildJobRepository,
  WorkspaceRunRepository,
} from "@sealant/db";
import type { RegistryClient } from "@sealant/registry-integration";
import { describe, expect, it } from "vitest";

import { createApiApp } from "./app.js";
import type { AppEnv } from "./env.js";
import type { WorkspaceBuildJobPublisher } from "./lib/types.js";

const testEnv: AppEnv = {
  DATABASE_BUSY_TIMEOUT_MS: 5000,
  DATABASE_FILE_PATH: ":memory:",
  NODE_ENV: "test",
  PORT: 3000,
  RABBITMQ_URL: "amqp://sealant:sealant@127.0.0.1:5673",
  REGISTRY_NAME: "default",
  REGISTRY_BASE_URL: "http://127.0.0.1:5000",
  REGISTRY_PUSH_REGISTRY: "127.0.0.1:5000",
  WORKSPACE_BUILD_QUEUE_PREFETCH: 1,
};

const testUserId = "user_test";

type WorkspaceRunRecord = Awaited<ReturnType<WorkspaceRunRepository["createQueuedRun"]>>;
type RunInputSnapshotRecord = Awaited<ReturnType<WorkspaceRunRepository["setRunInputSnapshot"]>>;

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

const createWorkspaceRunRepositoryStub = (
  options: {
    knownUserIds?: readonly string[];
  } = {},
): WorkspaceRunRepository => {
  const runs = new Map<string, WorkspaceRunRecord>();
  const snapshots = new Map<string, RunInputSnapshotRecord>();
  const knownUserIds = new Set(options.knownUserIds ?? [testUserId]);

  const touchUpdatedAt = (run: WorkspaceRunRecord): WorkspaceRunRecord => {
    return {
      ...run,
      updatedAt: new Date(),
    };
  };

  const finalizeRun = (
    run: WorkspaceRunRecord,
    status: WorkspaceRunRecord["status"],
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
    createQueuedRun: async (input) => {
      if (!knownUserIds.has(input.ownerUserId)) {
        throw new Error("FOREIGN KEY constraint failed");
      }

      if (input.requestedByUserId !== undefined && !knownUserIds.has(input.requestedByUserId)) {
        throw new Error("FOREIGN KEY constraint failed");
      }

      const now = input.queuedAt ?? new Date();
      const run: WorkspaceRunRecord = {
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
    getRunById: async (id) => runs.get(id),
    listRuns: async (input = {}) => {
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
    markRunCancelled: async (input) => {
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
    markRunFailed: async (input) => {
      const existing = runs.get(input.id);

      if (existing === undefined) {
        return null;
      }

      const next = finalizeRun(existing, "failed", input.finishedAt ?? new Date());
      runs.set(next.id, next);
      return next;
    },
    markRunRunning: async (input) => {
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
    markRunSucceeded: async (input) => {
      const existing = runs.get(input.id);

      if (existing === undefined) {
        return null;
      }

      const next = finalizeRun(existing, "succeeded", input.finishedAt ?? new Date());
      runs.set(next.id, next);
      return next;
    },
    setRunInputSnapshot: async (input) => {
      const existing = snapshots.get(input.runId);
      const snapshot: RunInputSnapshotRecord = {
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
  } satisfies WorkspaceRunRepository;
};

const createWorkspaceBuildJobPublisherStub = (): WorkspaceBuildJobPublisher => {
  return {
    publishRequested: async () => undefined,
  };
};

describe("createApiApp", () => {
  it("serves the system health endpoint", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      workspaceRunRepository: createWorkspaceRunRepositoryStub(),
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
      workspaceRunRepository: createWorkspaceRunRepositoryStub(),
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

  it("serves the generated OpenAPI document", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      workspaceRunRepository: createWorkspaceRunRepositoryStub(),
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
  });

  it("creates and queues a workspace build job", async () => {
    const repository = createWorkspaceBuildJobRepositoryStub();
    const publisher = createWorkspaceBuildJobPublisherStub();
    const runs = createWorkspaceRunRepositoryStub();
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: publisher,
      workspaceBuildJobRepository: repository,
      workspaceRunRepository: runs,
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
      workspaceRunRepository: createWorkspaceRunRepositoryStub({
        knownUserIds: [testUserId],
      }),
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
      workspaceRunRepository: createWorkspaceRunRepositoryStub(),
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
});
