import type { DatabaseClient } from "@sealant/db";
import type { GitHubSourceIntegration } from "@sealant/source-integrations";
import type { NewSandbox, SandboxBuild } from "@sealant/validators";
import { describe, expect, it, vi } from "vitest";

import type { RegistryClient } from "../registry/index.js";
import type { RuntimeAdapter } from "../runtime/index.js";
import { processSandboxBuildJob } from "./process-sandbox-build-job.js";

vi.mock("@sealant/db", () => {
  return {
    createGitHubInstallationRepository: vi.fn(),
    createGitHubInstallationRepositoryCacheRepository: vi.fn(),
    createSandboxAttemptRepository: vi.fn(),
    createSandboxRuntimeInstanceRepository: vi.fn(),
    createSandboxBuildJobRepository: vi.fn(),
  };
});

const {
  createGitHubInstallationRepository,
  createGitHubInstallationRepositoryCacheRepository,
  createSandboxAttemptRepository,
  createSandboxRuntimeInstanceRepository,
  createSandboxBuildJobRepository,
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

const createCompileResult = (
  input: {
    readonly id?: "nix" | "fedora" | "arch";
    readonly path?: string;
    readonly reference?: string;
    readonly name?: string;
  } = {},
): SandboxBuild => {
  const id = input.id ?? "nix";

  return {
    builder: {
      id,
      osFamily: id,
    },
    artifacts: [
      {
        kind: "oci-image",
        name: input.name ?? "demo",
        path: input.path ?? "/tmp/demo.tar",
        reference: input.reference ?? "demo:opencode",
        loader: "docker-load",
      },
    ],
  };
};

const createSandboxBuildSpec = (
  input: {
    readonly url?: string;
    readonly ref?: string;
    readonly authRef?: string;
    readonly osFamily?: "auto" | "nix" | "fedora" | "arch";
    readonly runtimeFamily?: "auto" | "docker" | "k8s" | "k3s";
    readonly runtimeMode?: "prefer" | "require";
    readonly startupCommand?: string;
    readonly sshEnabled?: boolean;
    readonly inputSources?: NewSandbox["sources"]["inputs"];
  } = {},
): NewSandbox => {
  return {
    version: "1",
    sources: {
      sandbox: {
        kind: "git",
        provider: "generic",
        url: input.url ?? "https://github.com/example/repo",
        ref: input.ref ?? "main",
        ...(input.authRef === undefined ? {} : { authRef: input.authRef }),
      },
      inputs: input.inputSources ?? [],
    },
    harness: {
      id: "opencode",
    },
    access: {
      ssh: {
        enabled: input.sshEnabled ?? false,
        listenPort: 2222,
      },
    },
    tooling: {
      packages: [],
    },
    customization: {
      defaultShell: "bash",
      dotfilesManager: "auto",
      dotfilesTarget: "home",
      applyDotfiles: true,
      dotfilesBootstrap: true,
    },
    lifecycle: {
      setup: [],
      startup: {
        steps: [],
        foreground:
          input.startupCommand === undefined
            ? {
                kind: "harness",
              }
            : {
                kind: "command",
                run: input.startupCommand,
                shell: "bash",
              },
      },
    },
    runtime: {
      env: {},
      sandboxRoot: "/sandbox",
      workingDirectory: "/sandbox/repo",
      persistence: "ephemeral",
      ociRuntime: "runc",
      network: {
        outbound: true,
      },
    },
    target: {
      os: {
        family: input.osFamily ?? "nix",
        mode: "prefer",
      },
      runtime: {
        family: input.runtimeFamily ?? "auto",
        mode: input.runtimeMode ?? "prefer",
      },
    },
  };
};

describe("processSandboxBuildJob", () => {
  it("mints GitHub installation token auth right before runtime launch", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_github_runtime_auth",
        runId: null,
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        requestPayload: createSandboxBuildSpec({
          url: "https://github.com/sealant-ops/core.git",
          authRef: "github-installation-repository:gh_installation_repo_1",
          osFamily: "nix",
        }),
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createSandboxBuildJobRepository).mockReturnValue(repository as never);
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

    const compileSandboxSpec = vi.fn(async () => createCompileResult({ id: "nix" }));

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/sandboxes/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/sandboxes/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;
    const gitHubSourceIntegration = createGitHubSourceIntegrationStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    await processSandboxBuildJob({
      jobId: "job_github_runtime_auth",
      workerId: "worker-test",
      leaseDurationMs: 60000,
      dbClient: {} as DatabaseClient,
      runtimeAdapters: [runtimeAdapter],
      defaultRuntimeAdapterId: "docker",
      gitHubSourceIntegration,
      registryClient,
      compileSandboxSpec,
    });

    expect(gitHubSourceIntegration.createInstallationAccessToken).toHaveBeenCalledWith("1001");
    expect(runtimeAdapter.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxCloneAuth: {
          type: "http-token",
          username: "x-access-token",
          token: "github-installation-token",
        },
      }),
    );
  });

  it("injects dotfiles GitHub token env for runtime-applied config repos", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_dotfiles_runtime_auth",
        runId: null,
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        requestPayload: createSandboxBuildSpec({
          url: "https://github.com/example/repo.git",
          osFamily: "nix",
          inputSources: [
            {
              id: "dotfiles",
              kind: "git",
              purpose: "dotfiles",
              provider: "github",
              url: "https://github.com/sealant-ops/core.git",
              ref: "main",
              authRef: "github-installation-repository:gh_installation_repo_1",
            },
          ],
        }),
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createSandboxBuildJobRepository).mockReturnValue(repository as never);
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

    const compileSandboxSpec = vi.fn(async () => createCompileResult({ id: "nix" }));

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/sandboxes/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/sandboxes/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;
    const gitHubSourceIntegration = createGitHubSourceIntegrationStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    await processSandboxBuildJob({
      jobId: "job_dotfiles_runtime_auth",
      workerId: "worker-test",
      leaseDurationMs: 60000,
      dbClient: {} as DatabaseClient,
      runtimeAdapters: [runtimeAdapter],
      defaultRuntimeAdapterId: "docker",
      gitHubSourceIntegration,
      registryClient,
      compileSandboxSpec,
    });

    expect(gitHubSourceIntegration.createInstallationAccessToken).toHaveBeenCalledWith("1001");
    expect(runtimeAdapter.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        blueprint: expect.objectContaining({
          runtime: expect.objectContaining({
            env: expect.objectContaining({
              SEALANT_DOTFILES_HTTP_USERNAME: "x-access-token",
              SEALANT_DOTFILES_HTTP_TOKEN: "github-installation-token",
            }),
          }),
        }),
      }),
    );
  });

  it("uses startup and SSH values from the request spec", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_defaults",
        runId: null,
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        requestPayload: createSandboxBuildSpec({
          osFamily: "nix",
        }),
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createSandboxBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(
      createSandboxAttemptRepositoryStub() as never,
    );
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );

    const compileSandboxSpec = vi.fn(async () => createCompileResult({ id: "nix" }));

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/sandboxes/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/sandboxes/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;

    const runtimeAdapter = createRuntimeAdapterStub("docker");

    await processSandboxBuildJob({
      jobId: "job_defaults",
      workerId: "worker-test",
      leaseDurationMs: 60000,
      dbClient: {} as DatabaseClient,
      runtimeAdapters: [runtimeAdapter],
      defaultRuntimeAdapterId: "docker",
      registryClient,
      compileSandboxSpec,
    });

    const launchCall = vi.mocked(runtimeAdapter.launch).mock.calls[0]?.[0];
    expect(launchCall).toBeDefined();

    if (launchCall === undefined) {
      throw new Error("Runtime adapter launch call was not captured.");
    }

    const lifecycle = (launchCall.blueprint as unknown as { lifecycle?: unknown }).lifecycle;
    expect(launchCall.blueprint.access.ssh).toEqual({
      enabled: false,
      listenPort: 2222,
    });
    expect(lifecycle).toMatchObject({
      startup: {
        foreground: {
          kind: "harness",
        },
      },
    });
  });

  it("respects explicit startup and SSH settings from spec", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_explicit",
        runId: null,
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        requestPayload: createSandboxBuildSpec({
          osFamily: "nix",
          sshEnabled: false,
          startupCommand: "pnpm dev",
        }),
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createSandboxBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(
      createSandboxAttemptRepositoryStub() as never,
    );
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );

    const compileSandboxSpec = vi.fn(async () => createCompileResult({ id: "nix" }));

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/sandboxes/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/sandboxes/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;

    const runtimeAdapter = createRuntimeAdapterStub("docker");

    await processSandboxBuildJob({
      jobId: "job_explicit",
      workerId: "worker-test",
      leaseDurationMs: 60000,
      dbClient: {} as DatabaseClient,
      runtimeAdapters: [runtimeAdapter],
      defaultRuntimeAdapterId: "docker",
      registryClient,
      compileSandboxSpec,
    });

    const launchCall = vi.mocked(runtimeAdapter.launch).mock.calls[0]?.[0];
    expect(launchCall).toBeDefined();

    if (launchCall === undefined) {
      throw new Error("Runtime adapter launch call was not captured.");
    }

    const lifecycle = (launchCall.blueprint as unknown as { lifecycle?: unknown }).lifecycle;
    expect(launchCall.blueprint.access.ssh.enabled).toBe(false);
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
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        requestPayload: createSandboxBuildSpec({
          osFamily: "nix",
        }),
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    const runRepository = createSandboxAttemptRepositoryStub();

    vi.mocked(createSandboxBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(runRepository as never);
    const runtimeRepository = createSandboxRuntimeInstanceRepositoryStub();
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(runtimeRepository as never);

    const compileSandboxSpec = vi.fn(async () => createCompileResult({ id: "nix" }));

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/sandboxes/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/sandboxes/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    const result = await processSandboxBuildJob({
      jobId: "job_123",
      workerId: "worker-test",
      leaseDurationMs: 60000,
      dbClient: {} as DatabaseClient,
      runtimeAdapters: [runtimeAdapter],
      defaultRuntimeAdapterId: "docker",
      registryClient,
      compileSandboxSpec,
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
          builder: expect.any(Object),
        }),
      }),
    );
  });

  it("marks a job as failed when compile or publish throws", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_123",
        runId: "run_123",
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        requestPayload: createSandboxBuildSpec({
          osFamily: "nix",
        }),
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    const runRepository = createSandboxAttemptRepositoryStub();

    vi.mocked(createSandboxBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(runRepository as never);
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );

    const compileSandboxSpec = vi.fn(async () => {
      throw new Error("compile exploded");
    });

    await expect(
      processSandboxBuildJob({
        jobId: "job_123",
        workerId: "worker-test",
        leaseDurationMs: 60000,
        dbClient: {} as DatabaseClient,
        runtimeAdapters: [createRuntimeAdapterStub("docker")],
        defaultRuntimeAdapterId: "docker",
        registryClient: {} as RegistryClient,
        compileSandboxSpec,
      }),
    ).rejects.toThrow("compile exploded");

    expect(repository.markJobFailed).toHaveBeenCalledWith({
      id: "job_123",
      errorMessage: "compile exploded",
    });
    expect(runRepository.markAttemptFailed).toHaveBeenCalledWith({ id: "run_123" });
  });

  it("marks a job as failed when compilation rejects unsupported target OS", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_123",
        runId: null,
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        requestPayload: createSandboxBuildSpec({
          osFamily: "fedora",
        }),
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createSandboxBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(
      createSandboxAttemptRepositoryStub() as never,
    );
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );

    const compileSandboxSpec = vi.fn(async () => {
      const error = new Error(
        "No compiler is available for target.os.family 'fedora'.",
      ) as Error & {
        code: string;
      };
      error.code = "unsupported-os";
      throw error;
    });

    await expect(
      processSandboxBuildJob({
        jobId: "job_123",
        workerId: "worker-test",
        leaseDurationMs: 60000,
        dbClient: {} as DatabaseClient,
        runtimeAdapters: [createRuntimeAdapterStub("docker")],
        defaultRuntimeAdapterId: "docker",
        registryClient: {} as RegistryClient,
        compileSandboxSpec,
      }),
    ).rejects.toThrow("No compiler is available for target.os.family 'fedora'.");

    expect(repository.markJobFailed).toHaveBeenCalledWith({
      id: "job_123",
      errorCode: "unsupported-os",
      errorMessage: "No compiler is available for target.os.family 'fedora'.",
    });
    expect(repository.markJobSucceeded).not.toHaveBeenCalled();
  });

  it("keeps build succeeded when runtime launch selection fails", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_123",
        runId: null,
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        requestPayload: createSandboxBuildSpec({
          runtimeFamily: "k8s",
          runtimeMode: "require",
        }),
      })),
      markJobSucceeded: vi.fn(async () => ({})),
      markJobFailed: vi.fn(async () => ({})),
    };

    vi.mocked(createSandboxBuildJobRepository).mockReturnValue(repository as never);
    vi.mocked(createSandboxAttemptRepository).mockReturnValue(
      createSandboxAttemptRepositoryStub() as never,
    );
    vi.mocked(createSandboxRuntimeInstanceRepository).mockReturnValue(
      createSandboxRuntimeInstanceRepositoryStub() as never,
    );

    const compileSandboxSpec = vi.fn(async () => createCompileResult({ id: "nix" }));

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/sandboxes/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/sandboxes/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;

    await expect(
      processSandboxBuildJob({
        jobId: "job_123",
        workerId: "worker-test",
        leaseDurationMs: 60000,
        dbClient: {} as DatabaseClient,
        runtimeAdapters: [createRuntimeAdapterStub("docker")],
        defaultRuntimeAdapterId: "docker",
        registryClient,
        compileSandboxSpec,
      }),
    ).rejects.toThrow("No runtime adapter is registered for target.runtime.family 'k8s'.");

    expect(repository.markJobFailed).not.toHaveBeenCalled();
    expect(repository.markJobSucceeded).toHaveBeenCalledTimes(1);
  });
});
