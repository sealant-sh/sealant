import { existsSync, readFileSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  claudeCredentialsCopy,
  codexAuthJsonCopy,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  GitHubInstallationRepo,
  LAUNCH_OWNERSHIP_LOST_MESSAGE,
  LAUNCH_RETAINED_ERROR_CODE,
  WorkspaceRuntimeInstanceRepoInvariantError,
  GitHubInstallationRepositoryCacheRepo,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceCaptureDrainRepo,
  WorkspaceCredentialHomeRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccountRepoService,
  type GitHubInstallationRepoService,
  type GitHubInstallationRepositoryCacheRepoService,
  type WorkspaceAttemptRepoService,
  type WorkspaceBuildJobRepoService,
  type WorkspaceCaptureDrainRepoService,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { makeInMemoryCredentialHomes } from "@sealant/db/testing/credential-homes";
import type { GitHubSourceIntegration } from "@sealant/source-integrations";
import type { NewWorkspace, WorkspaceBuild, WorkspaceImageProbe } from "@sealant/validators";
import { Effect, Exit, Fiber, Layer, Result } from "effect";
import { vi } from "vitest";

import {
  createDockerWorkspaceImageBuilder,
  type DockerWorkspaceImageBuilderOptions,
  type WorkspaceImageBuilder,
} from "../images/index.js";
import type { RegistryClient } from "../registry/index.js";
import { LaunchRetainedError, type RuntimeAdapter } from "../runtime/index.js";
import { WorkspaceBuildJobProcessingError } from "./errors.js";
import {
  dotfilesStagingRoot,
  processWorkspaceBuildJobEffect,
  type ProcessWorkspaceBuildJobEffectOptions,
  DEFAULT_LAUNCH_LEASE_MS,
} from "./process-workspace-build-job.js";

const workspaceBuildJobRepoStub = (
  overrides: {
    readonly claimJobById?: () => unknown;
    readonly getLatestSucceededJobByPlanHash?: () => unknown;
  } = {},
) => ({
  claimJobById: vi.fn((_input: { id: string; workerId: string; leaseDurationMs: number }) =>
    Effect.succeed(overrides.claimJobById?.() ?? null),
  ),
  getLatestSucceededJobByPlanHash: vi.fn((_input: { registryId: string; planHash: string }) =>
    Effect.succeed(overrides.getLatestSucceededJobByPlanHash?.() ?? undefined),
  ),
  markJobSucceeded: vi.fn((_input: unknown): Effect.Effect<object | null> => Effect.succeed({})),
  markJobFailed: vi.fn((_input: unknown) => Effect.succeed({})),
  clearSecretEnv: vi.fn((_id: string) => Effect.void),
});

const workspaceAttemptRepoStub = () => ({
  markAttemptRunning: vi.fn((_input: { id: string }) => Effect.succeed(null)),
  markAttemptSucceeded: vi.fn((_input: { id: string }) => Effect.succeed(null)),
  markAttemptFailed: vi.fn((_input: { id: string }) => Effect.succeed(null)),
});

const workspaceRuntimeInstanceRepoStub = () => ({
  upsertRuntimeInstance: vi.fn((_input: unknown) => Effect.succeed({})),
  renewLaunchLease: vi.fn((_input: { runId: string; owner: string; leaseMs: number }) =>
    Effect.succeed(true),
  ),
});

const githubInstallationRepoStub = (options: { status?: string } = {}) => ({
  getInstallationById: vi.fn((installationId: string) => {
    if (installationId !== "gh_installation_1") {
      return Effect.succeed(undefined);
    }

    return Effect.succeed({
      id: "gh_installation_1",
      provider: "github",
      externalInstallationId: "1001",
      externalAccountId: "2001",
      accountLogin: "sealant-ops",
      accountType: "organization",
      targetType: "organization",
      status: options.status ?? "active",
      permissions: { contents: "read", metadata: "read" },
      repositorySelection: "all",
      installedAt: new Date("2026-03-20T12:00:00.000Z"),
      suspendedAt: options.status === "active" || options.status === undefined ? null : new Date(),
      lastSyncedAt: new Date("2026-03-24T12:00:00.000Z"),
      createdAt: new Date("2026-03-20T12:00:00.000Z"),
      updatedAt: new Date("2026-03-24T12:00:00.000Z"),
    });
  }),
});

const githubInstallationRepositoryCacheStub = () => ({
  getInstallationRepositoryById: vi.fn((installationRepositoryId: string) => {
    if (installationRepositoryId !== "gh_installation_repo_1") {
      return Effect.succeed(undefined);
    }

    return Effect.succeed({
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
    });
  }),
});

const githubSourceIntegrationStub = (): GitHubSourceIntegration => {
  return {
    isConfigured: () => true,
    createAppJwt: () => Effect.succeed("jwt"),
    isWebhookVerificationConfigured: () => false,
    verifyWebhookSignature: () => false,
    createInstallationAccessToken: vi.fn((_externalInstallationId: string) =>
      Effect.succeed({
        token: "github-installation-token",
        expiresAt: new Date("2026-03-26T12:00:00.000Z"),
      }),
    ),
    getInstallation: vi.fn(() => Effect.die("not implemented")),
    listInstallationRepositories: vi.fn(() => Effect.succeed([])),
  } as unknown as GitHubSourceIntegration;
};

const createRuntimeAdapterStub = (
  id: RuntimeAdapter["id"],
  options: {
    supports?: RuntimeAdapter["supports"];
    launch?: RuntimeAdapter["launch"];
    stop?: RuntimeAdapter["stop"];
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
    stop:
      options.stop ??
      vi.fn(async () => ({
        adapter: id,
        resourceId: "resource_123",
        outcome: "stopped" as const,
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
): WorkspaceBuild => {
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

const createWorkspaceBuildSpec = (
  input: {
    readonly url?: string;
    readonly ref?: string;
    readonly authRef?: string;
    readonly osFamily?: "auto" | "nix" | "fedora" | "arch";
    readonly runtimeFamily?: "auto" | "docker" | "k8s" | "k3s";
    readonly runtimeMode?: "prefer" | "require";
    readonly startupCommand?: string;
    readonly sshEnabled?: boolean;
    readonly inputSources?: NewWorkspace["sources"]["inputs"];
    readonly credentialRefs?: NewWorkspace["runtime"]["credentialRefs"];
    readonly packages?: NewWorkspace["tooling"]["packages"];
    readonly applyDotfiles?: boolean;
    readonly dotfilesArchives?: NewWorkspace["runtime"]["dotfilesArchives"];
    readonly userEnv?: NewWorkspace["runtime"]["userEnv"];
  } = {},
): NewWorkspace => {
  return {
    version: "1",
    sources: {
      workspace: {
        kind: "git",
        provider: "generic",
        url: input.url ?? "https://github.com/example/repo",
        ref: input.ref ?? "main",
        ...(input.authRef === undefined ? {} : { authRef: input.authRef }),
      },
      inputs: input.inputSources ?? [],
      mounts: [],
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
      packages: input.packages ?? [],
    },
    customization: {
      defaultShell: "bash",
      dotfilesManager: "auto",
      dotfilesTarget: "home",
      applyDotfiles: input.applyDotfiles ?? true,
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
      userEnv: input.userEnv ?? {},
      credentialRefs: input.credentialRefs ?? [],
      dotfilesArchives: input.dotfilesArchives ?? [],
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace/repo",
      persistence: "ephemeral",
      envFrom: [],
      kubernetes: {},
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

const successRegistryClient = (): RegistryClient =>
  ({
    publishOciImage: vi.fn(async () => ({
      repository: "sealant/workspaces/demo",
      tag: "opencode",
      reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
      digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
      digest: "sha256:test",
    })),
  }) as unknown as RegistryClient;

const provideRepos = (stubs: {
  readonly jobs: unknown;
  readonly runtimeInstances: unknown;
  readonly attempts: unknown;
  readonly installations?: unknown;
  readonly installationRepositories?: unknown;
  readonly connectedAccounts?: unknown;
  /** Where a capture launch keeps its recovery credential; default: every write succeeds. */
  readonly captureDrains?: unknown;
}) =>
  Layer.mergeAll(
    Layer.succeed(
      WorkspaceCaptureDrainRepo,
      (stubs.captureDrains ?? {
        storeCaptureToken: () => Effect.void,
      }) as WorkspaceCaptureDrainRepoService,
    ),
    Layer.succeed(WorkspaceBuildJobRepo, stubs.jobs as WorkspaceBuildJobRepoService),
    Layer.succeed(
      WorkspaceRuntimeInstanceRepo,
      stubs.runtimeInstances as WorkspaceRuntimeInstanceRepoService,
    ),
    Layer.succeed(WorkspaceAttemptRepo, stubs.attempts as WorkspaceAttemptRepoService),
    Layer.succeed(
      GitHubInstallationRepo,
      (stubs.installations ?? {}) as GitHubInstallationRepoService,
    ),
    Layer.succeed(
      GitHubInstallationRepositoryCacheRepo,
      (stubs.installationRepositories ?? {}) as GitHubInstallationRepositoryCacheRepoService,
    ),
    Layer.succeed(
      ConnectedAccountRepo,
      (stubs.connectedAccounts ?? {}) as ConnectedAccountRepoService,
    ),
  );

/**
 * What a test says about the build, in the terms these tests were written in: the adapters, and
 * the compiler and planner the Docker builder runs. The pipeline itself takes registered runtimes
 * (an adapter plus the builder of its image), so `baseOptions` pairs every adapter with one Docker
 * builder made from those seams, or with the `imageBuilder` a test supplies.
 */
interface BuildJobTestOverrides extends Partial<
  Omit<ProcessWorkspaceBuildJobEffectOptions, "runtimes">
> {
  readonly runtimeAdapters?: readonly RuntimeAdapter[];
  readonly compileWorkspaceSpec?: DockerWorkspaceImageBuilderOptions["compileWorkspaceSpec"];
  readonly planWorkspaceSpec?: DockerWorkspaceImageBuilderOptions["planWorkspaceSpec"];
  readonly imageBuilder?: WorkspaceImageBuilder;
}

const baseOptions = (overrides: BuildJobTestOverrides): ProcessWorkspaceBuildJobEffectOptions => {
  const {
    runtimeAdapters = [createRuntimeAdapterStub("docker")],
    compileWorkspaceSpec,
    planWorkspaceSpec,
    imageBuilder,
    ...rest
  } = overrides;
  const registryClient = rest.registryClient ?? successRegistryClient();
  const builder =
    imageBuilder ??
    createDockerWorkspaceImageBuilder({
      registryClient,
      ...(compileWorkspaceSpec === undefined ? {} : { compileWorkspaceSpec }),
      ...(planWorkspaceSpec === undefined ? {} : { planWorkspaceSpec }),
    });
  return {
    jobId: "job_123",
    workerId: "worker-test",
    leaseDurationMs: 60000,
    defaultRuntimeAdapterId: "docker",
    ...rest,
    registryClient,
    runtimes: runtimeAdapters.map((adapter) => ({ adapter, imageBuilder: builder })),
  };
};

const fakeCredentialCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

/** A capture job's sealed secret env: the capture token the control plane seals for it. */
const SEALED_CAPTURE_TOKEN = `sealed:${JSON.stringify({ SEALANT_CAPTURE_TOKEN: "mct_test" })}`;

const connectedAccountStub = (input: {
  readonly id: string;
  readonly provider: "claude" | "codex" | "github";
  readonly payload: Record<string, unknown>;
  readonly status?: string;
}) => ({
  id: input.id,
  ownerUserId: "usr_1",
  provider: input.provider,
  name: "default",
  kind: "oauth-token",
  status: input.status ?? "active",
  encryptedPayload: `sealed:${JSON.stringify(input.payload)}`,
  encryptionKeyId: "k-test",
  payloadSha256: "sha",
  metadata: {},
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  lastUsedAt: null,
  lastSyncedAt: null,
  invalidAt: null,
  archivedAt: null,
});

describe("processWorkspaceBuildJobEffect", () => {
  it.effect("passes selected packages from the build job to the image compiler", () => {
    const packages = [{ id: "bat" }, { id: "lazygit" }, { id: "python" }];
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_packages",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "arch", packages }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const compileWorkspaceSpec = vi.fn(async () => createCompileResult({ id: "arch" }));

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_packages",
          compileWorkspaceSpec,
        }),
      );

      expect(compileWorkspaceSpec).toHaveBeenCalledWith(
        expect.objectContaining({
          tooling: expect.objectContaining({ packages }),
        }),
      );
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect(
    "launches nothing when another worker took the job over under the build (review 5 #1)",
    () => {
      const jobs = workspaceBuildJobRepoStub({
        claimJobById: () => ({
          id: "job_taken_over",
          runId: "run_taken_over",
          attemptCount: 1,
          repository: "sealant/workspaces/demo",
          tag: "opencode",
          requestPayload: createWorkspaceBuildSpec({ osFamily: "arch" }),
        }),
      });
      // The lease expired under the build and another worker claimed the job: the claim-fenced
      // success write answers null.
      jobs.markJobSucceeded.mockImplementation(() => Effect.succeed(null));
      const attempts = workspaceAttemptRepoStub();
      const runtimeInstances = workspaceRuntimeInstanceRepoStub();
      const adapter = createRuntimeAdapterStub("docker");

      return Effect.gen(function* () {
        const result = yield* processWorkspaceBuildJobEffect(
          baseOptions({
            jobId: "job_taken_over",
            runtimeAdapters: [adapter],
            compileWorkspaceSpec: async () => createCompileResult({ id: "arch" }),
          }),
        );
        expect(result).toBeNull();
        expect(jobs.markJobSucceeded).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "job_taken_over",
            claim: { workerId: "worker-test", attemptCount: 1 },
          }),
        );
        expect(adapter.launch).not.toHaveBeenCalled();
        expect(runtimeInstances.upsertRuntimeInstance).not.toHaveBeenCalled();
        expect(jobs.markJobFailed).not.toHaveBeenCalled();
        expect(attempts.markAttemptFailed).not.toHaveBeenCalled();
      }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
    },
  );

  it.effect("skips build and publish when the plan hash matches a published image", () => {
    const priorPlanHash = "a".repeat(64);
    // The prior build's probe of the image it published: the reused image is that image.
    const priorProbe: WorkspaceImageProbe = {
      version: 1,
      tools: {
        sudo: true,
        sudoSetuid: true,
        useradd: true,
        groupadd: true,
        setfacl: true,
        getfacl: true,
        setpriv: true,
      },
      sudoersMend: true,
      sudoersIncludesDir: true,
      noNewPrivileges: false,
      passwdWritable: true,
      mendGroup: "present",
      reservedIdsInUse: [],
      personEnv: true,
      sharedDirs: ["/opt/mise"],
      sealantd: null,
    };
    const jobs = workspaceBuildJobRepoStub({
      // The new create has its own fresh repository:tag (the SDK stamps a random tag per
      // create) — only the plan hash links it to the prior publish.
      claimJobById: () => ({
        id: "job_reuse",
        runId: null,
        registryId: "local-zot",
        repository: "session-bbbb",
        tag: "sdk-22222222",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "fedora" }),
      }),
      getLatestSucceededJobByPlanHash: () => ({
        id: "job_prior",
        status: "succeeded",
        registryId: "local-zot",
        repository: "session-aaaa",
        tag: "sdk-11111111",
        resultPayload: {
          ...createCompileResult({ id: "fedora" }),
          metadata: {
            defaultArtifactName: "sealant-workspace-fedora",
            notes: [],
            planHash: priorPlanHash,
            imageProbe: priorProbe,
          },
        },
        publishedReference: "127.0.0.1:5000/session-aaaa:sdk-11111111",
        publishedDigestReference: "127.0.0.1:5000/session-aaaa@sha256:prior",
        publishedDigest: "sha256:prior",
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const compileWorkspaceSpec = vi.fn(async () => createCompileResult({ id: "fedora" }));
    const planWorkspaceSpec = vi.fn(() => ({
      osFamily: "fedora" as const,
      imagePlan: {} as never,
      containerfile: "FROM fedora:41",
      planHash: priorPlanHash,
    }));
    const headManifest = vi.fn(async () => "sha256:prior");
    const registryClient = {
      publishOciImage: vi.fn(async () => {
        throw new Error("publishOciImage must not run on the reuse path");
      }),
      headManifest,
    } as unknown as RegistryClient;
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      const published = yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_reuse",
          compileWorkspaceSpec,
          planWorkspaceSpec,
          registryClient,
          runtimeAdapters: [runtimeAdapter],
        }),
      );

      expect(compileWorkspaceSpec).not.toHaveBeenCalled();
      expect(jobs.getLatestSucceededJobByPlanHash).toHaveBeenCalledWith({
        registryId: "local-zot",
        planHash: priorPlanHash,
      });
      // The liveness check HEADs the PRIOR publish's tag — the new job's tag was never pushed.
      expect(headManifest).toHaveBeenCalledWith("session-aaaa", "sdk-11111111");
      expect(published).toEqual(
        expect.objectContaining({
          digestReference: "127.0.0.1:5000/session-aaaa@sha256:prior",
        }),
      );
      expect(jobs.markJobSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "job_reuse",
          builderId: "fedora",
          publishedReference: "127.0.0.1:5000/session-aaaa:sdk-11111111",
          publishedDigest: "sha256:prior",
          resultPayload: expect.objectContaining({
            metadata: expect.objectContaining({
              planHash: priorPlanHash,
              imageProbe: priorProbe,
            }),
          }),
        }),
      );
      expect(runtimeAdapter.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          publishedImage: expect.objectContaining({ digest: "sha256:prior" }),
        }),
        // The launch hooks (onReady records the executor at readiness).
        expect.anything(),
      );
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("builds fresh when the registry tag no longer points at the recorded digest", () => {
    const priorPlanHash = "b".repeat(64);
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_stale_digest",
        runId: null,
        registryId: "local-zot",
        repository: "session-bbbb",
        tag: "sdk-22222222",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "fedora" }),
      }),
      getLatestSucceededJobByPlanHash: () => ({
        id: "job_prior",
        status: "succeeded",
        registryId: "local-zot",
        repository: "session-aaaa",
        tag: "sdk-11111111",
        resultPayload: {
          ...createCompileResult({ id: "fedora" }),
          metadata: { notes: [], planHash: priorPlanHash },
        },
        publishedReference: "127.0.0.1:5000/session-aaaa:sdk-11111111",
        publishedDigestReference: "127.0.0.1:5000/session-aaaa@sha256:prior",
        publishedDigest: "sha256:prior",
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const compileWorkspaceSpec = vi.fn(async () => createCompileResult({ id: "fedora" }));
    const planWorkspaceSpec = vi.fn(() => ({
      osFamily: "fedora" as const,
      imagePlan: {} as never,
      containerfile: "FROM fedora:41",
      planHash: priorPlanHash,
    }));
    const publishOciImage = vi.fn(async () => ({
      repository: "sealant/workspaces/demo",
      tag: "opencode",
      reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
      digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:fresh",
      digest: "sha256:fresh",
    }));
    const registryClient = {
      publishOciImage,
      // The tag was re-pushed (or GC'd) out-of-band: the recorded digest is gone.
      headManifest: vi.fn(async () => "sha256:overwritten"),
    } as unknown as RegistryClient;

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_stale_digest",
          compileWorkspaceSpec,
          planWorkspaceSpec,
          registryClient,
        }),
      );

      expect(compileWorkspaceSpec).toHaveBeenCalledTimes(1);
      expect(publishOciImage).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("publishes a fresh build under plan-keyed coordinates, not the create's name", () => {
    const planHash = "d".repeat(64);
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_plan_named",
        runId: null,
        registryId: "local-zot",
        repository: "wt-1ba1c80a-875b-4c0e-9b9c-2fd0d01f2fe0",
        tag: "sdk-44444444",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "fedora" }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const compileWorkspaceSpec = vi.fn(async () => createCompileResult({ id: "fedora" }));
    const planWorkspaceSpec = vi.fn(() => ({
      osFamily: "fedora" as const,
      imagePlan: {} as never,
      containerfile: "FROM fedora:41",
      planHash,
    }));
    const registryClient = successRegistryClient();

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_plan_named",
          compileWorkspaceSpec,
          planWorkspaceSpec,
          registryClient,
        }),
      );

      // The worktree's name never reaches the registry: the plan does.
      expect(registryClient.publishOciImage).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: "sealant-workspace-fedora",
          tag: "plan-dddddddddddd",
        }),
      );
      expect(planWorkspaceSpec).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("HEADs the tag a prior job actually published, not the name it was asked for", () => {
    const priorPlanHash = "e".repeat(64);
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_reuse_plan",
        runId: null,
        registryId: "local-zot",
        repository: "wt-2222",
        tag: "sdk-22222222",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "fedora" }),
      }),
      getLatestSucceededJobByPlanHash: () => ({
        id: "job_prior_plan",
        status: "succeeded",
        registryId: "local-zot",
        // What the client asked for…
        repository: "wt-1111",
        tag: "sdk-11111111",
        resultPayload: {
          ...createCompileResult({ id: "fedora" }),
          metadata: {
            defaultArtifactName: "sealant-workspace-fedora",
            notes: [],
            planHash: priorPlanHash,
          },
        },
        // …and where the worker put it.
        publishedReference: "127.0.0.1:5000/sealant-workspace-fedora:plan-eeeeeeeeeeee",
        publishedDigestReference: "127.0.0.1:5000/sealant-workspace-fedora@sha256:prior",
        publishedDigest: "sha256:prior",
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const compileWorkspaceSpec = vi.fn(async () => createCompileResult({ id: "fedora" }));
    const planWorkspaceSpec = vi.fn(() => ({
      osFamily: "fedora" as const,
      imagePlan: {} as never,
      containerfile: "FROM fedora:41",
      planHash: priorPlanHash,
    }));
    const headManifest = vi.fn(async () => "sha256:prior");
    const registryClient = {
      publishOciImage: vi.fn(async () => {
        throw new Error("publishOciImage must not run on the reuse path");
      }),
      headManifest,
    } as unknown as RegistryClient;

    return Effect.gen(function* () {
      const published = yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_reuse_plan",
          compileWorkspaceSpec,
          planWorkspaceSpec,
          registryClient,
        }),
      );

      expect(headManifest).toHaveBeenCalledWith("sealant-workspace-fedora", "plan-eeeeeeeeeeee");
      expect(compileWorkspaceSpec).not.toHaveBeenCalled();
      expect(published).toEqual(
        expect.objectContaining({
          repository: "sealant-workspace-fedora",
          tag: "plan-eeeeeeeeeeee",
          reference: "127.0.0.1:5000/sealant-workspace-fedora:plan-eeeeeeeeeeee",
        }),
      );
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("builds fresh when no prior published plan hash exists", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_no_prior",
        runId: null,
        registryId: "local-zot",
        repository: "session-bbbb",
        tag: "sdk-33333333",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "fedora" }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const compileWorkspaceSpec = vi.fn(async () => createCompileResult({ id: "fedora" }));
    const planWorkspaceSpec = vi.fn(() => ({
      osFamily: "fedora" as const,
      imagePlan: {} as never,
      containerfile: "FROM fedora:41",
      planHash: "c".repeat(64),
    }));

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_no_prior",
          compileWorkspaceSpec,
          planWorkspaceSpec,
        }),
      );

      expect(planWorkspaceSpec).toHaveBeenCalledTimes(1);
      expect(compileWorkspaceSpec).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("resolves connected-account refs into launch credential env + files", () => {
    const codexAuthJson = JSON.stringify({ tokens: { refresh_token: "rt" } });
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_credentials",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          osFamily: "nix",
          credentialRefs: [
            { provider: "claude", ref: "connected-account:cacc_claude" },
            { provider: "codex", ref: "connected-account:cacc_codex" },
          ],
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const accountRows = [
      connectedAccountStub({
        id: "cacc_claude",
        provider: "claude",
        payload: { token: "sk-ant-oat01-test" },
      }),
      {
        ...connectedAccountStub({
          id: "cacc_codex",
          provider: "codex",
          payload: { authJson: codexAuthJson },
        }),
        kind: "auth-json",
      },
    ];
    const connectedAccounts = {
      getById: vi.fn((id: string) =>
        Effect.succeed(accountRows.find((account) => account.id === id)),
      ),
      updateSyncState: vi.fn((_input: unknown) => Effect.succeed(accountRows[0])),
    };
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_credentials",
          runtimeAdapters: [runtimeAdapter],
          credentialCipher: fakeCredentialCipher,
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );

      expect(runtimeAdapter.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" },
          credentialFiles: [
            {
              path: "$HOME/.codex/auth.json",
              contentBase64: Buffer.from(codexAuthJsonCopy(codexAuthJson), "utf8").toString(
                "base64",
              ),
              mode: "600",
            },
          ],
        }),
        // The launch hooks (onReady records the executor at readiness).
        expect.anything(),
      );
      expect(connectedAccounts.updateSyncState).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts, connectedAccounts })));
  });

  it.effect("injects a session-file claude account as a file, never the env var", () => {
    const claudeCredentialsJson = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-session", expiresAt: 1_750_000_000_000 },
    });
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_claude_session",
        // A real run id so the launch records its runtime instance row (asserted below).
        runId: "run_claude_session",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          osFamily: "nix",
          credentialRefs: [{ provider: "claude", ref: "connected-account:cacc_claude_session" }],
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const accountRows = [
      {
        ...connectedAccountStub({
          id: "cacc_claude_session",
          provider: "claude",
          payload: { credentialsJson: claudeCredentialsJson },
        }),
        kind: "credentials-json",
      },
    ];
    const connectedAccounts = {
      getById: vi.fn((id: string) =>
        Effect.succeed(accountRows.find((account) => account.id === id)),
      ),
      updateSyncState: vi.fn((_input: unknown) => Effect.succeed(accountRows[0])),
    };
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_claude_session",
          runtimeAdapters: [runtimeAdapter],
          credentialCipher: fakeCredentialCipher,
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );

      expect(runtimeAdapter.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          credentialFiles: [
            {
              path: "$HOME/.claude/.credentials.json",
              contentBase64: Buffer.from(
                claudeCredentialsCopy(claudeCredentialsJson),
                "utf8",
              ).toString("base64"),
              mode: "600",
            },
          ],
        }),
        // The launch hooks (onReady records the executor at readiness).
        expect.anything(),
      );
      // No env injection at all for the session-file shape (empty env is omitted from launch).
      expect(runtimeAdapter.launch).toHaveBeenCalledWith(
        expect.not.objectContaining({ credentialEnv: expect.anything() }),
        // The launch hooks (onReady records the executor at readiness).
        expect.anything(),
      );
      // The launch-time injection shape is persisted on the runtime instance row so the post-run
      // sync-back can trust what THIS workspace was actually seeded with.
      expect(runtimeInstances.upsertRuntimeInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          launchCredentialInjections: [
            {
              provider: "claude",
              connectedAccountId: "cacc_claude_session",
              injection: "file",
              copy: true,
            },
          ],
        }),
      );
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts, connectedAccounts })));
  });

  it.effect(
    "writes a credentialsHome launch's logins into the home and records it as the owner's",
    () => {
      const home = { path: "/home/m4lice000", uid: 40001, gid: 40000 };
      const base = createWorkspaceBuildSpec({
        osFamily: "nix",
        credentialRefs: [
          { provider: "claude", ref: "connected-account:cacc_claude" },
          { provider: "github", ref: "connected-account:cacc_github" },
        ],
      });
      const jobs = workspaceBuildJobRepoStub({
        claimJobById: () => ({
          id: "job_credentials_home",
          runId: "run_credentials_home",
          repository: "sealant/workspaces/demo",
          tag: "opencode",
          requestPayload: { ...base, runtime: { ...base.runtime, credentialsHome: home } },
        }),
      });
      const attempts = {
        ...workspaceAttemptRepoStub(),
        getAttemptById: vi.fn((_id: string) => Effect.succeed({ ownerUserId: "usr_alice" })),
      };
      const runtimeInstances = workspaceRuntimeInstanceRepoStub();
      const accountRows = [
        connectedAccountStub({
          id: "cacc_claude",
          provider: "claude",
          payload: { token: "sk-ant-oat01-alice" },
        }),
        {
          ...connectedAccountStub({
            id: "cacc_github",
            provider: "github",
            payload: { token: "gho_alice" },
          }),
          kind: "gh-cli-token",
        },
      ];
      const connectedAccounts = {
        getById: vi.fn((id: string) =>
          Effect.succeed(accountRows.find((account) => account.id === id)),
        ),
        updateSyncState: vi.fn((_input: unknown) => Effect.succeed(accountRows[0])),
      };
      const runtimeAdapter = createRuntimeAdapterStub("docker", {
        launch: vi.fn(async () => ({
          adapter: "docker" as const,
          resourceId: "resource_123",
          reference: "sealant-resource",
          status: "ready" as const,
        })),
      });
      const homes = makeInMemoryCredentialHomes(() => []);

      return Effect.gen(function* () {
        yield* processWorkspaceBuildJobEffect(
          baseOptions({
            jobId: "job_credentials_home",
            runtimeAdapters: [runtimeAdapter],
            credentialCipher: fakeCredentialCipher,
            compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
          }),
        );

        // Every login is a file in the home, owned by its owner; nothing rides the environment.
        expect(runtimeAdapter.launch).toHaveBeenCalledWith(
          expect.objectContaining({
            credentialFiles: [
              expect.objectContaining({ path: "/home/m4lice000/.claude/.credentials.json", home }),
              expect.objectContaining({ path: "/home/m4lice000/.config/gh/hosts.yml", home }),
            ],
          }),
          expect.anything(),
        );
        expect(runtimeAdapter.launch).toHaveBeenCalledWith(
          expect.not.objectContaining({ credentialEnv: expect.anything() }),
          expect.anything(),
        );
        // The home is the owner's, as a put would hold it: refreshes reach it through the record.
        expect(homes.rows.get("run_credentials_home /home/m4lice000")).toMatchObject({
          onBehalfOfUserId: "usr_alice",
          accounts: [
            { provider: "claude", connectedAccountId: "cacc_claude" },
            { provider: "github", connectedAccountId: "cacc_github" },
          ],
        });
      }).pipe(
        Effect.provide(
          Layer.merge(
            provideRepos({ jobs, runtimeInstances, attempts, connectedAccounts }),
            Layer.succeed(WorkspaceCredentialHomeRepo, homes.service),
          ),
        ),
      );
    },
  );

  it.effect("fails the launch when refs are present but no credentials key is configured", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_no_credentials_key",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          osFamily: "nix",
          credentialRefs: [{ provider: "claude", ref: "connected-account:cacc_claude" }],
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      // No credentialCipher option -> the resolver must fail the job visibly.
      const error = yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_no_credentials_key",
          runtimeAdapters: [runtimeAdapter],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkspaceBuildJobProcessingError);
      expect(error.errorCode).toBe("credentials-key-unconfigured");
      expect(runtimeAdapter.launch).not.toHaveBeenCalled();
      // Phase B failure: the image build stays succeeded.
      expect(jobs.markJobSucceeded).toHaveBeenCalledTimes(1);
      expect(jobs.markJobFailed).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("mints GitHub installation token auth right before runtime launch", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_github_runtime_auth",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          url: "https://github.com/sealant-ops/core.git",
          authRef: "github-installation-repository:gh_installation_repo_1",
          osFamily: "nix",
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const gitHubSourceIntegration = githubSourceIntegrationStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_github_runtime_auth",
          runtimeAdapters: [runtimeAdapter],
          gitHubSourceIntegration,
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );

      expect(gitHubSourceIntegration.createInstallationAccessToken).toHaveBeenCalledWith("1001");
      expect(runtimeAdapter.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceCloneAuth: {
            type: "http-token",
            username: "x-access-token",
            token: "github-installation-token",
          },
        }),
        // The launch hooks (onReady records the executor at readiness).
        expect.anything(),
      );
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });

  it.effect("injects dotfiles GitHub token env for runtime-applied config repos", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_dotfiles_runtime_auth",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
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
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const gitHubSourceIntegration = githubSourceIntegrationStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_dotfiles_runtime_auth",
          runtimeAdapters: [runtimeAdapter],
          gitHubSourceIntegration,
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );

      expect(gitHubSourceIntegration.createInstallationAccessToken).toHaveBeenCalledWith("1001");
      // Resolved tokens ride the TRANSIENT platformEnv launch field, never a blueprint env map:
      // the blueprint is the persisted restart source and must stay free of resolved secrets.
      expect(runtimeAdapter.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          platformEnv: {
            SEALANT_DOTFILES_HTTP_USERNAME: "x-access-token",
            SEALANT_DOTFILES_HTTP_TOKEN: "github-installation-token",
          },
        }),
        // The launch hooks (onReady records the executor at readiness).
        expect.anything(),
      );
      expect(runtimeAdapter.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprint: expect.objectContaining({
            runtime: expect.objectContaining({
              env: expect.not.objectContaining({
                SEALANT_DOTFILES_HTTP_TOKEN: expect.anything(),
              }),
            }),
          }),
        }),
        // The launch hooks (onReady records the executor at readiness).
        expect.anything(),
      );
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });

  it.effect("hands the adapter the caller userEnv unchanged through the job payload parse", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_user_env",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          osFamily: "nix",
          userEnv: { APP_MODE: "review", EMPTY_VALUE: "" },
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_user_env",
          runtimeAdapters: [runtimeAdapter],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );

      expect(runtimeAdapter.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprint: expect.objectContaining({
            runtime: expect.objectContaining({
              userEnv: { APP_MODE: "review", EMPTY_VALUE: "" },
            }),
          }),
        }),
        // The launch hooks (onReady records the executor at readiness).
        expect.anything(),
      );
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });

  it.effect(
    "unseals secretEnv, stages a 0600 boot file, removes it at readiness, clears the row",
    () => {
      const secretEnv = { DATABASE_URL: "postgres://u:hunter2@h/db", STRIPE_API_KEY: "sk_live_x" };
      const jobs = workspaceBuildJobRepoStub({
        claimJobById: () => ({
          id: "job_secret_env",
          runId: "run_secret_env",
          repository: "sealant/workspaces/demo",
          tag: "opencode",
          requestPayload: createWorkspaceBuildSpec({ osFamily: "nix" }),
          secretEnvSealed: `sealed:${JSON.stringify(secretEnv)}`,
        }),
      });
      const attempts = workspaceAttemptRepoStub();
      const runtimeInstances = workspaceRuntimeInstanceRepoStub();
      const installations = githubInstallationRepoStub();
      const installationRepositories = githubInstallationRepositoryCacheStub();
      let stagedContents: string | undefined;
      let stagedMode: number | undefined;
      let stagedFileWhileLaunching: string | undefined;
      let launchedBlueprintJson: string | undefined;
      const runtimeAdapter = createRuntimeAdapterStub("docker", {
        launch: vi.fn(async (input) => {
          launchedBlueprintJson = JSON.stringify(input.blueprint);
          // The file must exist, 0600, with exactly the unsealed map, WHILE the launch runs.
          const dir = input.secretEnvDir;
          if (dir !== undefined) {
            stagedFileWhileLaunching = join(dir, "env.json");
            stagedContents = await readFile(stagedFileWhileLaunching, "utf8");
            stagedMode = (await stat(stagedFileWhileLaunching)).mode & 0o777;
          }
          return {
            adapter: "docker" as const,
            resourceId: "resource_secret",
            reference: "sealant-secret",
            status: "ready" as const,
          };
        }),
      });

      return Effect.gen(function* () {
        yield* processWorkspaceBuildJobEffect(
          baseOptions({
            jobId: "job_secret_env",
            runtimeAdapters: [runtimeAdapter],
            credentialCipher: fakeCredentialCipher,
            compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
          }),
        );

        expect(runtimeAdapter.launch).toHaveBeenCalledWith(
          expect.objectContaining({
            secretEnvDir: expect.stringContaining("sealant-secret-env-run_secret_env"),
          }),
          // The launch hooks (onReady records the executor at readiness).
          expect.anything(),
        );
        expect(stagedContents).toBe(JSON.stringify(secretEnv));
        expect(stagedMode).toBe(0o600);
        // Ready => the daemon consumed it; the host copy is gone.
        expect(stagedFileWhileLaunching).toBeDefined();
        expect(existsSync(stagedFileWhileLaunching ?? "")).toBe(false);
        // And the sealed row is cleared once the launch phase settles.
        expect(jobs.clearSecretEnv).toHaveBeenCalledWith("job_secret_env");
        // The blueprint handed to the adapter never carries the secrets.
        expect(launchedBlueprintJson).toBeDefined();
        expect(launchedBlueprintJson).not.toContain("hunter2");
      }).pipe(
        Effect.provide(
          provideRepos({
            jobs,
            runtimeInstances,
            attempts,
            installations,
            installationRepositories,
          }),
        ),
      );
    },
  );

  it.effect("fails the launch loudly when a sealed secretEnv arrives without a cipher", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_secret_env_no_cipher",
        runId: "run_secret_env_no_cipher",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "nix" }),
        secretEnvSealed: "sealed:{}",
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        processWorkspaceBuildJobEffect(
          baseOptions({
            jobId: "job_secret_env_no_cipher",
            runtimeAdapters: [runtimeAdapter],
            // No credentialCipher option -> misconfiguration, not a silent launch without secrets.
            compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(runtimeAdapter.launch).not.toHaveBeenCalled();
      // Even a failed launch phase clears the sealed row.
      expect(jobs.clearSecretEnv).toHaveBeenCalledWith("job_secret_env_no_cipher");
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });

  it.effect("rejects a sealed secretEnv that fails the policy at the last hop", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_secret_env_bad",
        runId: "run_secret_env_bad",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "nix" }),
        secretEnvSealed: `sealed:${JSON.stringify({ GITHUB_TOKEN: "ghp_smuggled" })}`,
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        processWorkspaceBuildJobEffect(
          baseOptions({
            jobId: "job_secret_env_bad",
            runtimeAdapters: [runtimeAdapter],
            credentialCipher: fakeCredentialCipher,
            compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("GITHUB_TOKEN");
        expect(String(result.failure)).not.toContain("ghp_smuggled");
      }
      expect(runtimeAdapter.launch).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });

  describe("a capture launch that fails after its executor became ready", () => {
    const captureJob = (id: string) =>
      workspaceBuildJobRepoStub({
        claimJobById: () => ({
          id,
          runId: `run_${id}`,
          repository: "sealant/workspaces/demo",
          tag: "opencode",
          requestPayload: {
            ...createWorkspaceBuildSpec({ osFamily: "nix" }),
            sources: {
              workspace: { kind: "capture", endpoint: "https://mend.example.com/session/s1" },
              inputs: [],
              mounts: [],
            },
          },
          secretEnvSealed: SEALED_CAPTURE_TOKEN,
        }),
      });
    const identity = {
      adapter: "docker" as const,
      resourceId: "container-retained",
      reference: "sealant-retained",
      endpoint: "unix:///run/sealant/sockets/retained/control.sock",
    };

    it.effect(
      "records the source kind, the executor's identity at readiness, and a retained failure",
      () => {
        const jobs = captureJob("job_retained");
        const attempts = workspaceAttemptRepoStub();
        const runtimeInstances = workspaceRuntimeInstanceRepoStub();
        const runtimeAdapter = createRuntimeAdapterStub("docker", {
          launch: vi.fn(async (_input, hooks) => {
            await hooks?.onReady?.(identity);
            throw new LaunchRetainedError(identity, new Error("credential file write failed"));
          }),
        });

        return Effect.gen(function* () {
          const error = yield* processWorkspaceBuildJobEffect(
            baseOptions({
              jobId: "job_retained",
              credentialCipher: fakeCredentialCipher,
              runtimeAdapters: [runtimeAdapter],
              compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
            }),
          ).pipe(Effect.flip);

          expect(error.errorCode).toBe(LAUNCH_RETAINED_ERROR_CODE);
          const writes = runtimeInstances.upsertRuntimeInstance.mock.calls.map(([input]) => input);
          expect(writes).toEqual([
            {
              runId: "run_job_retained",
              status: "pending",
              sourceKind: "capture",
              launchOwner: expect.stringMatching(/^worker-test:job_retained:/),
              // The launch's own lease (2 min), not the build job's: a worker lost mid-launch
              // leaves an executor that is adopted within minutes (e2e 5: the job lease is 15).
              launchLeaseMs: DEFAULT_LAUNCH_LEASE_MS,
              // No image plan here: the daemon's build, and so its recovery boot, is unknown.
              daemonRecoveryBoot: null,
            },
            expect.objectContaining({
              status: "pending",
              ...identity,
              sourceKind: "capture",
              fenceLaunchOwner: expect.stringMatching(/^worker-test:job_retained:/),
            }),
            expect.objectContaining({
              runId: "run_job_retained",
              status: "failed",
              errorCode: LAUNCH_RETAINED_ERROR_CODE,
              ...identity,
            }),
          ]);
          // Still running: no finish instant on the retained row.
          expect(writes[2]).not.toHaveProperty("finishedAt");
          expect(attempts.markAttemptFailed).toHaveBeenCalledWith({ id: "run_job_retained" });
        }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
      },
    );

    it.effect(
      "records a launched capture executor retained when its ready row cannot be written",
      () => {
        const jobs = captureJob("job_unrecorded");
        const attempts = workspaceAttemptRepoStub();
        const runtimeInstances = {
          upsertRuntimeInstance: vi.fn(
            (input: { readonly status: string }): Effect.Effect<object, Error> =>
              input.status === "ready"
                ? Effect.fail(new Error("connection terminated"))
                : Effect.succeed({}),
          ),
          renewLaunchLease: vi.fn(() => Effect.succeed(true)),
        };
        const runtimeAdapter = createRuntimeAdapterStub("docker", {
          launch: vi.fn(async () => ({ ...identity, status: "ready" as const })),
        });

        return Effect.gen(function* () {
          const error = yield* processWorkspaceBuildJobEffect(
            baseOptions({
              jobId: "job_unrecorded",
              credentialCipher: fakeCredentialCipher,
              runtimeAdapters: [runtimeAdapter],
              compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
            }),
          ).pipe(Effect.flip);

          expect(error.errorCode).toBe(LAUNCH_RETAINED_ERROR_CODE);
          expect(runtimeInstances.upsertRuntimeInstance).toHaveBeenLastCalledWith(
            expect.objectContaining({
              status: "failed",
              errorCode: LAUNCH_RETAINED_ERROR_CODE,
              resourceId: "container-retained",
            }),
          );
          expect(runtimeAdapter.stop).not.toHaveBeenCalled();
        }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
      },
    );
  });

  it.effect("passes the platform-owned capture token through the sealed channel", () => {
    // The control plane seals SEALANT_CAPTURE_TOKEN beside the caller's map (sealantd ADR-0015);
    // the caller policy still governs the caller's entries, and the token reaches the boot file.
    const sealed = { MEND_SESSION_TOKEN: "mst_1", SEALANT_CAPTURE_TOKEN: "mst_1" };
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_capture_token",
        runId: "run_capture_token",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: {
          ...createWorkspaceBuildSpec({ osFamily: "nix" }),
          sources: {
            workspace: {
              kind: "capture",
              endpoint: "https://mend.example.com/session/s1",
              harnessHome: "/workspace/harness-home",
            },
            inputs: [],
            mounts: [],
          },
        },
        secretEnvSealed: `sealed:${JSON.stringify(sealed)}`,
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    let stagedContents: string | undefined;
    const storedTokens: Array<{ runId: string; sealed: string }> = [];
    const runtimeAdapter = createRuntimeAdapterStub("docker", {
      launch: vi.fn(async (input) => {
        expect(input.blueprint.sources.workspace).toEqual({
          kind: "capture",
          endpoint: "https://mend.example.com/session/s1",
          harnessHome: "/workspace/harness-home",
        });
        if (input.secretEnvDir !== undefined) {
          stagedContents = await readFile(join(input.secretEnvDir, "env.json"), "utf8");
        }
        return {
          adapter: "docker" as const,
          resourceId: "resource_capture",
          reference: "sealant-capture",
          status: "ready" as const,
        };
      }),
    });

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_capture_token",
          runtimeAdapters: [runtimeAdapter],
          credentialCipher: fakeCredentialCipher,
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );
      expect(stagedContents).toBeDefined();
      expect(JSON.parse(stagedContents ?? "{}")).toEqual(sealed);
      // Only the capture token is kept, sealed, for a later recovery of this executor.
      expect(storedTokens).toEqual([
        {
          runId: "run_capture_token",
          sealed: `sealed:${JSON.stringify({ SEALANT_CAPTURE_TOKEN: "mst_1" })}`,
        },
      ]);
    }).pipe(
      Effect.provide(
        provideRepos({
          jobs,
          runtimeInstances,
          attempts,
          installations,
          installationRepositories,
          captureDrains: {
            storeCaptureToken: (input: { runId: string; sealed: string }) =>
              Effect.sync(() => {
                storedTokens.push(input);
              }),
          },
        }),
      ),
    );
  });

  describe("a capture launch whose recovery credential cannot be kept (review 5 #4)", () => {
    const captureTokenJob = () =>
      workspaceBuildJobRepoStub({
        claimJobById: () => ({
          id: "job_token_unkept",
          runId: "run_token_unkept",
          repository: "sealant/workspaces/demo",
          tag: "opencode",
          requestPayload: {
            ...createWorkspaceBuildSpec({ osFamily: "nix" }),
            sources: {
              workspace: { kind: "capture", endpoint: "https://mend.example.com/session/s1" },
              inputs: [],
              mounts: [],
            },
          },
          secretEnvSealed: `sealed:${JSON.stringify({ MEND_SESSION_TOKEN: "mst_1", SEALANT_CAPTURE_TOKEN: "mst_1" })}`,
        }),
      });

    it.effect("is never launched, and its sealed job secret is kept", () => {
      const jobs = captureTokenJob();
      const attempts = workspaceAttemptRepoStub();
      const runtimeInstances = workspaceRuntimeInstanceRepoStub();
      const stager = {
        stage: vi.fn(async () => ({})),
        removeSecretEnv: vi.fn(async () => undefined),
        removeAll: vi.fn(async () => undefined),
      };
      const storeCaptureToken = vi.fn(() =>
        Effect.fail(new Error("injected transient write failure")),
      );
      const runtimeAdapter = createRuntimeAdapterStub("docker");

      return Effect.gen(function* () {
        const error = yield* processWorkspaceBuildJobEffect(
          baseOptions({
            jobId: "job_token_unkept",
            runtimeAdapters: [runtimeAdapter],
            credentialCipher: fakeCredentialCipher,
            compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
            launchMaterialStager: stager,
            recoveryCredentialRetry: { times: 2, spacingMs: 0 },
          }),
        ).pipe(Effect.flip);

        expect(error.message).toContain("recovery credential could not be kept");
        expect(error.message).toContain("injected transient write failure");
        // Retried before giving up: the first write and two more.
        expect(storeCaptureToken).toHaveBeenCalledTimes(3);
        expect(stager.stage).not.toHaveBeenCalled();
        expect(runtimeAdapter.launch).not.toHaveBeenCalled();
        // The sealed job secret is the only durable copy of the credential: not cleared.
        expect(jobs.clearSecretEnv).not.toHaveBeenCalled();
        expect(attempts.markAttemptFailed).toHaveBeenCalledWith({ id: "run_token_unkept" });
      }).pipe(
        Effect.provide(
          provideRepos({ jobs, runtimeInstances, attempts, captureDrains: { storeCaptureToken } }),
        ),
      );
    });

    it.effect("launches once a retried write lands", () => {
      const jobs = captureTokenJob();
      const attempts = workspaceAttemptRepoStub();
      const runtimeInstances = workspaceRuntimeInstanceRepoStub();
      let calls = 0;
      const storeCaptureToken = vi.fn(() =>
        Effect.suspend(() => {
          calls += 1;
          return calls === 1 ? Effect.fail(new Error("transient")) : Effect.void;
        }),
      );
      const runtimeAdapter = createRuntimeAdapterStub("docker");

      return Effect.gen(function* () {
        yield* processWorkspaceBuildJobEffect(
          baseOptions({
            jobId: "job_token_unkept",
            runtimeAdapters: [runtimeAdapter],
            credentialCipher: fakeCredentialCipher,
            compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
            recoveryCredentialRetry: { times: 2, spacingMs: 0 },
          }),
        );
        expect(storeCaptureToken).toHaveBeenCalledTimes(2);
        expect(runtimeAdapter.launch).toHaveBeenCalledOnce();
        expect(jobs.clearSecretEnv).toHaveBeenCalledWith("job_token_unkept");
      }).pipe(
        Effect.provide(
          provideRepos({ jobs, runtimeInstances, attempts, captureDrains: { storeCaptureToken } }),
        ),
      );
    });

    it.effect("is never launched without a capture token to keep", () => {
      const jobs = workspaceBuildJobRepoStub({
        claimJobById: () => ({
          id: "job_no_token",
          runId: "run_no_token",
          repository: "sealant/workspaces/demo",
          tag: "opencode",
          requestPayload: {
            ...createWorkspaceBuildSpec({ osFamily: "nix" }),
            sources: {
              workspace: { kind: "capture", endpoint: "https://mend.example.com/session/s1" },
              inputs: [],
              mounts: [],
            },
          },
        }),
      });
      const attempts = workspaceAttemptRepoStub();
      const runtimeInstances = workspaceRuntimeInstanceRepoStub();
      const runtimeAdapter = createRuntimeAdapterStub("docker");
      return Effect.gen(function* () {
        const error = yield* processWorkspaceBuildJobEffect(
          baseOptions({
            jobId: "job_no_token",
            runtimeAdapters: [runtimeAdapter],
            credentialCipher: fakeCredentialCipher,
            compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
          }),
        ).pipe(Effect.flip);
        expect(error.message).toContain("carries no capture token");
        expect(runtimeAdapter.launch).not.toHaveBeenCalled();
      }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
    });
  });

  it.effect("still refuses other platform-prefixed names in the sealed channel", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_capture_token_bad",
        runId: "run_capture_token_bad",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "nix" }),
        secretEnvSealed: `sealed:${JSON.stringify({ SEALANT_WORKSPACE_SOURCE: "mount" })}`,
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        processWorkspaceBuildJobEffect(
          baseOptions({
            jobId: "job_capture_token_bad",
            runtimeAdapters: [runtimeAdapter],
            credentialCipher: fakeCredentialCipher,
            compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("SEALANT_WORKSPACE_SOURCE");
      }
      expect(runtimeAdapter.launch).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });

  it.effect("stages dotfiles archives and hands the adapter the staging dir", () => {
    const archiveData = Buffer.from("not-a-real-tarball").toString("base64");
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_dotfiles_archives",
        runId: "run_dotfiles_archives",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          url: "https://github.com/example/repo.git",
          osFamily: "nix",
          dotfilesArchives: [
            { data: archiveData, manager: "copy", bootstrap: false },
            { data: archiveData, bootstrap: true },
          ],
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_dotfiles_archives",
          runtimeAdapters: [runtimeAdapter],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );

      expect(runtimeAdapter.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          dotfilesArchiveDir: expect.stringContaining("sealant-dotfiles-run_dotfiles_archives"),
        }),
        // The launch hooks (onReady records the executor at readiness).
        expect.anything(),
      );
      const launchMock = vi.mocked(runtimeAdapter.launch);
      const launchInput = launchMock.mock.calls[0]?.[0];
      const stagedDir = launchInput?.dotfilesArchiveDir;
      expect(stagedDir).toBeDefined();
      if (stagedDir !== undefined) {
        const manifest = JSON.parse(readFileSync(join(stagedDir, "manifest.json"), "utf8")) as {
          archives: Array<Record<string, unknown>>;
        };
        expect(manifest.archives).toEqual([
          { file: "0.tar.gz", manager: "copy", bootstrap: false },
          { file: "1.tar.gz", bootstrap: true },
        ]);
        expect(readFileSync(join(stagedDir, "0.tar.gz")).toString()).toBe("not-a-real-tarball");
        rmSync(stagedDir, { recursive: true, force: true });
      }
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });

  it("stages under the control-socket shared dir inside the compose stack", () => {
    // `docker run -v` resolves on the daemon's host: only the control-socket dir is mounted at
    // the same path in the worker container and on the host, so staging must go through it.
    const previous = process.env["WORKSPACE_CONTROL_SOCKET_HOST_DIR"];
    try {
      process.env["WORKSPACE_CONTROL_SOCKET_HOST_DIR"] = "/run/sealant/sockets";
      expect(dotfilesStagingRoot()).toBe("/run/sealant/sockets/_dotfiles");
      delete process.env["WORKSPACE_CONTROL_SOCKET_HOST_DIR"];
      expect(dotfilesStagingRoot()).toBe(tmpdir());
    } finally {
      if (previous === undefined) delete process.env["WORKSPACE_CONTROL_SOCKET_HOST_DIR"];
      else process.env["WORKSPACE_CONTROL_SOCKET_HOST_DIR"] = previous;
    }
  });

  it.effect("removes all staged launch material exactly once when launch fails", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_launch_cleanup",
        runId: "run_launch_cleanup",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "nix" }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker", {
      launch: vi.fn(async () => {
        throw new Error("launch failed");
      }),
    });
    const cleanupEvents: string[] = [];

    return Effect.gen(function* () {
      yield* Effect.result(
        processWorkspaceBuildJobEffect(
          baseOptions({
            jobId: "job_launch_cleanup",
            runtimeAdapters: [runtimeAdapter],
            compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
            launchMaterialStager: {
              stage: async () => ({
                dotfilesArchiveDir: "/staging/dotfiles",
                secretEnvDir: "/staging/secrets",
              }),
              removeSecretEnv: async () => {
                cleanupEvents.push("secret");
              },
              removeAll: async () => {
                cleanupEvents.push("all");
              },
            },
          }),
        ),
      );

      expect(cleanupEvents).toEqual(["all"]);
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });

  it.effect("stages nothing when the dotfiles apply is disabled", () => {
    const archiveData = Buffer.from("unused").toString("base64");
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_dotfiles_archives_disabled",
        runId: "run_archives_disabled",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          url: "https://github.com/example/repo.git",
          osFamily: "nix",
          applyDotfiles: false,
          dotfilesArchives: [{ data: archiveData, bootstrap: true }],
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_dotfiles_archives_disabled",
          runtimeAdapters: [runtimeAdapter],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );

      expect(runtimeAdapter.launch).toHaveBeenCalledWith(
        expect.not.objectContaining({ dotfilesArchiveDir: expect.anything() }),
        // The launch hooks (onReady records the executor at readiness).
        expect.anything(),
      );
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });

  it.effect("mints no dotfiles token when the apply is disabled", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_dotfiles_disabled",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          url: "https://github.com/example/repo.git",
          osFamily: "nix",
          applyDotfiles: false,
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
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const gitHubSourceIntegration = githubSourceIntegrationStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_dotfiles_disabled",
          runtimeAdapters: [runtimeAdapter],
          gitHubSourceIntegration,
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );

      // The image carries no SEALANT_DOTFILES_RUNTIME_APPLY when the apply is off, so a minted
      // token would sit unused in the container env — the worker must not create one.
      expect(gitHubSourceIntegration.createInstallationAccessToken).not.toHaveBeenCalled();
      expect(runtimeAdapter.launch).toHaveBeenCalledWith(
        expect.not.objectContaining({ platformEnv: expect.anything() }),
        // The launch hooks (onReady records the executor at readiness).
        expect.anything(),
      );
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });

  it.effect("uses startup and SSH values from the request spec", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_defaults",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "nix" }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_defaults",
          runtimeAdapters: [runtimeAdapter],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );

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
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("respects explicit startup and SSH settings from spec", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_explicit",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          osFamily: "nix",
          sshEnabled: false,
          startupCommand: "pnpm dev",
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_explicit",
          runtimeAdapters: [runtimeAdapter],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );

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
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("claims, compiles, publishes, and marks a job as succeeded", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_123",
        runId: "run_123",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "nix" }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const runtimeAdapter = createRuntimeAdapterStub("docker");

    return Effect.gen(function* () {
      const result = yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_123",
          runtimeAdapters: [runtimeAdapter],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      );

      expect(result?.digest).toBe("sha256:test");
      expect(jobs.claimJobById).toHaveBeenCalledWith({
        id: "job_123",
        workerId: "worker-test",
        leaseDurationMs: 60000,
      });
      expect(jobs.markJobSucceeded).toHaveBeenCalled();
      expect(jobs.markJobFailed).not.toHaveBeenCalled();
      expect(attempts.markAttemptRunning).toHaveBeenCalledWith({ id: "run_123" });
      expect(attempts.markAttemptSucceeded).toHaveBeenCalledWith({ id: "run_123" });
      expect(attempts.markAttemptFailed).not.toHaveBeenCalled();
      expect(runtimeInstances.upsertRuntimeInstance).toHaveBeenCalledTimes(2);
      expect(runtimeAdapter.launch).toHaveBeenCalledTimes(1);
      expect(jobs.markJobSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({
          resultPayload: expect.objectContaining({
            builder: expect.any(Object),
          }),
        }),
      );
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("marks a job as failed when compile or publish throws", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_123",
        runId: "run_123",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "nix" }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();

    return Effect.gen(function* () {
      const error = yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_123",
          registryClient: {} as RegistryClient,
          compileWorkspaceSpec: vi.fn(async () => {
            throw new Error("compile exploded");
          }),
        }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkspaceBuildJobProcessingError);
      expect(error.message).toContain("compile exploded");
      expect(jobs.markJobFailed).toHaveBeenCalledWith({
        id: "job_123",
        // Fenced by the claim the build ran under (review 6 #8).
        claim: expect.objectContaining({ workerId: expect.any(String) }),
        errorMessage: "compile exploded",
      });
      expect(attempts.markAttemptFailed).toHaveBeenCalledWith({ id: "run_123" });
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("marks a job as failed when compilation rejects unsupported target OS", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_123",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "fedora" }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();

    return Effect.gen(function* () {
      const error = yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_123",
          registryClient: {} as RegistryClient,
          compileWorkspaceSpec: vi.fn(async () => {
            const failure = new Error(
              "No compiler is available for target.os.family 'fedora'.",
            ) as Error & { code: string };
            failure.code = "unsupported-os";
            throw failure;
          }),
        }),
      ).pipe(Effect.flip);

      expect(error.message).toContain("No compiler is available for target.os.family 'fedora'.");
      expect(error.errorCode).toBe("unsupported-os");
      expect(jobs.markJobFailed).toHaveBeenCalledWith({
        id: "job_123",
        claim: expect.objectContaining({ workerId: expect.any(String) }),
        errorCode: "unsupported-os",
        errorMessage: "No compiler is available for target.os.family 'fedora'.",
      });
      expect(jobs.markJobSucceeded).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("keeps build succeeded when runtime launch selection fails", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_123",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          runtimeFamily: "k8s",
          runtimeMode: "require",
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();

    return Effect.gen(function* () {
      const error = yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_123",
          runtimeAdapters: [createRuntimeAdapterStub("docker")],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      ).pipe(Effect.flip);

      expect(error.message).toContain(
        "No runtime adapter is registered for target.runtime.family 'k8s'.",
      );
      expect(jobs.markJobFailed).not.toHaveBeenCalled();
      expect(jobs.markJobSucceeded).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("fails the launch when the GitHub integration is unavailable", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_no_integration",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          url: "https://github.com/sealant-ops/core.git",
          authRef: "github-installation-repository:gh_installation_repo_1",
          osFamily: "nix",
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();

    return Effect.gen(function* () {
      // No gitHubSourceIntegration provided -> resolver must fail, not crash.
      const error = yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_no_integration",
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkspaceBuildJobProcessingError);
      expect(error.errorCode).toBe("github-integration-unavailable");
      // The image build already succeeded, so the job stays succeeded (failure is in Phase B).
      expect(jobs.markJobSucceeded).toHaveBeenCalledTimes(1);
      expect(jobs.markJobFailed).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  });

  it.effect("fails the launch when the GitHub installation repository is unavailable", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_unknown_repo",
        runId: null,
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          url: "https://github.com/sealant-ops/core.git",
          authRef: "github-installation-repository:gh_unknown_repo",
          osFamily: "nix",
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub();
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const gitHubSourceIntegration = githubSourceIntegrationStub();

    return Effect.gen(function* () {
      const error = yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_unknown_repo",
          gitHubSourceIntegration,
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      ).pipe(Effect.flip);

      expect(error.errorCode).toBe("github-installation-repository-unavailable");
      expect(gitHubSourceIntegration.createInstallationAccessToken).not.toHaveBeenCalled();
      expect(jobs.markJobFailed).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });

  it.effect("records a failed runtime instance when the GitHub installation is inactive", () => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_inactive",
        runId: "run_inactive",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
        requestPayload: createWorkspaceBuildSpec({
          url: "https://github.com/sealant-ops/core.git",
          authRef: "github-installation-repository:gh_installation_repo_1",
          osFamily: "nix",
        }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const installations = githubInstallationRepoStub({ status: "suspended" });
    const installationRepositories = githubInstallationRepositoryCacheStub();
    const gitHubSourceIntegration = githubSourceIntegrationStub();

    return Effect.gen(function* () {
      const error = yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_inactive",
          gitHubSourceIntegration,
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      ).pipe(Effect.flip);

      expect(error.errorCode).toBe("github-installation-inactive");
      expect(gitHubSourceIntegration.createInstallationAccessToken).not.toHaveBeenCalled();
      expect(jobs.markJobFailed).not.toHaveBeenCalled();
      expect(attempts.markAttemptFailed).toHaveBeenCalledWith({ id: "run_inactive" });
      expect(runtimeInstances.upsertRuntimeInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run_inactive",
          status: "failed",
          errorCode: "github-installation-inactive",
        }),
      );
    }).pipe(
      Effect.provide(
        provideRepos({ jobs, runtimeInstances, attempts, installations, installationRepositories }),
      ),
    );
  });
});

