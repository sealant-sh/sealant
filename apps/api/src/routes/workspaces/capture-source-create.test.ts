import type { CreateWorkspaceRequest } from "@sealant/api-contracts";
import { CredentialCipher } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  GitHubInstallationRepo,
  GitHubInstallationRepositoryCacheRepo,
  ProfileRepo,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceRepo,
  type Workspace,
  type WorkspaceAttempt,
  type WorkspaceAttemptRepoService,
  type WorkspaceAttemptSnapshot,
  type WorkspaceBuildJob,
  type WorkspaceBuildJobRepoService,
  type WorkspaceRepoService,
} from "@sealant/db";
import { GitHubSourceIntegrationService } from "@sealant/source-integrations";
import type { NewWorkspace } from "@sealant/validators";
import type { PackageStandardizer } from "@sealant/workspaces";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  PackageStandardizerService,
  WorkspaceBuildJobPublisherService,
} from "../../services/control-plane-capabilities.js";
import { createWorkspace } from "./workspaces.module.js";

const now = new Date("2026-09-16T12:00:00.000Z");

const capturePayload = (
  harnessHome: string,
  mounts: ReadonlyArray<{
    readonly hostPath: string;
    readonly mountPath: string;
    readonly bindable?: boolean;
  }> = [],
  workingDirectory?: string,
): CreateWorkspaceRequest => ({
  ownerUserId: "usr_capture",
  registryId: "default",
  repository: "capture-session",
  tag: "capture",
  captureToken: "channel_secret",
  secretEnv: { MEND_SESSION_TOKEN: "mend_secret" },
  spec: {
    sources: {
      workspace: {
        kind: "capture",
        endpoint: "https://mend.example.com/session/s1",
        worktreeId: "wt_1",
        harnessHome,
      },
      ...(mounts.length === 0 ? {} : { mounts }),
    },
    harness: { id: "claude-code" },
    ...(workingDirectory === undefined ? {} : { runtime: { workingDirectory } }),
  },
});

interface RecordingState {
  snapshot?: NewWorkspace;
  job?: NewWorkspace;
  sealedPlaintext?: string;
  publishedJobId?: string;
}

const makeRecordingLayer = (state: RecordingState) => {
  const workspaceRepo: WorkspaceRepoService = {
    createWorkspace: (input) =>
      Effect.succeed<Workspace>({
        id: input.id,
        name: input.name,
        ownerUserId: input.ownerUserId,
        repositoryId: input.repositoryId ?? null,
        repositoryProfileRevisionId: input.repositoryProfileRevisionId ?? null,
        profileRevisionId: input.profileRevisionId ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
        status: input.status ?? "queued",
        latestRunId: null,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        binds: [],
      }),
    getWorkspaceByAttemptId: () => Effect.die("unused"),
    getWorkspaceById: () => Effect.die("unused"),
    linkWorkspaceAttempt: (input) =>
      Effect.succeed({
        workspaceId: input.workspaceId,
        runId: input.attemptId,
        relation: input.relation ?? "launch",
        linkedAt: input.linkedAt ?? now,
      }),
    // The live-workspace budget counts the owner's workspaces before anything is created.
    listWorkspaces: () => Effect.succeed([]),
    listWorkspaceAttemptLinks: () => Effect.die("unused"),
    setWorkspaceName: () => Effect.die("unused"),
    setWorkspaceBinds: () => Effect.die("unused"),
    setWorkspaceExpiry: () => Effect.die("unused"),
    setWorkspaceStatus: () => Effect.die("unused"),
  };

  const attemptRepo: WorkspaceAttemptRepoService = {
    createQueuedAttempt: (input) =>
      Effect.succeed<WorkspaceAttempt>({
        id: input.id,
        ownerUserId: input.ownerUserId,
        repositoryId: input.repositoryId ?? null,
        repositoryProfileRevisionId: input.repositoryProfileRevisionId ?? null,
        profileRevisionId: input.profileRevisionId ?? null,
        status: "queued",
        triggerType: input.triggerType ?? "manual",
        triggerRef: input.triggerRef ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
        retryOfRunId: input.retryOfRunId ?? null,
        cancelReason: null,
        queuedAt: input.queuedAt ?? now,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        createdAt: now,
        updatedAt: now,
      }),
    getAttemptById: () => Effect.die("unused"),
    getAttemptSnapshotByRunId: () => Effect.die("unused"),
    setAttemptSnapshot: (input) => {
      state.snapshot = input.specPayload;
      return Effect.succeed<WorkspaceAttemptSnapshot>({
        runId: input.runId,
        userSpecPayload: input.specPayload,
        resolvedSpecPayload: input.specPayload,
        blueprintPayload: input.specPayload,
        profileConfigSnapshot: input.profileConfigSnapshot ?? null,
        repositoryProfileConfigSnapshot: input.repositoryProfileConfigSnapshot ?? null,
        createdAt: now,
      });
    },
    markAttemptRunning: () => Effect.die("unused"),
    markAttemptSucceeded: () => Effect.die("unused"),
    markAttemptFailed: () => Effect.die("unused"),
    markAttemptCancelled: () => Effect.die("unused"),
    listAttempts: () => Effect.die("unused"),
  };

  const buildJobRepo: WorkspaceBuildJobRepoService = {
    insertQueuedJob: (input) => {
      state.job = input.requestPayload;
      return Effect.succeed<WorkspaceBuildJob>({
        id: input.id,
        runId: input.runId ?? null,
        status: "queued",
        registryId: input.registryId,
        repository: input.repository,
        tag: input.tag,
        requestPayload: input.requestPayload,
        secretEnvSealed: input.secretEnvSealed ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        attemptCount: 0,
        maxAttempts: input.maxAttempts ?? 3,
        availableAt: input.availableAt ?? now,
        claimedAt: null,
        leaseExpiresAt: null,
        workerId: null,
        startedAt: null,
        finishedAt: null,
        builderId: null,
        resultPayload: null,
        publishedReference: null,
        publishedDigestReference: null,
        publishedDigest: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      });
    },
    getJobById: () => Effect.die("unused"),
    getJobByIdempotencyKey: () => Effect.die("unused"),
    getLatestJobByRunId: () => Effect.die("unused"),
    getLatestSucceededJobByPlanHash: () => Effect.die("unused"),
    listLatestJobsByRunIds: () => Effect.die("unused"),
    listJobsByStatus: () => Effect.die("unused"),
    claimNextQueuedJob: () => Effect.die("unused"),
    claimJobById: () => Effect.die("unused"),
    markJobRunning: () => Effect.die("unused"),
    markJobSucceeded: () => Effect.die("unused"),
    markJobFailed: () => Effect.die("unused"),
    clearSecretEnv: () => Effect.die("unused"),
    listPublishedImages: () => Effect.die("unused"),
  };

  const packageStandardizer: PackageStandardizer = {
    resolvePackage: () => Effect.die("unused"),
  };

  return Layer.mergeAll(
    Layer.mock(ConnectedAccountRepo, {}),
    Layer.mock(GitHubInstallationRepo, {}),
    Layer.mock(GitHubInstallationRepositoryCacheRepo, {}),
    Layer.mock(GitHubSourceIntegrationService, {
      isConfigured: () => false,
      isWebhookVerificationConfigured: () => false,
      verifyWebhookSignature: () => false,
    }),
    Layer.mock(ProfileRepo, {}),
    Layer.succeed(WorkspaceRepo, workspaceRepo),
    Layer.succeed(WorkspaceAttemptRepo, attemptRepo),
    Layer.succeed(WorkspaceBuildJobRepo, buildJobRepo),
    Layer.succeed(PackageStandardizerService, packageStandardizer),
    Layer.succeed(CredentialCipher, {
      encrypt: (plaintext) => {
        state.sealedPlaintext = plaintext;
        return Effect.succeed({ sealed: "sealed:capture", keyId: "k1" });
      },
      decrypt: () => Effect.die("unused"),
    }),
    Layer.succeed(WorkspaceBuildJobPublisherService, {
      publishRequested: ({ jobId }) => {
        state.publishedJobId = jobId;
        return Promise.resolve();
      },
    }),
  );
};

