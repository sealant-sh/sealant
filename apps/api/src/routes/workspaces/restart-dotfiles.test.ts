/**
 * A restarted workspace applies the same dotfiles as the launch it replaces.
 *
 * The attempt snapshot is durable and API-visible, so it never holds the dotfiles archive payloads;
 * only the build job payload the worker consumes does. A restart rebuilds from the snapshot, so it
 * has to take the archives back from the previous build job, or the new workspace boots without
 * them (and its image plan loses the managers they need). These tests drive `createWorkspace` and
 * then `restartWorkspace` against one in-memory store, the way the API runs them.
 */
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
import { planWorkspaceImageBuild, type PackageStandardizer } from "@sealant/workspaces";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  PackageStandardizerService,
  WorkspaceBuildJobPublisherService,
  WorkspaceLifecyclePublisherService,
} from "../../services/control-plane-capabilities.js";
import { createWorkspace, restartWorkspace } from "./workspaces.module.js";

const now = new Date("2026-09-24T12:00:00.000Z");

const autoArchive = Buffer.from("auto-archive-bytes").toString("base64");
const copyArchive = Buffer.from("copy-archive-bytes").toString("base64");

const dotfilesPayload = (ownerUserId: string): CreateWorkspaceRequest => ({
  ownerUserId,
  registryId: "default",
  repository: "dotfiles-restart",
  tag: "e2e",
  spec: {
    sources: {
      workspace: {
        kind: "git",
        provider: "generic",
        url: "https://github.com/example/repo.git",
        ref: "main",
      },
    },
    harness: { id: "opencode" },
    customization: { applyDotfiles: true, defaultShell: "zsh" },
    runtime: {
      dotfilesArchives: [
        { data: autoArchive, manager: "auto", bootstrap: false },
        { data: copyArchive, manager: "copy", bootstrap: false },
      ],
    },
  },
});

/** One in-memory store behind the three repositories create and restart use. */
interface Store {
  workspace?: Workspace;
  readonly attempts: Map<string, WorkspaceAttempt>;
  readonly snapshots: Map<string, NewWorkspace>;
  readonly jobs: Map<string, WorkspaceBuildJob>;
  readonly stops: string[];
}

const newStore = (): Store => ({
  attempts: new Map(),
  snapshots: new Map(),
  jobs: new Map(),
  stops: [],
});

const makeLayer = (store: Store) => {
  const workspaceRepo: WorkspaceRepoService = {
    createWorkspace: (input) => {
      const workspace: Workspace = {
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
      };
      store.workspace = workspace;
      return Effect.succeed(workspace);
    },
    getWorkspaceByAttemptId: () => Effect.die("unused"),
    getWorkspaceById: (id) =>
      Effect.succeed(store.workspace?.id === id ? store.workspace : undefined),
    linkWorkspaceAttempt: (input) => {
      if (store.workspace !== undefined) {
        store.workspace = { ...store.workspace, latestRunId: input.attemptId };
      }
      return Effect.succeed({
        workspaceId: input.workspaceId,
        runId: input.attemptId,
        relation: input.relation ?? "launch",
        linkedAt: input.linkedAt ?? now,
      });
    },
    listWorkspaces: () => Effect.succeed([]),
    listWorkspaceAttemptLinks: () => Effect.die("unused"),
    setWorkspaceName: () => Effect.die("unused"),
    setWorkspaceBinds: () => Effect.die("unused"),
    setWorkspaceExpiry: () => Effect.succeed(store.workspace ?? null),
    setWorkspaceStatus: (input) => {
      if (store.workspace !== undefined) {
        store.workspace = { ...store.workspace, status: input.status };
      }
      return Effect.succeed(store.workspace ?? null);
    },
  };

  const attemptRepo: WorkspaceAttemptRepoService = {
    createQueuedAttempt: (input) => {
      const attempt: WorkspaceAttempt = {
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
      };
      store.attempts.set(attempt.id, attempt);
      return Effect.succeed(attempt);
    },
    getAttemptById: (id) => Effect.succeed(store.attempts.get(id)),
    getAttemptSnapshotByRunId: (runId) => {
      const spec = store.snapshots.get(runId);
      return Effect.succeed<WorkspaceAttemptSnapshot | undefined>(
        spec === undefined
          ? undefined
          : {
              runId,
              userSpecPayload: spec,
              resolvedSpecPayload: spec,
              blueprintPayload: spec,
              profileConfigSnapshot: null,
              repositoryProfileConfigSnapshot: null,
              createdAt: now,
            },
      );
    },
    setAttemptSnapshot: (input) => {
      store.snapshots.set(input.runId, input.specPayload);
      return Effect.succeed<WorkspaceAttemptSnapshot>({
        runId: input.runId,
        userSpecPayload: input.specPayload,
        resolvedSpecPayload: input.specPayload,
        blueprintPayload: input.specPayload,
        profileConfigSnapshot: null,
        repositoryProfileConfigSnapshot: null,
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
      const job: WorkspaceBuildJob = {
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
      };
      store.jobs.set(input.runId ?? input.id, job);
      return Effect.succeed(job);
    },
    getJobById: () => Effect.die("unused"),
    getJobByIdempotencyKey: () => Effect.die("unused"),
    getLatestJobByRunId: (runId) => Effect.succeed(store.jobs.get(runId)),
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
      encrypt: () => Effect.die("unused"),
      decrypt: () => Effect.die("unused"),
    }),
    Layer.succeed(WorkspaceBuildJobPublisherService, {
      publishRequested: () => Promise.resolve(),
    }),
    Layer.succeed(WorkspaceLifecyclePublisherService, {
      publishStopRequested: ({ runId }) => {
        store.stops.push(runId);
        return Promise.resolve();
      },
    }),
  );
};

