import { WorkspaceSshOwnerRefusedError, type CreateWorkspaceRequest } from "@sealant/api-contracts";
import { CredentialCipher } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  GitHubInstallationRepo,
  GitHubInstallationRepositoryCacheRepo,
  ProfileRepo,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceRepo,
  WorkspaceRepoUnexpectedError,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceCreateReservationRepo,
  DatabaseTransaction,
  type WorkspaceCreateReservation,
  type Workspace,
  type WorkspaceAttempt,
  type WorkspaceAttemptRepoService,
  type WorkspaceAttemptSnapshot,
  type WorkspaceBuildJob,
  type WorkspaceBuildJobRepoService,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  WorkspaceCaptureDrainRepo,
  UserRepo,
  type PersonBinding,
} from "@sealant/db";
import { GitHubSourceIntegrationService } from "@sealant/source-integrations";
import type { NewWorkspace } from "@sealant/validators";
import {
  createPackageStandardizer,
  planWorkspaceImageBuild,
  type PackageStandardizer,
} from "@sealant/workspaces";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  PackageStandardizerService,
  WorkspaceBuildJobPublisherService,
} from "../../services/control-plane-capabilities.js";
import { cancelWorkspaceCreate, createWorkspace, getWorkspaceCreate } from "./workspaces.module.js";

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
  /** The owner's workspace an earlier create with the key made (found by key). */
  existingByKey?: Workspace;
  /** The first lookup misses and the insert loses a race on the owner/key unique index. */
  raceOnCreate?: boolean;
  /** Keys the workspace rows were written with. */
  createdKeys?: Array<string | undefined>;
  /** The owner's person binding (`POST /v1/users/:id/person`); none unless said. */
  binding?: PersonBinding;
  /** SSH users the workspace rows were written with. */
  createdSshUsers?: Array<string | undefined>;
  runtime?: WorkspaceRuntimeInstance;
  /** The launch job of the existing workspace's latest run; absent = none (a half-made create). */
  existingJobStatus?: "queued" | "running" | "succeeded" | "failed";
  /** The create reservations, by `owner/key`. */
  reservations?: Map<string, WorkspaceCreateReservation>;
  /** Attempts written (with their launch ids). */
  attempts?: Array<{ id: string; launchId: string | undefined }>;
  /** Workspace statuses set. */
  statuses?: Array<{ id: string; status: string }>;
  /** Runs as the launch job is written (to interleave a cancel with a create). */
  onInsertJob?: () => void;
}

const reservationKey = (input: { ownerUserId: string; idempotencyKey: string }) =>
  `${input.ownerUserId}/${input.idempotencyKey}`;

/** An in-memory create reservation record with the database's transitions. */
const reservationRepo = (state: RecordingState) => {
  const rows = (state.reservations ??= new Map());
  const fresh = (
    input: { ownerUserId: string; idempotencyKey: string; launchId?: string },
    reservationState: WorkspaceCreateReservation["state"],
  ): WorkspaceCreateReservation => ({
    ownerUserId: input.ownerUserId,
    idempotencyKey: input.idempotencyKey,
    state: reservationState,
    workspaceId: null,
    launchId: input.launchId ?? null,
    cancelledAt: reservationState === "cancelled" ? now : null,
    createdAt: now,
    updatedAt: now,
  });
  return {
    reserve: (input: { ownerUserId: string; idempotencyKey: string; launchId?: string }) =>
      Effect.sync(() => {
        const existing = rows.get(reservationKey(input));
        if (existing !== undefined) return existing;
        const row = fresh(input, "pending");
        rows.set(reservationKey(input), row);
        return row;
      }),
    markCreated: (input: { ownerUserId: string; idempotencyKey: string; workspaceId: string }) =>
      Effect.sync(() => {
        const existing = rows.get(reservationKey(input));
        if (existing?.state !== "pending") return false;
        rows.set(reservationKey(input), {
          ...existing,
          state: "created",
          workspaceId: input.workspaceId,
        });
        return true;
      }),
    cancel: (input: { ownerUserId: string; idempotencyKey: string }) =>
      Effect.sync(() => {
        const existing = rows.get(reservationKey(input));
        if (existing === undefined || existing.state === "pending") {
          const row = { ...(existing ?? fresh(input, "cancelled")), state: "cancelled" as const };
          rows.set(reservationKey(input), row);
          return row;
        }
        return existing;
      }),
    get: (input: { ownerUserId: string; idempotencyKey: string }) =>
      Effect.sync(() => rows.get(reservationKey(input))),
  };
};