describe("createWorkspace capture harness home", () => {
  it("persists the harness root while sealing tokens outside both blueprint copies", async () => {
    const state: RecordingState = {};
    await Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* createWorkspace({
          payload: capturePayload("/workspace/harness-home"),
          headers: {},
        });

        expect(response.status).toBe("queued");
        expect(state.snapshot?.sources.workspace).toMatchObject({
          kind: "capture",
          harnessHome: "/workspace/harness-home",
        });
        expect(state.job?.sources.workspace).toMatchObject({
          kind: "capture",
          harnessHome: "/workspace/harness-home",
        });
        expect(JSON.stringify(state.snapshot)).not.toContain("channel_secret");
        expect(JSON.stringify(state.job)).not.toContain("channel_secret");
        expect(JSON.parse(state.sealedPlaintext ?? "{}")).toEqual({
          MEND_SESSION_TOKEN: "mend_secret",
          SEALANT_CAPTURE_TOKEN: "channel_secret",
        });
        expect(state.publishedJobId).toBeDefined();
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
  });

  it.each([
    ["/workspace/repo/harness-home", "overlaps the working directory"],
    ["/run/sealant/harness-home", "overlaps the daemon control dir"],
  ])("rejects unsafe harness root %s before persistence", async (harnessHome, message) => {
    const state: RecordingState = {};
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.result(
          createWorkspace({ payload: capturePayload(harnessHome), headers: {} }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain(message);
        }
        expect(state.snapshot).toBeUndefined();
        expect(state.job).toBeUndefined();
        expect(state.sealedPlaintext).toBeUndefined();
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
  });

  it.each(["/workspace/./repo", "/workspace/repo/", "/workspace/tmp/../repo"])(
    "rejects a harness root inside aliased working directory %s",
    async (workingDirectory) => {
      const state: RecordingState = {};
      await Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.result(
            createWorkspace({
              payload: capturePayload("/workspace/repo/state", [], workingDirectory),
              headers: {},
            }),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure.message).toContain("overlaps the working directory");
          }
          expect(state.snapshot).toBeUndefined();
          expect(state.job).toBeUndefined();
        }).pipe(Effect.provide(makeRecordingLayer(state))),
      );
    },
  );

  it("rejects overlap with an extra mount target before checking host allowlists", async () => {
    const state: RecordingState = {};
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.result(
          createWorkspace({
            payload: capturePayload("/workspace/harness-home", [
              { hostPath: "/srv/store/harness", mountPath: "/workspace/harness-home/cache" },
            ]),
            headers: {},
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("overlaps an extra mount target");
        }
        expect(state.job).toBeUndefined();
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
  });

  it("rejects overlap with a bindable mount's hidden target before persistence", async () => {
    const state: RecordingState = {};
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.result(
          createWorkspace({
            payload: capturePayload("/workspace/.roots/workspace__cache", [
              {
                hostPath: "/srv/store/harness",
                mountPath: "/workspace/cache",
                bindable: true,
              },
            ]),
            headers: {},
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain(
            "overlaps an extra mount target (/workspace/.roots/workspace__cache)",
          );
        }
        expect(state.snapshot).toBeUndefined();
        expect(state.job).toBeUndefined();
        expect(state.sealedPlaintext).toBeUndefined();
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
  });
});
