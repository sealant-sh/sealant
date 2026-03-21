import type { DatabaseClient } from "@sealant/db";
import type { RegistryClient } from "@sealant/registry-integration";
import type { RuntimeAdapter } from "@sealant/runtime-adapters-api";
import type { OsExecutor } from "@sealant/workspace-composition";
import { describe, expect, it, vi } from "vitest";

import { processWorkspaceBuildJob } from "./process-workspace-build-job.js";

vi.mock("@sealant/db", () => {
  return {
    createWorkspaceBuildJobRepository: vi.fn(),
    workspaceBuildJobRequestPayloadSchema: {
      parse: vi.fn((input: unknown) => input),
    },
  };
});

const { createWorkspaceBuildJobRepository } = await import("@sealant/db");

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
  it("applies idle startup and SSH defaults when spec omits them", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_defaults",
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
    expect(launchCall?.blueprint.access.ssh).toEqual({
      enabled: true,
      listenPort: 2222,
    });
    expect((launchCall?.blueprint as { lifecycle: unknown } | undefined)?.lifecycle).toMatchObject({
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
    expect(launchCall?.blueprint.access.ssh.enabled).toBe(false);
    expect((launchCall?.blueprint as { lifecycle: unknown } | undefined)?.lifecycle).toMatchObject({
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
    expect(runtimeAdapter.launch).toHaveBeenCalledTimes(1);
    expect(repository.markJobSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        resultPayload: expect.objectContaining({
          compile: expect.any(Object),
          runtime: expect.objectContaining({
            adapter: "docker",
            resourceId: "resource_123",
          }),
        }),
      }),
    );
  });

  it("marks a job as failed when compile or publish throws", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_123",
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
  });

  it("marks a job as failed when no executor is registered for the requested OS", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_123",
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

  it("marks a job as failed when no runtime adapter is registered for a required runtime", async () => {
    const repository = {
      claimJobById: vi.fn(async () => ({
        id: "job_123",
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

    expect(repository.markJobFailed).toHaveBeenCalledWith({
      id: "job_123",
      errorCode: "unsupported-runtime",
      errorMessage: "No runtime adapter is registered for target.runtime.family 'k8s'.",
    });
    expect(repository.markJobSucceeded).not.toHaveBeenCalled();
  });
});
