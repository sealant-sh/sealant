import type { DatabaseClient } from "@sealant/db";
import type { RegistryClient } from "@sealant/registry-integration";
import type { RuntimeAdapter } from "@sealant/runtime-adapters-api";
import type { GitHubSourceIntegration } from "@sealant/source-integrations";
import type { OsExecutor } from "@sealant/workspace-composition";
import { describe, expect, it, vi } from "vitest";

import { processWorkspaceBuildJob } from "./process-workspace-build-job.js";

vi.mock("@sealant/db", () => {
  return {
    createGitHubInstallationRepository: vi.fn(),
    createGitHubInstallationRepositoryCacheRepository: vi.fn(),
    createSandboxAttemptRepository: vi.fn(),
    createSandboxRuntimeInstanceRepository: vi.fn(),
    createWorkspaceBuildJobRepository: vi.fn(),
    workspaceBuildJobRequestPayloadSchema: {
      parse: vi.fn((input: unknown) => input),
    },
  };
});

const {
  createGitHubInstallationRepository,
  createGitHubInstallationRepositoryCacheRepository,
  createSandboxAttemptRepository,
  createSandboxRuntimeInstanceRepository,
  createWorkspaceBuildJobRepository,
} = await import("@sealant/db");

const createSandboxAttemptRepositoryStub = () => {
  return {
    markAttemptRunning: vi.fn(async () => null),
    markAttemptSucceeded: vi.fn(async () => null),
    markAttemptFailed: vi.fn(async () => null),
  };
};

const createSandboxRuntimeInstanceRepositoryStub = () => {
  return {
    upsertRuntimeInstance: vi.fn(async () => null),
  };
};

const createGitHubInstallationRepositoryStub = () => {
  return {
    getInstallationById: vi.fn(async (installationId: string) => {
      if (installationId !== "gh_installation_1") {
        return undefined;
      }

      return {
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
      };
    }),
  };
};

const createGitHubInstallationRepositoryCacheStub = () => {
  return {
    getInstallationRepositoryById: vi.fn(async (installationRepositoryId: string) => {
      if (installationRepositoryId !== "gh_installation_repo_1") {
        return undefined;
      }

      return {
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
        createdAt: new Date("2026-03-20T12:00:00.000Z"),
        updatedAt: new Date("2026-03-24T12:00:00.000Z"),
        removedAt: null,
      };
    }),
  };
};

const createGitHubSourceIntegrationStub = (): GitHubSourceIntegration => {
  return {
    isConfigured: () => true,
    createAppJwt: () => "jwt",
    isWebhookVerificationConfigured: () => false,
    verifyWebhookSignature: () => false,
    createInstallationAccessToken: vi.fn(async () => ({
      token: "github-installation-token",
      expiresAt: new Date("2026-03-26T12:00:00.000Z"),
    })),
    getInstallation: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    listInstallationRepositories: vi.fn(async () => []),
  } as unknown as GitHubSourceIntegration;
};

const createRuntimeAdapterStub = (
  id: RuntimeAdapter["id"],
  options: {
    supports?: RuntimeAdapter["supports"];
    launch?: RuntimeAdapter["launch"];
  } = {},
): RuntimeAdapter => {
  return {
    id,
    supports: options.supports ?? vi.fn(() => ({ supported: true as const })),
    launch:
      options.launch ??
      vi.fn(async () => ({
        adapter: id,
        resourceId: "resource_123",
        reference: "sealant-resource",
        status: "running" as const,
      })),
  };
};