const makeRecordingLayer = (
  state: RecordingState,
  packageStandardizer: PackageStandardizer = { resolvePackage: () => Effect.die("unused") },
) => {
  let lookups = 0;
  const workspaceRepo: WorkspaceRepoService = {
    createWorkspace: (input) =>
      state.raceOnCreate === true
        ? Effect.fail(
            // What the live repo fails with when Postgres refuses the insert (SQLSTATE 23505).
            new WorkspaceRepoUnexpectedError({
              operation: "createWorkspace",
              message: "insert into workspaces failed",
              cause: Object.assign(
                new Error(
                  'duplicate key value violates unique constraint "workspaces_owner_idempotency_key_idx"',
                ),
                { code: "23505" },
              ),
            }),
          )
        : Effect.sync(() => {
            (state.createdKeys ??= []).push(input.idempotencyKey);
            (state.createdSshUsers ??= []).push(input.sshUser);
          }).pipe(
            Effect.andThen(
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
                idempotencyKey: input.idempotencyKey ?? null,
                sshUser: input.sshUser ?? null,
              }),
            ),
          ),
    getWorkspaceByIdempotencyKey: (input) =>
      Effect.sync(() => {
        lookups += 1;
        const existing = state.existingByKey;
        // A racing create: the first lookup misses, the one after the refused insert finds it.
        if (state.raceOnCreate === true && lookups === 1) return undefined;
        return existing !== undefined &&
          existing.ownerUserId === input.ownerUserId &&
          existing.idempotencyKey === input.idempotencyKey
          ? existing
          : undefined;
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
    setWorkspaceSshUser: () => Effect.die("unused"),
    setWorkspaceBinds: () => Effect.die("unused"),
    setWorkspaceExpiry: () => Effect.die("unused"),
    setWorkspaceStatus: (input) =>
      Effect.sync(() => {
        (state.statuses ??= []).push({ id: input.id, status: input.status });
        return null;
      }),
  };

  const attemptRepo: WorkspaceAttemptRepoService = {
    createQueuedAttempt: (input) =>
      Effect.sync(() => {
        (state.attempts ??= []).push({ id: input.id, launchId: input.launchId });
      }).pipe(
        Effect.andThen(
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
            launchId: input.launchId ?? null,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      ),
    getAttemptById: () => Effect.succeed(undefined),
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
      state.onInsertJob?.();
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
        progress: null,
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
    getJobByIdempotencyKey: () => Effect.succeed(undefined),
    // The existing workspace's launch job, when the test gives it one.
    getLatestJobByRunId: (runId) =>
      Effect.succeed(
        state.existingJobStatus !== undefined && state.existingByKey?.latestRunId === runId
          ? ({
              id: "job_first",
              runId,
              status: state.existingJobStatus,
              registryId: "local",
              repository: "sealant/workspaces/capture",
              tag: "session",
            } as unknown as WorkspaceBuildJob)
          : undefined,
      ),
    getLatestSucceededJobByPlanHash: () => Effect.die("unused"),
    listLatestJobsByRunIds: () => Effect.die("unused"),
    listJobsByStatus: () => Effect.die("unused"),
    claimNextQueuedJob: () => Effect.die("unused"),
    claimJobById: () => Effect.die("unused"),
    markJobRunning: () => Effect.die("unused"),
    markJobSucceeded: () => Effect.die("unused"),
    recordJobProgress: () => Effect.die("unused"),
    cancelUnbuiltJob: () => Effect.die("unused"),
    markJobFailed: () => Effect.die("unused"),
    clearSecretEnv: () => Effect.die("unused"),
    listPublishedImages: () => Effect.die("unused"),
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
    Layer.succeed(UserRepo, {
      hasAnySignInAccounts: () => Effect.die("unused"),
      ensureUser: () => Effect.die("unused"),
      getUserById: () => Effect.die("unused"),
      bindPerson: () => Effect.die("unused"),
      getPersonBinding: () => Effect.succeed<PersonBinding | undefined>(state.binding),
    }),
    Layer.succeed(WorkspaceAttemptRepo, attemptRepo),
    Layer.succeed(WorkspaceBuildJobRepo, buildJobRepo),
    // No capture drain is recorded: nothing is retained.
    Layer.mock(WorkspaceCaptureDrainRepo, { getByRunId: () => Effect.succeed(undefined) }),
    Layer.mock(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: () => Effect.succeed(state.runtime),
    }),
    Layer.succeed(WorkspaceCreateReservationRepo, reservationRepo(state)),
    // The unit tests see the writes as they are made; rollback is proven against Postgres.
    Layer.succeed(DatabaseTransaction, { run: (effect) => effect }),
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

describe("createWorkspace package ids", () => {
  const payloadWithPackages = (
    family: "arch" | "fedora" | "nix" | "ubuntu",
    ids: readonly string[],
  ): CreateWorkspaceRequest => ({
    ...capturePayload("/workspace/harness-home"),
    spec: {
      sources: {
        workspace: {
          kind: "capture",
          endpoint: "https://mend.example.com/session/s1",
          worktreeId: "wt_1",
          harnessHome: "/workspace/harness-home",
        },
      },
      harness: { id: "claude-code" },
      target: { os: { family, mode: "require" } },
      tooling: { packages: ids.map((id) => ({ id })) },
    },
  });

  // The standardizer the API runs, offline: had the create path asked it, it would answer from its
  // own map (`python` is `python3` on nix) as it did on alpha.
  const standardizer = createPackageStandardizer({
    repologyClient: {
      getProject: () => Promise.reject(new Error("no network in this test")),
      searchProjects: () => Promise.reject(new Error("no network in this test")),
    },
  });

  // Alpha, 2026-09-25: the create path rewrote `python` to `python3` and `github-cli` to `gh`, and
  // the image planner, which knows catalog ids only, refused both on nix, Fedora and Ubuntu.
  it.each(["nix", "fedora", "ubuntu", "arch"] as const)(
    "keeps catalog ids in the stored spec on %s, and the stored spec plans",
    async (family) => {
      const state: RecordingState = {};
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* createWorkspace({
            payload: payloadWithPackages(family, ["python", "github-cli"]),
            headers: {},
          });
          expect(state.snapshot?.tooling.packages).toEqual([
            { id: "python" },
            { id: "github-cli" },
          ]);
          expect(state.job?.tooling.packages).toEqual([{ id: "python" }, { id: "github-cli" }]);
          if (state.job === undefined) throw new Error("no job was queued");
          const { containerfile } = planWorkspaceImageBuild({
            platform: "linux/amd64",
            blueprint: state.job,
          });
          expect(containerfile).toMatch(family === "arch" ? /\bgithub-cli\b/ : /\bgh\b/);
        }).pipe(Effect.provide(makeRecordingLayer(state, standardizer))),
      );
    },
  );

  it("refuses an id the catalog does not know, naming it, before anything is stored", async () => {
    const state: RecordingState = {};
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.result(
          createWorkspace({ payload: payloadWithPackages("nix", ["python3"]), headers: {} }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("Unknown workspace package 'python3'");
        }
        expect(state.job).toBeUndefined();
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
  });
});

