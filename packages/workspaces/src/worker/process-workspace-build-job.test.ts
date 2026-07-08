import { describe, expect, it } from "@effect/vitest";
import type { CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  GitHubInstallationRepo,
  GitHubInstallationRepositoryCacheRepo,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccountRepoService,
  type GitHubInstallationRepoService,
  type GitHubInstallationRepositoryCacheRepoService,
  type WorkspaceAttemptRepoService,
  type WorkspaceBuildJobRepoService,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import type { GitHubSourceIntegration } from "@sealant/source-integrations";
import type { NewWorkspace, WorkspaceBuild } from "@sealant/validators";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import type { RegistryClient } from "../registry/index.js";
import type { RuntimeAdapter } from "../runtime/index.js";
import { WorkspaceBuildJobProcessingError } from "./errors.js";
import {
  processWorkspaceBuildJobEffect,
  type ProcessWorkspaceBuildJobEffectOptions,
} from "./process-workspace-build-job.js";

const workspaceBuildJobRepoStub = (
  overrides: {
    readonly claimJobById?: () => unknown;
  } = {},
) => ({
  claimJobById: vi.fn((_input: { id: string; workerId: string; leaseDurationMs: number }) =>
    Effect.succeed(overrides.claimJobById?.() ?? null),
  ),
  markJobSucceeded: vi.fn((_input: unknown) => Effect.succeed({})),
  markJobFailed: vi.fn((_input: unknown) => Effect.succeed({})),
});

const workspaceAttemptRepoStub = () => ({
  markAttemptRunning: vi.fn((_input: { id: string }) => Effect.succeed(null)),
  markAttemptSucceeded: vi.fn((_input: { id: string }) => Effect.succeed(null)),
  markAttemptFailed: vi.fn((_input: { id: string }) => Effect.succeed(null)),
});

const workspaceRuntimeInstanceRepoStub = () => ({
  upsertRuntimeInstance: vi.fn((_input: unknown) => Effect.succeed({})),
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
      credentialRefs: input.credentialRefs ?? [],
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace/repo",
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
}) =>
  Layer.mergeAll(
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

const baseOptions = (
  overrides: Partial<ProcessWorkspaceBuildJobEffectOptions>,
): ProcessWorkspaceBuildJobEffectOptions => ({
  jobId: "job_123",
  workerId: "worker-test",
  leaseDurationMs: 60000,
  runtimeAdapters: [createRuntimeAdapterStub("docker")],
  defaultRuntimeAdapterId: "docker",
  registryClient: successRegistryClient(),
  ...overrides,
});

const fakeCredentialCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

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
              contentBase64: Buffer.from(codexAuthJson, "utf8").toString("base64"),
              mode: "600",
            },
          ],
        }),
      );
      expect(connectedAccounts.updateSyncState).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(provideRepos({ jobs, runtimeInstances, attempts, connectedAccounts })));
  });

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