describe("processWorkspaceBuildJob", () => {
  it("mints GitHub installation token auth right before runtime launch", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_github_runtime_auth",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: {
          source: {
            kind: "git",
            provider: "github",
            url: "https://github.com/sealant-ops/core.git",
            ref: "main",
            authRef: "github-installation-repository:gh_installation_repo_1",
          },
          harness: "opencode",
          os: "nix",
        },
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createWorkspaceBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(
      createSandboxAttemptRepositoryStub() as never,
    );
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );
    vi.mocked(createGitHubInstallationRepository).mockReturnValue(
      createGitHubInstallationRepositoryStub() as never,
    );
    vi.mocked(createGitHubInstallationRepositoryCacheRepository).mockReturnValue(
      createGitHubInstallationRepositoryCacheStub() as never,
    );

    const executor = {
      id: "nix",
      osFamily: "nix",
      supports: vi.fn(() => ({ supported: true as const })),
      compile: vi.fn(async () => ({
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
      })),
    } as unknown as OsExecutor;

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;
    const gitHubSourceIntegration = createGitHubSourceIntegrationStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    await processWorkspaceBuildJob({
      jobId: "job_github_runtime_auth",
      workerId: "worker-test",
      leaseDurationMs: 60000,
      dbClient: {} as DatabaseClient,
      executors: [executor],
      runtimeAdapters: [runtimeAdapter],
      defaultRuntimeAdapterId: "docker",
      defaultStartupMode: "idle",
      defaultIdleCommand: "while :; do sleep 30; done",
      defaultSshEnabled: true,
      defaultSshListenPort: 2222,
      gitHubSourceIntegration,
      registryClient,
    });

    expect(gitHubSourceIntegration.createInstallationAccessToken).toHaveBeenCalledWith("1001");
    expect(runtimeAdapter.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceCloneAuth: {
          type: "http-token",
          username: "x-access-token",
          token: "github-installation-token",
        },
      }),
    );
  });

  it("applies idle startup and SSH defaults when spec omits them", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_defaults",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "nix",
        },
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createWorkspaceBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(
      createSandboxAttemptRepositoryStub() as never,
    );
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );

    const executor = {
      id: "nix",
      osFamily: "nix",
      supports: vi.fn(() => ({ supported: true as const })),
      compile: vi.fn(async () => ({
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
      })),
    } as unknown as OsExecutor;

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;

    const runtimeAdapter = createRuntimeAdapterStub("docker");

    await processWorkspaceBuildJob({
      jobId: "job_defaults",
      workerId: "worker-test",
      leaseDurationMs: 60000,
      dbClient: {} as DatabaseClient,
      executors: [executor],
      runtimeAdapters: [runtimeAdapter],
      defaultRuntimeAdapterId: "docker",
      defaultStartupMode: "idle",
      defaultIdleCommand: "while :; do sleep 30; done",
      defaultSshEnabled: true,
      defaultSshListenPort: 2222,
      registryClient,
    });

    const launchCall = vi.mocked(runtimeAdapter.launch).mock.calls[0]?.[0];
    const lifecycle = (launchCall?.blueprint as unknown as { lifecycle?: unknown }).lifecycle;
    expect(launchCall?.blueprint.access.ssh).toEqual({
      enabled: true,
      listenPort: 2222,
    });
    expect(lifecycle).toMatchObject({
      startup: {
        foreground: {
          kind: "command",
          run: "while :; do sleep 30; done",
          shell: "bash",
        },
      },
    });
  });

  it("respects explicit startup and SSH settings from spec", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_explicit",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "nix",
          ssh: false,
          startup: "pnpm dev",
        },
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createWorkspaceBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(
      createSandboxAttemptRepositoryStub() as never,
    );
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );

    const executor = {
      id: "nix",
      osFamily: "nix",
      supports: vi.fn(() => ({ supported: true as const })),
      compile: vi.fn(async () => ({
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
      })),
    } as unknown as OsExecutor;

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;

    const runtimeAdapter = createRuntimeAdapterStub("docker");

    await processWorkspaceBuildJob({
      jobId: "job_explicit",
      workerId: "worker-test",
      leaseDurationMs: 60000,
      dbClient: {} as DatabaseClient,
      executors: [executor],
      runtimeAdapters: [runtimeAdapter],
      defaultRuntimeAdapterId: "docker",
      defaultStartupMode: "idle",
      defaultIdleCommand: "while :; do sleep 30; done",
      defaultSshEnabled: true,
      defaultSshListenPort: 2222,
      registryClient,
    });

    const launchCall = vi.mocked(runtimeAdapter.launch).mock.calls[0]?.[0];
    const lifecycle = (launchCall?.blueprint as unknown as { lifecycle?: unknown }).lifecycle;
    expect(launchCall?.blueprint.access.ssh.enabled).toBe(false);
    expect(lifecycle).toMatchObject({
      startup: {
        foreground: {
          kind: "command",
          run: "pnpm dev",
          shell: "bash",
        },
      },
    });
  });

  it("claims, compiles, publishes, and marks a job as succeeded", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_123",
        runId: "run_123",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "nix",
        },
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    const runRepository = createSandboxAttemptRepositoryStub();

    vi.mocked(createWorkspaceBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(runRepository as never);
    const runtimeRepository = createSandboxRuntimeInstanceRepositoryStub();
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(runtimeRepository as never);

    const executor = {
      id: "nix",
      osFamily: "nix",
      supports: vi.fn(() => ({ supported: true as const })),
      compile: vi.fn(async () => ({
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
      })),
    } as unknown as OsExecutor;

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    const result = await processWorkspaceBuildJob({
      jobId: "job_123",
      workerId: "worker-test",
      leaseDurationMs: 60000,
      dbClient: {} as DatabaseClient,
      executors: [executor],
      runtimeAdapters: [runtimeAdapter],
      defaultRuntimeAdapterId: "docker",
      defaultStartupMode: "idle",
      defaultIdleCommand: "while :; do sleep 30; done",
      defaultSshEnabled: true,
      defaultSshListenPort: 2222,
      registryClient,
    });

    expect(result?.digest).toBe("sha256:test");
    expect(repository.claimJobById).toHaveBeenCalledWith({
      id: "job_123",
      workerId: "worker-test",
      leaseDurationMs: 60000,
    });
    expect(repository.markJobSucceeded).toHaveBeenCalled();
    expect(repository.markJobFailed).not.toHaveBeenCalled();
    expect(runRepository.markAttemptRunning).toHaveBeenCalledWith({ id: "run_123" });
    expect(runRepository.markAttemptSucceeded).toHaveBeenCalledWith({ id: "run_123" });
    expect(runRepository.markAttemptFailed).not.toHaveBeenCalled();
    expect(runtimeRepository.upsertRuntimeInstance).toHaveBeenCalledTimes(2);
    expect(runtimeAdapter.launch).toHaveBeenCalledTimes(1);
    expect(repository.markJobSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        resultPayload: expect.objectContaining({
          executor: expect.any(Object),
        }),
      }),
    );
  });

  it("marks a job as failed when compile or publish throws", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_123",
        runId: "run_123",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "nix",
        },
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    const runRepository = createSandboxAttemptRepositoryStub();

    vi.mocked(createWorkspaceBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(runRepository as never);
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );

    const executor = {
      id: "nix",
      osFamily: "nix",
      supports: vi.fn(() => ({ supported: true as const })),
      compile: vi.fn(async () => {
        throw new Error("compile exploded");
      }),
    } as unknown as OsExecutor;

    await expect(
      processWorkspaceBuildJob({
        jobId: "job_123",
        workerId: "worker-test",
        leaseDurationMs: 60000,
        dbClient: {} as DatabaseClient,
        executors: [executor],
        runtimeAdapters: [createRuntimeAdapterStub("docker")],
        defaultRuntimeAdapterId: "docker",
        defaultStartupMode: "idle",
        defaultIdleCommand: "while :; do sleep 30; done",
        defaultSshEnabled: true,
        defaultSshListenPort: 2222,
        registryClient: {} as RegistryClient,
      }),
    ).rejects.toThrow("compile exploded");

    expect(repository.markJobFailed).toHaveBeenCalledWith({
      id: "job_123",
      errorMessage: "compile exploded",
    });
    expect(runRepository.markAttemptFailed).toHaveBeenCalledWith({ id: "run_123" });
  });

  it("marks a job as failed when no executor is registered for the requested OS", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_123",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          os: "fedora",
        },
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createWorkspaceBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(
      createSandboxAttemptRepositoryStub() as never,
    );
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );

    const nixExecutor = {
      id: "nix",
      osFamily: "nix",
      supports: vi.fn(() => ({ supported: true as const })),
      compile: vi.fn(async () => {
        throw new Error("should not run");
      }),
    } as unknown as OsExecutor;

    await expect(
      processWorkspaceBuildJob({
        jobId: "job_123",
        workerId: "worker-test",
        leaseDurationMs: 60000,
        dbClient: {} as DatabaseClient,
        executors: [nixExecutor],
        runtimeAdapters: [createRuntimeAdapterStub("docker")],
        defaultRuntimeAdapterId: "docker",
        defaultStartupMode: "idle",
        defaultIdleCommand: "while :; do sleep 30; done",
        defaultSshEnabled: true,
        defaultSshListenPort: 2222,
        registryClient: {} as RegistryClient,
      }),
    ).rejects.toThrow("No executor is registered for target.os.family 'fedora'.");

    expect(repository.markJobFailed).toHaveBeenCalledWith({
      id: "job_123",
      errorCode: "unsupported-os",
      errorMessage: "No executor is registered for target.os.family 'fedora'.",
    });
    expect(repository.markJobSucceeded).not.toHaveBeenCalled();
  });

  it("prefers a non-nix executor when target.os.family is auto", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_auto",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: {
          source: "https://github.com/example/repo",
          harness: "opencode",
        },
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createWorkspaceBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(
      createSandboxAttemptRepositoryStub() as never,
    );
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );

    const fedoraExecutor = {
      id: "fedora",
      osFamily: "fedora",
      supports: vi.fn(() => ({ supported: true as const })),
      compile: vi.fn(async () => ({
        executor: {
          id: "fedora",
          osFamily: "fedora",
        },
        artifacts: [
          {
            kind: "oci-image",
            name: "demo-fedora",
            path: "/tmp/demo-fedora.tar",
            reference: "demo-fedora:opencode",
            loader: "docker-load",
          },
        ],
      })),
    } as unknown as OsExecutor;

    const nixExecutor = {
      id: "nix",
      osFamily: "nix",
      supports: vi.fn(() => ({ supported: true as const })),
      compile: vi.fn(async () => ({
        executor: {
          id: "nix",
          osFamily: "nix",
        },
        artifacts: [
          {
            kind: "oci-image",
            name: "demo-nix",
            path: "/tmp/demo-nix.tar",
            reference: "demo-nix:opencode",
            loader: "docker-load",
          },
        ],
      })),
    } as unknown as OsExecutor;

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;

    await processWorkspaceBuildJob({
      jobId: "job_auto",
      workerId: "worker-test",
      leaseDurationMs: 60000,
      dbClient: {} as DatabaseClient,
      executors: [fedoraExecutor, nixExecutor],
      runtimeAdapters: [createRuntimeAdapterStub("docker")],
      defaultRuntimeAdapterId: "docker",
      defaultStartupMode: "idle",
      defaultIdleCommand: "while :; do sleep 30; done",
      defaultSshEnabled: true,
      defaultSshListenPort: 2222,
      registryClient,
    });

    expect(vi.mocked(fedoraExecutor.compile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(nixExecutor.compile)).not.toHaveBeenCalled();
  });

  it("keeps build succeeded when runtime launch selection fails", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_123",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: {
          source: "https://github.com/example/repo",
          harness: "opencode",
          target: {
            runtime: {
              family: "k8s",
              mode: "require",
            },
          },
        },
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createWorkspaceBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(
      createSandboxAttemptRepositoryStub() as never,
    );
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );

    const executor = {
      id: "nix",
      osFamily: "nix",
      supports: vi.fn(() => ({ supported: true as const })),
      compile: vi.fn(async () => ({
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
      })),
    } as unknown as OsExecutor;

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;

    await expect(
      processWorkspaceBuildJob({
        jobId: "job_123",
        workerId: "worker-test",
        leaseDurationMs: 60000,
        dbClient: {} as DatabaseClient,
        executors: [executor],
        runtimeAdapters: [createRuntimeAdapterStub("docker")],
        defaultRuntimeAdapterId: "docker",
        defaultStartupMode: "idle",
        defaultIdleCommand: "while :; do sleep 30; done",
        defaultSshEnabled: true,
        defaultSshListenPort: 2222,
        registryClient,
      }),
    ).rejects.toThrow("No runtime adapter is registered for target.runtime.family 'k8s'.");

    expect(repository.markJobFailed).not.toHaveBeenCalled();
    expect(repository.markJobSucceeded).toHaveBeenCalledTimes(1);
  });
});