describe("a worker lost after its capture executor started (review 3 #6)", () => {
  it("keeps the started executor as a retained launch when the worker is interrupted", async () => {
    // Review 3 #6: the worker was interrupted after `onStarted` recorded the executor; the row
    // stayed `pending` after the job succeeded, outside every preservation sweep.
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_interrupted",
        runId: "run_interrupted",
        repository: "sealant/workspaces/demo",
        tag: "capture",
        requestPayload: {
          ...createWorkspaceBuildSpec({ osFamily: "nix" }),
          sources: {
            workspace: { kind: "capture", endpoint: "https://mend.example.com/session/s1" },
            inputs: [],
            mounts: [],
          },
        },
        secretEnvSealed: SEALED_CAPTURE_TOKEN,
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const deadline = new Date(Date.now() + 5_000).toISOString();
    const runtimeAdapter = createRuntimeAdapterStub("docker", {
      launch: async (_input, hooks) => {
        await hooks?.onStarted?.({
          adapter: "docker",
          resourceId: "container-live",
          reference: "sealant-live",
          deadline,
        });
        signalStarted?.();
        return new Promise(() => undefined);
      },
    });
    const fiber = Effect.runFork(
      processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_interrupted",
          credentialCipher: fakeCredentialCipher,
          runtimeAdapters: [runtimeAdapter],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      ).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts }))),
    );
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(jobs.markJobSucceeded).toHaveBeenCalledTimes(1);
    expect(runtimeInstances.upsertRuntimeInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: "run_interrupted",
        status: "failed",
        errorCode: LAUNCH_RETAINED_ERROR_CODE,
        adapter: "docker",
        resourceId: "container-live",
        runtimeDeadlineAt: new Date(deadline),
        releaseLaunch: true,
      }),
    );
    const last = runtimeInstances.upsertRuntimeInstance.mock.calls.at(-1)?.[0];
    // Still running: a retained launch has no finish instant.
    expect(last).not.toHaveProperty("finishedAt");
    expect(attempts.markAttemptFailed).toHaveBeenCalledWith({ id: "run_interrupted" });
  });
});