/** The launch settled, so a restart is allowed. */
const settle = (store: Store, runId: string): void => {
  const attempt = store.attempts.get(runId);
  if (attempt !== undefined) {
    store.attempts.set(runId, { ...attempt, status: "succeeded" });
  }
  if (store.workspace !== undefined) {
    store.workspace = { ...store.workspace, status: "ready" };
  }
};

const archivesOf = (spec: NewWorkspace | undefined) =>
  spec?.runtime.dotfilesArchives.map((archive) => ({
    data: archive.data,
    manager: archive.manager,
  }));

const expectedArchives = [
  { data: autoArchive, manager: "auto" },
  { data: copyArchive, manager: "copy" },
];

describe("restartWorkspace dotfiles", () => {
  it("keeps the archives out of the snapshot and in the build job on create", async () => {
    const store = newStore();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* createWorkspace({ payload: dotfilesPayload("usr_dotfiles_create"), headers: {} });
        const runId = store.workspace?.latestRunId ?? "";
        expect(archivesOf(store.snapshots.get(runId))).toEqual([]);
        expect(archivesOf(store.jobs.get(runId)?.requestPayload)).toEqual(expectedArchives);
      }).pipe(Effect.provide(makeLayer(store))),
    );
  });

  it("re-stages the previous launch's archives, in order, on the restart's build job", async () => {
    const store = newStore();
    await Effect.runPromise(
      Effect.gen(function* () {
        const owner = "usr_dotfiles_restart";
        const created = yield* createWorkspace({ payload: dotfilesPayload(owner), headers: {} });
        const firstRunId = store.workspace?.latestRunId ?? "";
        settle(store, firstRunId);

        const restarted = yield* restartWorkspace({
          workspaceId: created.workspaceId,
          payload: { ownerUserId: owner },
        });
        expect(restarted.runId).not.toBe(firstRunId);
        expect(store.stops).toEqual([firstRunId]);

        const job = store.jobs.get(restarted.runId);
        expect(archivesOf(job?.requestPayload)).toEqual(expectedArchives);
        expect(job?.requestPayload.customization).toMatchObject({
          applyDotfiles: true,
          defaultShell: "zsh",
        });
        // The image plan is the first launch's: the same recipe, managers included.
        const firstJob = store.jobs.get(firstRunId)?.requestPayload;
        if (firstJob === undefined || job === undefined) throw new Error("no recorded build job");
        const restartPlan = planWorkspaceImageBuild({
          blueprint: job.requestPayload,
        }).containerfile;
        expect(restartPlan).toBe(planWorkspaceImageBuild({ blueprint: firstJob }).containerfile);
        expect(restartPlan).toMatch(/\bstow\b/);
        expect(restartPlan).toMatch(/\bchezmoi\b/);
        // The restart's own snapshot stays free of the payloads, like the create's.
        expect(archivesOf(store.snapshots.get(restarted.runId))).toEqual([]);

        // A restart of the restart still finds them: the restart's job is now the previous one.
        settle(store, restarted.runId);
        const again = yield* restartWorkspace({
          workspaceId: created.workspaceId,
          payload: { ownerUserId: owner },
        });
        expect(archivesOf(store.jobs.get(again.runId)?.requestPayload)).toEqual(expectedArchives);
      }).pipe(Effect.provide(makeLayer(store))),
    );
  });

  it("refuses a restart whose recorded archives do not parse instead of dropping them", async () => {
    const store = newStore();
    await Effect.runPromise(
      Effect.gen(function* () {
        const owner = "usr_dotfiles_corrupt";
        const created = yield* createWorkspace({ payload: dotfilesPayload(owner), headers: {} });
        const runId = store.workspace?.latestRunId ?? "";
        settle(store, runId);
        const job = store.jobs.get(runId);
        if (job === undefined) throw new Error("the create recorded no build job");
        store.jobs.set(runId, {
          ...job,
          requestPayload: {
            ...job.requestPayload,
            runtime: {
              ...job.requestPayload.runtime,
              dotfilesArchives: [{ data: "not base64!", bootstrap: false }],
            },
          },
        });

        const result = yield* Effect.result(
          restartWorkspace({ workspaceId: created.workspaceId, payload: { ownerUserId: owner } }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("dotfiles archives");
        }
        expect(store.stops).toEqual([]);
      }).pipe(Effect.provide(makeLayer(store))),
    );
  });
});
