import type { DatabaseClient } from "@sealant/db";
import type { NixOsExecutor } from "@sealant/os-integration-nix";
import type { RegistryClient } from "@sealant/registry-integration";
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

describe("processWorkspaceBuildJob", () => {
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
    } as unknown as NixOsExecutor;

    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
        digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
        digest: "sha256:test",
      })),
    } as unknown as RegistryClient;

    const result = await processWorkspaceBuildJob({
      jobId: "job_123",
      workerId: "worker-test",
      leaseDurationMs: 60000,
      dbClient: {} as DatabaseClient,
      executor,
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
      compile: vi.fn(async () => {
        throw new Error("compile exploded");
      }),
    } as unknown as NixOsExecutor;

    await expect(
      processWorkspaceBuildJob({
        jobId: "job_123",
        workerId: "worker-test",
        leaseDurationMs: 60000,
        dbClient: {} as DatabaseClient,
        executor,
        registryClient: {} as RegistryClient,
      }),
    ).rejects.toThrow("compile exploded");

    expect(repository.markJobFailed).toHaveBeenCalledWith({
      id: "job_123",
      errorMessage: "compile exploded",
    });
  });
});