describe("a launch never waits past its runtime's preservation start (review 4 #6)", () => {
  const captureJob = (jobId: string, runId: string) =>
    workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: jobId,
        runId,
        repository: "sealant/workspaces/demo",
        tag: "capture",
        requestPayload: {
          ...createWorkspaceBuildSpec({ osFamily: "nix" }),
          sources: {
            workspace: { kind: "capture", endpoint: "https://mend.example.com/session/s1" },
            inputs: [],
            mounts: [],
          },
        },
        secretEnvSealed: SEALED_CAPTURE_TOKEN,
      }),
    });
  /** An executor that starts (its deadline reported) and whose readiness never comes. */
  const neverReady = (deadline: string) =>
    createRuntimeAdapterStub("docker", {
      launch: async (_input, hooks) => {
        await hooks?.onStarted?.({
          adapter: "docker",
          resourceId: "container-slow",
          reference: "sealant-slow",
          deadline,
        });
        return new Promise(() => undefined);
      },
    });

  it("stops waiting for readiness at the preservation start and keeps the executor as a retained launch", async () => {
    // A 120 s MicroVM lifetime with a 300 s readiness timeout: the launch used to wait past its
    // own cap, the row `pending` and outside every drain.
    const jobs = captureJob("job_slow", "run_slow");
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const leadMs = 60_000;
    const deadline = new Date(Date.now() + leadMs + 300).toISOString();
    const startedAt = Date.now();
    const exit = await Effect.runPromise(
      processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_slow",
          credentialCipher: fakeCredentialCipher,
          runtimeAdapters: [neverReady(deadline)],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
          preservationLeadMs: leadMs,
        }),
      ).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })), Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(runtimeInstances.upsertRuntimeInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: "run_slow",
        status: "failed",
        errorCode: LAUNCH_RETAINED_ERROR_CODE,
        resourceId: "container-slow",
        runtimeDeadlineAt: new Date(deadline),
        errorMessage: expect.stringContaining("preservation starts"),
      }),
    );
    expect(attempts.markAttemptFailed).toHaveBeenCalledWith({ id: "run_slow" });
  });

  it("hands the adapter the launch the create named, for the executor's boot env", async () => {
    const jobs = captureJob("job_named", "run_named");
    const attempts = {
      ...workspaceAttemptRepoStub(),
      getAttemptById: vi.fn((id: string) =>
        Effect.succeed({ id, ownerUserId: "user_1", launchId: "launch-named" }),
      ),
    };
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const launched: Array<{ launchId?: string | undefined }> = [];
    const runtimeAdapter = createRuntimeAdapterStub("docker", {
      launch: async (input) => {
        launched.push(input);
        return {
          adapter: "docker",
          resourceId: "container-named",
          reference: "sealant-named",
          status: "ready",
        };
      },
    });
    await Effect.runPromise(
      processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_named",
          credentialCipher: fakeCredentialCipher,
          runtimeAdapters: [runtimeAdapter],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
        }),
      ).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })), Effect.exit),
    );
    expect(launched.map((input) => input.launchId)).toEqual(["launch-named"]);
  });

  it("stops waiting once its launch ownership was taken over (preempted by the deadline sweep)", async () => {
    const jobs = captureJob("job_preempted", "run_preempted");
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = {
      ...workspaceRuntimeInstanceRepoStub(),
      renewLaunchLease: vi.fn(() => Effect.succeed(false)),
    };
    const exit = await Effect.runPromise(
      processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_preempted",
          credentialCipher: fakeCredentialCipher,
          runtimeAdapters: [neverReady(new Date(Date.now() + 3_600_000).toISOString())],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
          launchLeaseMs: 1_000,
        }),
      ).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })), Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(runtimeInstances.renewLaunchLease).toHaveBeenCalled();
    expect(runtimeInstances.upsertRuntimeInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: LAUNCH_RETAINED_ERROR_CODE,
        resourceId: "container-slow",
        errorMessage: expect.stringContaining("ownership was taken over"),
      }),
    );
  }, 15_000);

  // Review 6 #8: once the launch was taken over, it is its adopter's. The failure that follows
  // writes nothing over the adopted row (fenced on this worker's launch ownership), does not
  // mark the attempt failed over it, and leaves the launch material to whoever stops it.
  it("writes nothing over a launch its adopter took over, and keeps its launch material", async () => {
    const jobs = captureJob("job_adopted", "run_adopted");
    const attempts = workspaceAttemptRepoStub();
    const upserts: Array<Record<string, unknown>> = [];
    const runtimeInstances = {
      ...workspaceRuntimeInstanceRepoStub(),
      upsertRuntimeInstance: vi.fn((input: Record<string, unknown>) => {
        upserts.push(input);
        // Every write fenced on the launch ownership finds it taken (the row was adopted).
        return input["fenceLaunchOwner"] !== undefined && input["status"] === "failed"
          ? Effect.fail(
              new WorkspaceRuntimeInstanceRepoInvariantError({
                operation: "upsertRuntimeInstance",
                message: LAUNCH_OWNERSHIP_LOST_MESSAGE,
              }),
            )
          : Effect.succeed({});
      }),
      renewLaunchLease: vi.fn(() => Effect.succeed(false)),
    };
    const removed: string[] = [];
    const exit = await Effect.runPromise(
      processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_adopted",
          credentialCipher: fakeCredentialCipher,
          runtimeAdapters: [neverReady(new Date(Date.now() + 3_600_000).toISOString())],
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
          launchLeaseMs: 1_000,
          launchMaterialStager: {
            stage: async () => ({}),
            removeSecretEnv: async () => {
              removed.push("secret-env");
            },
            removeAll: async () => {
              removed.push("all");
            },
          },
        }),
      ).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })), Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const failed = upserts.filter((input) => input["status"] === "failed");
    expect(failed.length).toBeGreaterThan(0);
    // Only fenced: never an unconditional failed write over the adopter's row.
    expect(failed.every((input) => typeof input["fenceLaunchOwner"] === "string")).toBe(true);
    expect(attempts.markAttemptFailed).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
  }, 15_000);
});