describe("createWorkspace · idempotency key", () => {
  const existing = (): Workspace => ({
    id: "ws_first",
    name: "capture-session",
    ownerUserId: "usr_capture",
    repositoryId: null,
    repositoryProfileRevisionId: null,
    profileRevisionId: null,
    requestedByUserId: "usr_capture",
    status: "queued",
    latestRunId: "run_first",
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    binds: [],
    idempotencyKey: "mend-exec-7",
    sshUser: null,
  });
  const runtime = (): WorkspaceRuntimeInstance => ({
    runId: "run_first",
    status: "ready",
    adapter: "docker",
    resourceId: "container-first",
    reference: "sealant-run_first",
    endpoint: null,
    errorCode: null,
    errorMessage: null,
    stopReason: null,
    launchCredentialInjections: null,
    launchedAt: now,
    finishedAt: null,
    runtimeDeadlineAt: null,
    launchOwner: null,
    launchLeaseExpiresAt: null,
    daemonImage: null,
    daemonRecoveryBoot: null,
    removedAt: null,
    sourceKind: "capture",
    createdAt: now,
    updatedAt: now,
  });

  it("stores the key on the new workspace and answers with the run it started", async () => {
    const state: RecordingState = {};
    const response = await Effect.runPromise(
      createWorkspace({
        payload: { ...capturePayload("/workspace/harness-home"), idempotencyKey: "mend-exec-7" },
        headers: {},
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
    expect(state.createdKeys).toEqual(["mend-exec-7"]);
    expect(response.runId).toBeTypeOf("string");
    expect(response.replayed).toBeUndefined();
  });

  it("returns the workspace an earlier create with the same key made, with its executor, and creates nothing", async () => {
    const state: RecordingState = {
      existingByKey: existing(),
      runtime: runtime(),
      existingJobStatus: "succeeded",
    };
    const response = await Effect.runPromise(
      createWorkspace({
        payload: { ...capturePayload("/workspace/harness-home"), idempotencyKey: "mend-exec-7" },
        headers: {},
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
    expect(response).toMatchObject({
      workspaceId: "ws_first",
      replayed: true,
      runId: "run_first",
      runtime: { adapter: "docker", resourceId: "container-first", runId: "run_first" },
    });
    expect(state.createdKeys).toBeUndefined();
    expect(state.publishedJobId).toBeUndefined();
    expect(state.sealedPlaintext).toBeUndefined();
  });

  it("never returns another owner's workspace for the same key", async () => {
    const state: RecordingState = {
      existingByKey: { ...existing(), ownerUserId: "someone_else" },
    };
    const response = await Effect.runPromise(
      createWorkspace({
        payload: { ...capturePayload("/workspace/harness-home"), idempotencyKey: "mend-exec-7" },
        headers: {},
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
    expect(response.workspaceId).not.toBe("ws_first");
    expect(state.createdKeys).toEqual(["mend-exec-7"]);
  });

  it("answers a create that lost the race on the owner/key index with the winner's workspace", async () => {
    const state: RecordingState = {
      existingByKey: existing(),
      raceOnCreate: true,
      existingJobStatus: "succeeded",
    };
    const response = await Effect.runPromise(
      createWorkspace({
        payload: { ...capturePayload("/workspace/harness-home"), idempotencyKey: "mend-exec-7" },
        headers: {},
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
    expect(response).toMatchObject({ workspaceId: "ws_first", replayed: true });
    expect(state.publishedJobId).toBeUndefined();
  });
});

describe("createWorkspace · a create that never finished (review 3 #19)", () => {
  const partial = (): Workspace => ({
    id: "ws_partial",
    name: "capture-session",
    ownerUserId: "usr_capture",
    repositoryId: null,
    repositoryProfileRevisionId: null,
    profileRevisionId: null,
    requestedByUserId: "usr_capture",
    status: "queued",
    latestRunId: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    binds: [],
    idempotencyKey: "key_partial",
    sshUser: null,
  });

  it("finishes a half-made workspace its repeat finds instead of replaying it forever", async () => {
    // Review 3 #19: the workspace row committed alone (the attempt, link, snapshot and job were
    // separate writes); every repeat answered `replayed` with no run and no job, so the workspace
    // could never launch.
    const state: RecordingState = { existingByKey: partial() };
    const answer = await Effect.runPromise(
      createWorkspace({
        payload: { ...capturePayload("/workspace/harness-home"), idempotencyKey: "key_partial" },
        headers: {},
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
    expect(answer.workspaceId).toBe("ws_partial");
    expect(answer.replayed).toBeUndefined();
    expect(answer.runId).toBeTypeOf("string");
    expect(state.createdKeys).toBeUndefined(); // the existing workspace, not a second one
    expect(state.job).toBeDefined();
    expect(state.publishedJobId).toBeTypeOf("string");
    expect(state.statuses).toEqual([{ id: "ws_partial", status: "queued" }]);
    expect(state.reservations?.get("usr_capture/key_partial")).toMatchObject({
      state: "created",
      workspaceId: "ws_partial",
    });
  });

  it("publishes a committed create's launch job again while it is still queued", async () => {
    // The process died between the commit and the queue publish: only a repeat moves it.
    const state: RecordingState = {
      existingByKey: { ...partial(), latestRunId: "run_first" },
      existingJobStatus: "queued",
    };
    const answer = await Effect.runPromise(
      createWorkspace({
        payload: { ...capturePayload("/workspace/harness-home"), idempotencyKey: "key_partial" },
        headers: {},
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
    expect(answer).toMatchObject({ workspaceId: "ws_partial", replayed: true });
    expect(state.publishedJobId).toBe("job_first");
    expect(state.job).toBeUndefined();
  });
});

describe("createWorkspace · cancelling a create by its key (review 3 #21)", () => {
  const payload = { ...capturePayload("/workspace/harness-home"), idempotencyKey: "key_lost" };
  const lookup = (state: RecordingState) =>
    Effect.runPromise(
      getWorkspaceCreate({ idempotencyKey: "key_lost", ownerUserId: "usr_capture" }).pipe(
        Effect.provide(makeRecordingLayer(state)),
      ),
    );

  it("refuses a delayed original create once its key was cancelled", async () => {
    // Review 3 #21: a negative lookup freed the caller to start another executor while the
    // original request could still commit and launch one. A cancel is durable: it cannot.
    const state: RecordingState = {};
    expect(await lookup(state)).toEqual({ idempotencyKey: "key_lost", state: "none" });
    expect(
      await Effect.runPromise(
        cancelWorkspaceCreate({
          idempotencyKey: "key_lost",
          payload: { ownerUserId: "usr_capture" },
        }).pipe(Effect.provide(makeRecordingLayer(state))),
      ),
    ).toEqual({ idempotencyKey: "key_lost", state: "cancelled" });

    const delayed = await Effect.runPromise(
      Effect.result(
        createWorkspace({ payload, headers: {} }).pipe(Effect.provide(makeRecordingLayer(state))),
      ),
    );
    expect(Result.isFailure(delayed)).toBe(true);
    if (Result.isFailure(delayed)) {
      expect(delayed.failure).toMatchObject({
        _tag: "WorkspaceConflictError",
        code: "create-cancelled",
      });
    }
    expect(state.createdKeys).toBeUndefined();
    expect(state.job).toBeUndefined();
    expect(state.publishedJobId).toBeUndefined();
    expect(await lookup(state)).toEqual({ idempotencyKey: "key_lost", state: "cancelled" });
  });

  it("never commits a create whose key was cancelled while it was writing", async () => {
    // The cancel lands between the create's reservation and its commit point: the commit is
    // refused, so the transaction rolls back (proven against Postgres) and nothing is published.
    const state: RecordingState = {
      onInsertJob: () => {
        const row = state.reservations?.get("usr_capture/key_lost");
        if (row !== undefined) {
          state.reservations?.set("usr_capture/key_lost", { ...row, state: "cancelled" });
        }
      },
    };
    const result = await Effect.runPromise(
      Effect.result(
        createWorkspace({ payload, headers: {} }).pipe(Effect.provide(makeRecordingLayer(state))),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ code: "create-cancelled" });
    }
    expect(state.publishedJobId).toBeUndefined();
  });

  it("reads a create that reserved its key and never committed as pending", async () => {
    const state: RecordingState = {};
    state.reservations = new Map([
      [
        "usr_capture/key_lost",
        {
          ownerUserId: "usr_capture",
          idempotencyKey: "key_lost",
          state: "pending",
          workspaceId: null,
          launchId: "key_lost",
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    ]);
    expect(await lookup(state)).toEqual({
      idempotencyKey: "key_lost",
      state: "pending",
      launchId: "key_lost",
    });
  });
});

describe("createWorkspace · the launch identity (decision 5)", () => {
  it("records the create's launch id on its attempt and answers with it", async () => {
    const state: RecordingState = {};
    const answer = await Effect.runPromise(
      createWorkspace({
        payload: {
          ...capturePayload("/workspace/harness-home"),
          idempotencyKey: "launch_7",
          launchId: "launch_7",
        },
        headers: {},
      }).pipe(Effect.provide(makeRecordingLayer(state))),
    );
    expect(answer.launchId).toBe("launch_7");
    expect(state.attempts).toEqual([{ id: answer.runId, launchId: "launch_7" }]);
  });
});

describe("createWorkspace · the workspace's SSH user (Mend ADR 0016)", () => {
  const ALICE = { personId: "acct_alice", uid: 40001, home: "/home/m4lice000" };
  const BOB = { personId: "acct_bob", uid: 40002, home: "/home/m8ob00000" };

  /** A capture create whose owner map names Alice and Bob, its logins into `home`. */
  const create = (
    home: { readonly path: string; readonly uid: number },
    ownerMap: boolean = true,
  ): CreateWorkspaceRequest => {
    const base = capturePayload("/workspace/harness-home");
    const spec = base.spec as {
      readonly sources: { readonly workspace: Record<string, unknown> };
    } & Record<string, unknown>;
    return {
      ...base,
      sshAsOwner: true,
      spec: {
        ...spec,
        sources: {
          ...spec.sources,
          workspace: {
            ...spec.sources.workspace,
            ...(ownerMap
              ? {
                  ownerMap: {
                    gid: 40000,
                    worktreeUid: ALICE.uid,
                    people: [
                      { id: ALICE.personId, uid: ALICE.uid },
                      { id: BOB.personId, uid: BOB.uid },
                    ],
                  },
                }
              : {}),
          },
        },
        runtime: { credentialsHome: { path: home.path, uid: home.uid, gid: 40000 } },
      },
    };
  };

  const run = (state: RecordingState, payload: CreateWorkspaceRequest) =>
    Effect.runPromise(
      createWorkspace({ payload, headers: {} }).pipe(
        Effect.result,
        Effect.provide(makeRecordingLayer(state)),
      ),
    );

  it("runs the sessions as the owner's bound person when the create agrees with the binding", async () => {
    const state: RecordingState = { binding: ALICE };
    const result = await run(state, create({ path: ALICE.home, uid: ALICE.uid }));
    expect(Result.isSuccess(result)).toBe(true);
    expect(state.createdSshUsers).toEqual(["40001"]);
  });

  it("refuses Alice asking for Bob's home, or her own path with Bob's uid, naming no path", async () => {
    for (const home of [
      { path: BOB.home, uid: BOB.uid },
      { path: ALICE.home, uid: BOB.uid },
      { path: BOB.home, uid: ALICE.uid },
    ]) {
      const state: RecordingState = { binding: ALICE };
      const result = await run(state, create(home));
      const failure = Result.isFailure(result) ? result.failure : undefined;
      expect(failure).toBeInstanceOf(WorkspaceSshOwnerRefusedError);
      expect(failure instanceof WorkspaceSshOwnerRefusedError && failure.code).toBe(
        "ssh-owner-mismatch",
      );
      expect(failure instanceof WorkspaceSshOwnerRefusedError && failure.message).not.toContain(
        "/home/",
      );
      expect(state.createdSshUsers).toBeUndefined();
    }
  });

  it("refuses a create with no owner map, and an owner bound to no person", async () => {
    const cases: ReadonlyArray<readonly [RecordingState, CreateWorkspaceRequest, string]> = [
      [
        { binding: ALICE },
        create({ path: ALICE.home, uid: ALICE.uid }, false),
        "ssh-owner-needs-owner-map",
      ],
      [{}, create({ path: ALICE.home, uid: ALICE.uid }), "ssh-owner-unbound"],
    ];
    for (const [state, payload, code] of cases) {
      const result = await run(state, payload);
      const failure = Result.isFailure(result) ? result.failure : undefined;
      expect(failure instanceof WorkspaceSshOwnerRefusedError && failure.code).toBe(code);
      expect(state.createdSshUsers).toBeUndefined();
    }
  });

  it("names nobody without sshAsOwner", async () => {
    const state: RecordingState = { binding: ALICE };
    const { sshAsOwner: _ask, ...plain } = create({ path: ALICE.home, uid: ALICE.uid });
    const result = await run(state, plain);
    expect(Result.isSuccess(result)).toBe(true);
    expect(state.createdSshUsers).toEqual([undefined]);
  });
});
