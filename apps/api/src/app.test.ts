import type {
  RunDetailBundle,
  RunReportingRepository,
  SandboxAttemptRepository,
  SandboxRuntimeInstance,
  SandboxRuntimeInstanceRepository,
  WorkspaceBuildJob,
  WorkspaceBuildJobRepository,
} from "@sealant/db";
import type { RegistryClient } from "@sealant/registry-integration";
import { normalizeUserWorkspaceSpec } from "@sealant/workspace-composition";
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

type SandboxAttemptRecord = Awaited<ReturnType<SandboxAttemptRepository["createQueuedAttempt"]>>;
type SandboxAttemptSnapshotRecord = Awaited<
  ReturnType<SandboxAttemptRepository["setAttemptSnapshot"]>
>;

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

const createRunReportingRepositoryStub = (
  options: {
    bundles?: ReadonlyMap<string, RunDetailBundle>;
  } = {},
): RunReportingRepository => {
  const bundles = new Map(options.bundles ?? []);
  const fail = async (): Promise<never> => {
    throw new Error("Not implemented in test stub.");
  };

  return {
    appendRunEvents: async () => fail(),
    replaceRunValidationResults: async () => fail(),
    replaceRunDiffFiles: async () => fail(),
    insertRunArtifacts: async () => fail(),
    upsertRunSummary: async () => fail(),
    getRunDetailBundle: async (runId) => bundles.get(runId) ?? null,
  } satisfies RunReportingRepository;
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

describe("createApiApp", () => {
  it("serves the system health endpoint", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: createWorkspaceBuildJobRepositoryStub(),
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
      runReportingRepository: createRunReportingRepositoryStub(),
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
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
      runReportingRepository: createRunReportingRepositoryStub(),
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
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
      runReportingRepository: createRunReportingRepositoryStub(),
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
    expect(body.paths["/v1/runs/{runId}"]).toBeDefined();
  });

  it("creates and queues a workspace build job", async () => {
    const repository = createWorkspaceBuildJobRepositoryStub();
    const publisher = createWorkspaceBuildJobPublisherStub();
    const runs = createSandboxAttemptRepositoryStub();
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: publisher,
      workspaceBuildJobRepository: repository,
      sandboxAttemptRepository: runs,
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
      runReportingRepository: createRunReportingRepositoryStub(),
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
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub({
        knownUserIds: [testUserId],
      }),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
      runReportingRepository: createRunReportingRepositoryStub(),
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
      sandboxAttemptRepository: createSandboxAttemptRepositoryStub(),
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
      runReportingRepository: createRunReportingRepositoryStub(),
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

  it("creates sandboxes via the UI-facing sandbox route", async () => {
    const repository = createWorkspaceBuildJobRepositoryStub();
    const runs = createSandboxAttemptRepositoryStub();
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: repository,
      sandboxAttemptRepository: runs,
      sandboxRuntimeInstanceRepository: createSandboxRuntimeInstanceRepositoryStub(),
      runReportingRepository: createRunReportingRepositoryStub(),
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
      runId: string;
      jobId: string;
      status: string;
    };

    expect(body.sandboxId).toBe(body.runId);
    expect(body.status).toBe("queued");
    expect(response.headers.get("location")).toBe(`/v1/sandboxes/${body.runId}`);

    const savedJob = await repository.getJobById(body.jobId);
    expect(savedJob?.runId).toBe(body.runId);
  });

  it("lists and fetches consolidated sandbox lifecycle details", async () => {
    const repository = createWorkspaceBuildJobRepositoryStub();
    const runs = createSandboxAttemptRepositoryStub();
    const now = new Date();
    const run = await runs.createQueuedAttempt({
      id: "run_ready",
      ownerUserId: testUserId,
      triggerType: "api",
      requestedByUserId: testUserId,
      queuedAt: now,
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
      sandboxAttemptRepository: runs,
      sandboxRuntimeInstanceRepository: runtimeInstances,
      runReportingRepository: createRunReportingRepositoryStub(),
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
    expect(listBody.items[0]?.sandboxId).toBe("run_ready");
    expect(listBody.items[0]?.status).toBe("ready");
    expect(listBody.items[0]?.runtime?.endpoint).toBe("ssh://root@127.0.0.1:40222");

    const detailResponse = await app.request("/v1/sandboxes/run_ready");
    expect(detailResponse.status).toBe(200);

    const detailBody = (await detailResponse.json()) as {
      sandboxId: string;
      runStatus: string;
      jobStatus?: string;
      status: string;
    };

    expect(detailBody.sandboxId).toBe("run_ready");
    expect(detailBody.runStatus).toBe("succeeded");
    expect(detailBody.jobStatus).toBe("succeeded");
    expect(detailBody.status).toBe("ready");
  });

  it("returns run detail bundles for run UI surfaces", async () => {
    const repository = createWorkspaceBuildJobRepositoryStub();
    const runs = createSandboxAttemptRepositoryStub();
    const run = await runs.createQueuedAttempt({
      id: "run_detail",
      ownerUserId: testUserId,
      triggerType: "api",
      requestedByUserId: testUserId,
    });

    await runs.setAttemptSnapshot({
      runId: run.id,
      userSpecPayload: {
        source: "https://github.com/example/repo",
        harness: "opencode",
        os: "nix",
      },
      resolvedSpecPayload: {
        source: "https://github.com/example/repo",
        harness: "opencode",
        os: "nix",
      },
      blueprintPayload: normalizeUserWorkspaceSpec({
        source: "https://github.com/example/repo",
        harness: "opencode",
        os: "nix",
      }),
    });

    await runs.markAttemptRunning({ id: run.id });
    await runs.markAttemptSucceeded({ id: run.id });

    const storedRun = await runs.getAttemptById(run.id);
    if (storedRun === undefined) {
      throw new Error("Expected run to exist in test setup.");
    }

    const detailBundle: RunDetailBundle = {
      run: storedRun,
      inputSnapshot: {
        runId: run.id,
        userSpecPayload: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "nix",
        },
        resolvedSpecPayload: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "nix",
        },
        blueprintPayload: normalizeUserWorkspaceSpec({
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "nix",
        }),
        profileConfigSnapshot: null,
        repositoryProfileConfigSnapshot: null,
        createdAt: new Date(),
      },
      summary: {
        runId: run.id,
        objective: "Stabilize mobile header behavior",
        linkedIssueRef: "#492",
        filesChanged: 3,
        additions: 42,
        deletions: 12,
        assumptions: ["Assumed mobile breakpoint at 390px"],
        warnings: ["Large diff in layout.css"],
        summaryMarkdown: "Updated responsive header behavior and validation coverage.",
        generatedAt: new Date(),
        updatedAt: new Date(),
      },
      events: [
        {
          id: "evt_1",
          runId: run.id,
          sequence: 1,
          phase: "bootstrap",
          level: "info",
          eventType: "setup",
          message: "Environment provisioned",
          payload: null,
          occurredAt: new Date(),
        },
      ],
      validationResults: [
        {
          id: "val_1",
          runId: run.id,
          checkKey: "lint",
          status: "pass",
          durationMs: 1_200,
          message: "All checks passed",
          details: null,
          createdAt: new Date(),
        },
      ],
      diffFiles: [
        {
          id: "diff_1",
          runId: run.id,
          changeType: "modified",
          path: "src/components/layout/Header.tsx",
          oldPath: null,
          additions: 42,
          deletions: 12,
          isBinary: false,
          patchArtifactId: null,
          createdAt: new Date(),
        },
      ],
      artifacts: [
        {
          id: "artifact_1",
          runId: run.id,
          kind: "summary",
          storageBackend: "inline",
          storageKey: null,
          contentType: "application/json",
          byteSize: 128,
          checksum: null,
          inlineJson: {
            ok: true,
          },
          createdAt: new Date(),
        },
      ],
    };

    const queuedJob = await repository.insertQueuedJob({
      id: "job_detail",
      runId: run.id,
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
            launchedAt: new Date(),
            finishedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      ]),
    });

    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
      workspaceBuildJobPublisher: createWorkspaceBuildJobPublisherStub(),
      workspaceBuildJobRepository: repository,
      sandboxAttemptRepository: runs,
      sandboxRuntimeInstanceRepository: runtimeInstances,
      runReportingRepository: createRunReportingRepositoryStub({
        bundles: new Map([[run.id, detailBundle]]),
      }),
    });

    const response = await app.request(`/v1/runs/${run.id}`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: {
        id: string;
      };
      sandbox: {
        status: string;
      };
      events: unknown[];
      validationResults: unknown[];
      diffFiles: unknown[];
      artifacts: unknown[];
    };

    expect(body.run.id).toBe(run.id);
    expect(body.sandbox.status).toBe("ready");
    expect(body.events).toHaveLength(1);
    expect(body.validationResults).toHaveLength(1);
    expect(body.diffFiles).toHaveLength(1);
    expect(body.artifacts).toHaveLength(1);
  });
});