describe("the daemon build an executor boots, recorded at launch (review 3 #8)", () => {
  const launchWithDaemon = (sealantdImage: string) => {
    const jobs = workspaceBuildJobRepoStub({
      claimJobById: () => ({
        id: "job_daemon",
        runId: "run_daemon",
        repository: "sealant/workspaces/demo",
        tag: "capture",
        requestPayload: createWorkspaceBuildSpec({ osFamily: "nix" }),
      }),
    });
    const attempts = workspaceAttemptRepoStub();
    const runtimeInstances = workspaceRuntimeInstanceRepoStub();
    const planWorkspaceSpec = vi.fn(() => ({
      osFamily: "nix" as const,
      imagePlan: {} as never,
      containerfile: [
        "FROM nixos/nix:2.24.9",
        `COPY --chmod=755 --from=${sealantdImage} /usr/local/bin/sealantd /usr/local/bin/sealantd`,
      ].join("\n"),
      planHash: "plan-daemon",
    }));
    return Effect.gen(function* () {
      yield* processWorkspaceBuildJobEffect(
        baseOptions({
          jobId: "job_daemon",
          compileWorkspaceSpec: vi.fn(async () => createCompileResult({ id: "nix" })),
          planWorkspaceSpec,
        }),
      );
      return runtimeInstances.upsertRuntimeInstance.mock.calls[0]?.[0];
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts })));
  };

  it.effect("records a released daemon older than the recovery boot as without it", () =>
    Effect.gen(function* () {
      expect(yield* launchWithDaemon("ghcr.io/sealant-sh/sealantd:0.18.2")).toMatchObject({
        status: "pending",
        daemonImage: "ghcr.io/sealant-sh/sealantd:0.18.2",
        daemonRecoveryBoot: false,
      });
    }),
  );

  it.effect("records a released daemon with the recovery boot as with it", () =>
    Effect.gen(function* () {
      expect(yield* launchWithDaemon("ghcr.io/sealant-sh/sealantd:0.19.0")).toMatchObject({
        daemonImage: "ghcr.io/sealant-sh/sealantd:0.19.0",
        daemonRecoveryBoot: true,
      });
    }),
  );

  it.effect("records an undeclared development daemon as unknown", () =>
    Effect.gen(function* () {
      expect(yield* launchWithDaemon("sealantd-dev:local")).toMatchObject({
        daemonImage: "sealantd-dev:local",
        daemonRecoveryBoot: null,
      });
    }),
  );
});
