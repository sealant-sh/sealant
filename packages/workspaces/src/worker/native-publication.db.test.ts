import { randomUUID } from "node:crypto";

import { workspacePublicationSchema as publicPublicationSchema } from "@sealant/api-contracts";
import { sha256Hex, type CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  CredentialPlacementRepo,
  CredentialPlacementRepoLive,
  createSealantDB,
  SealantDB,
  user,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceBuildJobRepo,
  WorkspaceBuildJobRepoLive,
  WorkspaceBuildJobRepoUnexpectedError,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceCredentialHomeRepo,
  WorkspaceCredentialHomeRepoLive,
} from "@sealant/db";
import { nativeConsumerRows } from "@sealant/db/testing/native-publications";
import {
  seedImageScope,
  revokeImageScope,
  takeWorkspaceJobClaim,
  corruptWorkspacePublication,
  withWorkspaceJobTestDatabase,
} from "@sealant/db/testing/workspace-publications";
import {
  nativeArtifactConsumerSchema,
  newWorkspaceSchema,
  type NativePublicationKey,
  type NativePublication,
} from "@sealant/validators";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { resolveWorkspacePublication, resolveWorkspacePublishedImage } from "../api/workspace.js";
import { nativeBuilderFixture } from "../images/boat/builder.fixture.js";
import type { IBoatSnapshotBuilder } from "../images/boat/builder.js";
import {
  BoatNativeCatalog,
  boatNativeCatalogLayer,
  NativeCatalogError,
} from "../images/boat/catalog.js";
import { BoatImageInspection, boatImageInspectionLayer } from "../images/boat/inspection.js";
import type { RegistryClient } from "../registry/client.js";
import { LaunchRetainedError } from "../runtime/launch-retention.js";
import type { RuntimeAdapter, RuntimeLaunch } from "../runtime/runtime-adapter.js";
import {
  processWorkspaceBuildJob,
  processWorkspaceBuildJobEffect,
} from "./process-workspace-build-job.js";
import { reapStaleWorkspaceBuildJobs } from "./reap-stale-workspace-build-jobs.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
const enabled = databaseUrl !== undefined && process.env.SEALANT_BOAT_RUNTIME_BUNDLE !== undefined;
const forbidden = async (): Promise<never> => {
  throw new Error("Native publication touched the OCI registry.");
};
const registry: RegistryClient = {
  ping: forbidden,
  repositoryExists: forbidden,
  listTags: forbidden,
  getManifest: forbidden,
  headManifest: forbidden,
  discoverExtensions: forbidden,
  publishOciImage: forbidden,
  deleteImage: forbidden,
};

const setup = async (
  onBuild?: () => Promise<void>,
  waitBeforeBuild?: () => Promise<void>,
  url: string = databaseUrl ?? "",
  mode: Parameters<typeof nativeBuilderFixture>[0] = "normal",
) => {
  const db = await createSealantDB(url);
  const owner = `usr_stage2b_${randomUUID()}`;
  await Effect.runPromise(
    db.insert(user).values({ id: owner, name: "stage2b", email: `${owner}@example.invalid` }),
  );
  const fixture = await nativeBuilderFixture(mode);
  const builder: IBoatSnapshotBuilder = {
    plan: fixture.builder.plan.bind(fixture.builder),
    build: async (input) => {
      await waitBeforeBuild?.();
      const result = await fixture.builder.build(input);
      await onBuild?.();
      return result;
    },
    findPublished: fixture.builder.findPublished.bind(fixture.builder),
    remove: fixture.builder.remove.bind(fixture.builder),
    cleanup: fixture.builder.cleanup.bind(fixture.builder),
    journals: fixture.builder.journals.bind(fixture.builder),
    reconcileBuild: fixture.builder.reconcileBuild.bind(fixture.builder),
  };
  const catalog = await Effect.runPromise(
    BoatNativeCatalog.pipe(
      Effect.provide(
        boatNativeCatalogLayer({ deploymentId: owner, builder }).pipe(
          Layer.provide(Layer.succeed(SealantDB, db)),
        ),
      ),
    ),
  );
  const repoLayer = Layer.mergeAll(
    ConnectedAccountRepoLive,
    WorkspaceAttemptRepoLive,
    CredentialPlacementRepoLive,
    WorkspaceBuildJobRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceRepoLive,
    WorkspaceCredentialHomeRepoLive,
  ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));
  const repos = await Effect.runPromise(
    Effect.gen(function* () {
      return {
        jobs: yield* WorkspaceBuildJobRepo,
        attempts: yield* WorkspaceAttemptRepo,
        instances: yield* WorkspaceRuntimeInstanceRepo,
        workspaces: yield* WorkspaceRepo,
        accounts: yield* ConnectedAccountRepo,
        homes: yield* WorkspaceCredentialHomeRepo,
        placements: yield* CredentialPlacementRepo,
      };
    }).pipe(Effect.provide(repoLayer)),
  );
  const spec = newWorkspaceSchema.parse({
    ...fixture.spec,
    target: { ...fixture.spec.target, runtime: { family: "boat", mode: "require" } },
  });
  const launches: NativePublication[] = [];
  const launchInputs: RuntimeLaunch<NativePublication>[] = [];
  const adapter: RuntimeAdapter<NativePublication> = {
    id: "boat",
    supports: () => ({ supported: true }),
    launch: async (input, hooks) => {
      launches.push(input.publication);
      launchInputs.push(input);
      const identity = {
        adapter: "boat" as const,
        resourceId: `test-${input.runId}`,
        reference: `test-${input.runId}`,
      };
      await hooks?.onStarted?.(identity);
      await hooks?.onReady?.(identity);
      return { ...identity, status: "ready" };
    },
    stop: forbidden,
  };
  const enqueue = async (
    scope: NativePublicationKey["scope"] = { kind: "owner", ownerUserId: owner },
    availableAt?: Date,
  ) => {
    const attempt = await Effect.runPromise(
      repos.attempts.createQueuedAttempt({ id: randomUUID(), ownerUserId: owner }),
    );
    const runId = attempt.id,
      id = randomUUID();
    await Effect.runPromise(
      repos.jobs.insertQueuedJob({
        id,
        runId,
        registryId: "stage2b",
        repository: "stage2b",
        tag: "test",
        requestPayload: spec,
        ...(availableAt === undefined ? {} : { availableAt }),
        imageScope: scope,
      }),
    );
    return {
      id,
      runId,
      scope,
      consumer: () => nativeArtifactConsumerSchema.parse({ runId, runtimeInstanceId: runId }),
    };
  };
  const options = (id: string) => ({
    boatAdmissionOwnerIds: [owner],
    db,
    jobId: id,
    workerId: "stage2b",
    leaseDurationMs: 300,
    runtimes: [{ kind: "boat-native" as const, artifacts: catalog, adapter }],
    defaultRuntimeAdapterId: "boat" as const,
    registryClient: registry,
    launchMaterialStager: {
      stage: async () => ({}),
      removeSecretEnv: async () => undefined,
      removeAll: async () => undefined,
    },
  });
  return {
    db,
    owner,
    fixture,
    catalog,
    adapter,
    ...repos,
    spec,
    launches,
    launchInputs,
    enqueue,
    options,
  };
};

const noop = async () => {};

describe.skipIf(!enabled)("native publication worker and persistence (disposable Postgres)", () => {
  it("logs safe guest command diagnostics through the real failed build job", async () => {
    await withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
      const s = await setup(undefined, undefined, url, "command-failed");
      const job = await s.enqueue();
      await expect(processWorkspaceBuildJob(s.options(job.id))).rejects.toMatchObject({
        _tag: "WorkspaceBuildJobProcessingError",
        message: expect.stringContaining("installer refused package"),
        cause: {
          _tag: "NativeCatalogError",
          commandFailure: { step: "install-recipe", exitCode: 42, timedOut: false },
        },
      });
      const stored = await Effect.runPromise(s.jobs.getJobById(job.id));
      expect(stored?.status).toBe("failed");
      expect(stored?.errorMessage).toContain("installer refused package");
      expect(JSON.stringify(stored)).not.toContain("fixture-private-token");
      expect(s.launches).toEqual([]);
      expect(s.fixture.deleted()).toBe(true);
      expect(s.fixture.posts()).toBe(0);
    });
  });

  it.each(["transport-failed", "provider-http-failed"] as const)(
    "logs safe provider failure through the real build job: %s",
    async (mode) => {
      await withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
        const s = await setup(undefined, undefined, url, mode);
        const job = await s.enqueue();
        const providerFailure = {
          operation: "execute",
          status: mode === "transport-failed" ? null : 503,
          causeClass: mode === "transport-failed" ? "UND_ERR_SOCKET" : null,
          step: "install-recipe",
        };
        await expect(processWorkspaceBuildJob(s.options(job.id))).rejects.toMatchObject({
          _tag: "WorkspaceBuildJobProcessingError",
          message: expect.stringContaining(JSON.stringify(providerFailure)),
          cause: { _tag: "NativeCatalogError", providerFailure },
        });
        const stored = await Effect.runPromise(s.jobs.getJobById(job.id));
        expect(stored?.status).toBe("failed");
        expect(stored?.errorMessage).toContain(JSON.stringify(providerFailure));
        expect(JSON.stringify(stored)).not.toContain("private-token");
        expect(s.launches).toEqual([]);
        expect(s.fixture.deleted()).toBe(true);
        expect(s.fixture.posts()).toBe(0);
      });
    },
  );

  it("launches a repository-created UUID attempt through the real build job and reloads its consumer", async () => {
    const s = await setup();
    const job = await s.enqueue();
    expect(job.runId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect((await Effect.runPromise(s.attempts.getAttemptById(job.runId)))?.ownerUserId).toBe(
      s.owner,
    );
    const publication = await processWorkspaceBuildJob(s.options(job.id));
    expect(publication?.kind).toBe("boat-native");
    expect(s.launchInputs).toMatchObject([{ runId: job.runId }]);
    expect(await Effect.runPromise(s.instances.getRuntimeInstanceByRunId(job.runId))).toMatchObject(
      {
        runId: job.runId,
        status: "ready",
        publicationId: publication?.publicationId,
      },
    );
    expect(await Effect.runPromise(nativeConsumerRows(s.db, job.runId))).toEqual([
      { state: "pending", publicationId: publication?.publicationId },
    ]);
    expect(
      await Effect.runPromise(
        s.catalog.acquire({
          spec: s.spec,
          scope: job.scope,
          consumer: job.consumer(),
        }),
      ),
    ).toEqual(publication);
    expect(s.fixture.posts()).toBe(1);
  });
  it("refuses an owner outside the operator allowlist before native construction or reservation", async () => {
    const s = await setup();
    const job = await s.enqueue();
    await expect(
      processWorkspaceBuildJob({ ...s.options(job.id), boatAdmissionOwnerIds: [] }),
    ).rejects.toMatchObject({ errorCode: "boat-admission-refused" });
    expect(s.fixture.posts()).toBe(0);
    expect(s.launches).toHaveLength(0);
    expect(await Effect.runPromise(nativeConsumerRows(s.db, job.runId))).toEqual([]);
  });

  it("rechecks the explicit owner allowlist when recovering a lost delivery", async () => {
    await withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
      const s = await setup(undefined, undefined, url);
      const job = await s.enqueue();
      expect(
        await reapStaleWorkspaceBuildJobs({
          ...s.options(job.id),
          boatAdmissionOwnerIds: [],
          maxReapsPerTick: 1,
        }),
      ).toBe(0);
      expect(s.fixture.posts()).toBe(0);
      expect(s.launches).toHaveLength(0);
      expect(await Effect.runPromise(nativeConsumerRows(s.db, job.runId))).toEqual([]);
      expect((await Effect.runPromise(s.jobs.getJobById(job.id)))?.errorCode).toBe(
        "boat-admission-refused",
      );
    });
  });

  it("recovers a queued scoped job whose broker wakeup was lost", async () => {
    await withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
      const s = await setup(undefined, undefined, url);
      const domainId = `rdm:${randomUUID()}`;
      await Effect.runPromise(seedImageScope(s.db, domainId, s.owner));
      const scope = { kind: "resource-domain", domainId } as const;
      const home = { path: "/home/m4lice000", uid: 40001, gid: 40000 };
      const accountId = `cacc_${randomUUID()}`;
      const payload = JSON.stringify({ token: "gho_FAKE_boat_queue" });
      const cipher: CredentialCipherService = {
        encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "test" }),
        decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
      };
      await Effect.runPromise(
        s.accounts.createConnectedAccount({
          id: accountId,
          ownerUserId: s.owner,
          provider: "github",
          name: "queue",
          kind: "oauth-token",
          encryptedPayload: `sealed:${payload}`,
          encryptionKeyId: "test",
          payloadSha256: sha256Hex(payload),
          metadata: {},
        }),
      );
      s.spec.runtime.credentialsHome = home;
      s.spec.runtime.credentialRefs = [
        { provider: "github", ref: `connected-account:${accountId}` },
      ];
      const later = await s.enqueue(scope, new Date(Date.now() + 3600000));
      const job = await s.enqueue(scope);
      const next = await s.enqueue(scope);
      const workspaceId = `wks_${randomUUID()}`;
      const binds = [{ mountPath: "/workspace", subpath: "retained" }];
      await Effect.runPromise(
        s.workspaces.createWorkspace({
          id: workspaceId,
          name: "queue",
          ownerUserId: s.owner,
        }),
      );
      await Effect.runPromise(
        s.workspaces.linkWorkspaceAttempt({ workspaceId, attemptId: job.runId }),
      );
      await Effect.runPromise(s.workspaces.setWorkspaceBinds({ id: workspaceId, binds }));
      expect(
        await reapStaleWorkspaceBuildJobs({
          ...s.options(job.id),
          maxReapsPerTick: 1,
          credentialCipher: cipher,
        }),
      ).toBe(1);
      expect(s.launches).toHaveLength(1);
      expect(s.launchInputs[0]).toMatchObject({
        workspaceId,
        binds,
        credentialFiles: [
          {
            path: home.path,
            home: { uid: home.uid, gid: home.gid, providers: ["github"] },
          },
        ],
      });
      expect(await Effect.runPromise(s.homes.listByRunId(job.runId))).toEqual([
        expect.objectContaining({ home: home.path, onBehalfOfUserId: s.owner }),
      ]);
      expect(
        (await Effect.runPromise(s.placements.state({ runId: job.runId, home: home.path })))
          .placements,
      ).toEqual([expect.objectContaining({ accountId, provider: "github", state: "ready" })]);
      expect((await Effect.runPromise(s.jobs.getJobById(job.id)))?.status).toBe("succeeded");
      expect((await Effect.runPromise(s.jobs.getJobById(later.id)))?.status).toBe("queued");
      expect((await Effect.runPromise(s.jobs.getJobById(next.id)))?.status).toBe("queued");
      expect(
        (await Effect.runPromise(s.instances.getRuntimeInstanceByRunId(job.runId)))?.status,
      ).toBe("ready");
    });
  });

  it("waits under the same two bindings, builds once, and persists exact native artifacts across restart", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const s = await setup(undefined, async () => {
      entered.resolve();
      await release.promise;
    });
    const a = await s.enqueue(),
      b = await s.enqueue();
    const pending = Promise.withResolvers<void>();
    const artifacts = {
      ...s.catalog,
      acquire: (input: Parameters<typeof s.catalog.acquire>[0]) =>
        s.catalog.acquire(input).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error instanceof NativeCatalogError && error.code === "publication-pending")
                pending.resolve();
            }),
          ),
        ),
    };
    const run = (id: string) =>
      processWorkspaceBuildJob({
        ...s.options(id),
        runtimes: [{ kind: "boat-native", artifacts, adapter: s.adapter }],
      });
    const first = run(a.id);
    await entered.promise;
    const second = run(b.id);
    await pending.promise;
    const pinsBefore = await Effect.runPromise(nativeConsumerRows(s.db, b.runId));
    expect(pinsBefore).toHaveLength(1);
    expect(s.launches).toHaveLength(0);
    release.resolve();
    const [pa, pb] = await Promise.all([first, second]);
    expect(pa?.kind).toBe("boat-native");
    expect(pb).toEqual(pa);
    expect(s.fixture.posts()).toBe(1);
    expect(s.launches).toEqual([pa, pa]);
    const job = await Effect.runPromise(s.jobs.getJobById(a.id));
    const instance = await Effect.runPromise(s.instances.getRuntimeInstanceByRunId(a.runId));
    expect(job?.publication).toEqual(pa);
    expect(instance?.publication).toEqual(pa);
    expect(instance?.imageScope).toEqual(a.scope);
    expect(job?.resultPayload?.artifacts[0]?.kind).toBe("boat-native-snapshot");
    expect(job?.publishedDigest).toBeNull();
    expect(resolveWorkspacePublishedImage(job)).toBeUndefined();
    expect(
      Schema.decodeUnknownSync(publicPublicationSchema)(resolveWorkspacePublication(job)),
    ).toMatchObject({ kind: "boat-native", publicationId: pa?.publicationId });
    const restarted = await Effect.runPromise(
      s.catalog.acquire({ spec: s.spec, scope: a.scope, consumer: a.consumer() }),
    );
    expect(restarted).toEqual(pa);
    expect(s.fixture.posts()).toBe(1);
    expect(await Effect.runPromise(nativeConsumerRows(s.db, a.runId))).toEqual([
      { state: "pending", publicationId: pa?.publicationId },
    ]);
    expect(await Effect.runPromise(nativeConsumerRows(s.db, b.runId))).toEqual(pinsBefore);
    expect((await Effect.runPromise(s.jobs.getJobById(b.id)))?.attemptCount).toBe(1);
    expect(await Effect.runPromise(s.jobs.listPublishedImages())).not.toContainEqual(
      expect.objectContaining({ jobId: a.id }),
    );
  });

  it("revalidates revoked domain membership after the build, retaining the exact pin without launch", async () => {
    let revoke = noop;
    const s = await setup(() => revoke());
    const domainId = `rdm:${randomUUID()}`;
    await Effect.runPromise(seedImageScope(s.db, domainId, s.owner));
    revoke = async () => {
      await Effect.runPromise(revokeImageScope(s.db, domainId));
    };
    const job = await s.enqueue({ kind: "resource-domain", domainId });
    await expect(processWorkspaceBuildJob(s.options(job.id))).rejects.toMatchObject({
      errorCode: "image-scope-unavailable",
    });
    expect(s.launches).toHaveLength(0);
    expect(await Effect.runPromise(nativeConsumerRows(s.db, job.runId))).toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);
    expect((await Effect.runPromise(s.jobs.getJobById(job.id)))?.status).toBe("failed");
  });

  it("does not commit or launch after a job claim changes during native preparation", async () => {
    let takeover = noop;
    const s = await setup(() => takeover());
    const job = await s.enqueue();
    takeover = async () => {
      await Effect.runPromise(takeWorkspaceJobClaim(s.db, job.id));
    };
    expect(await processWorkspaceBuildJob(s.options(job.id))).toBeNull();
    expect(s.launches).toHaveLength(0);
    expect((await Effect.runPromise(s.jobs.getJobById(job.id)))?.status).toBe("running");
    expect(await Effect.runPromise(nativeConsumerRows(s.db, job.runId))).toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);
  });

  it("rechecks scope after launch material staging before admitting an executor", async () => {
    const s = await setup();
    const domainId = `rdm:${randomUUID()}`;
    await Effect.runPromise(seedImageScope(s.db, domainId, s.owner));
    const job = await s.enqueue({ kind: "resource-domain", domainId });
    const options = s.options(job.id);
    await expect(
      processWorkspaceBuildJob({
        ...options,
        launchMaterialStager: {
          ...options.launchMaterialStager,
          stage: async () => {
            await Effect.runPromise(revokeImageScope(s.db, domainId));
            return {};
          },
        },
      }),
    ).rejects.toMatchObject({ errorCode: "image-scope-unavailable" });
    expect(s.launches).toHaveLength(0);
    expect((await Effect.runPromise(s.jobs.getJobById(job.id)))?.publication?.kind).toBe(
      "boat-native",
    );
    expect(await Effect.runPromise(nativeConsumerRows(s.db, job.runId))).toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);
  });

  it("does not launch after ownership changes during launch material staging", async () => {
    const s = await setup();
    const job = await s.enqueue();
    const options = s.options(job.id);
    await expect(
      processWorkspaceBuildJob({
        ...options,
        launchMaterialStager: {
          ...options.launchMaterialStager,
          stage: async () => {
            await Effect.runPromise(
              s.instances.upsertRuntimeInstance({
                runId: job.runId,
                status: "pending",
                launchOwner: "successor",
                launchLeaseMs: 60000,
              }),
            );
            return {};
          },
        },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("The launch was abandoned") });
    expect(s.launches).toHaveLength(0);
    expect(
      (await Effect.runPromise(s.instances.getRuntimeInstanceByRunId(job.runId)))?.launchOwner,
    ).toBe("successor");
    expect(await Effect.runPromise(nativeConsumerRows(s.db, job.runId))).toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);
  });

  it("keeps committed publication success and its pin when the success reply is lost", async () => {
    const s = await setup();
    const job = await s.enqueue();
    const lost = {
      ...s.jobs,
      markJobSucceeded: (input: Parameters<typeof s.jobs.markJobSucceeded>[0]) =>
        s.jobs.markJobSucceeded(input).pipe(
          Effect.andThen(
            Effect.fail(
              new WorkspaceBuildJobRepoUnexpectedError({
                operation: "markJobSucceeded",
                message: "lost committed reply",
                cause: new Error("local fault"),
              }),
            ),
          ),
        ),
    };
    const layer = Layer.mergeAll(
      WorkspaceRuntimeInstanceRepoLive,
      Layer.succeed(WorkspaceBuildJobRepo, lost),
    ).pipe(Layer.provide(Layer.succeed(SealantDB, s.db)));
    const { GitHubInstallationRepoLive, GitHubInstallationRepositoryCacheRepoLive } =
      await import("@sealant/db");
    const context = Layer.mergeAll(
      layer,
      WorkspaceAttemptRepoLive,
      GitHubInstallationRepoLive,
      GitHubInstallationRepositoryCacheRepoLive,
      ConnectedAccountRepoLive,
    ).pipe(Layer.provide(Layer.succeed(SealantDB, s.db)));
    await expect(
      Effect.runPromise(
        processWorkspaceBuildJobEffect(s.options(job.id)).pipe(Effect.provide(context)),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("lost committed reply") });
    const saved = await Effect.runPromise(s.jobs.getJobById(job.id));
    expect(saved?.status).toBe("succeeded");
    expect(s.launches).toHaveLength(0);
    expect(
      await Effect.runPromise(
        s.catalog.acquire({ spec: s.spec, scope: job.scope, consumer: job.consumer() }),
      ),
    ).toEqual(saved?.publication);
    expect(await Effect.runPromise(nativeConsumerRows(s.db, job.runId))).toEqual([
      { state: "pending", publicationId: saved?.publicationId },
    ]);
  });

  it("inspects the native recipe through its owner without reserving or invoking a provider", async () => {
    const s = await setup();
    const inspected = await Effect.runPromise(
      Effect.flatMap(BoatImageInspection, (inspector) => inspector.plan(s.spec)).pipe(
        Effect.provide(boatImageInspectionLayer(s.fixture.bundle)),
      ),
    );
    const planned = await s.fixture.builder.plan(s.spec);
    if (!planned.ok) throw planned.error;
    expect(inspected.planHash).toBe(planned.value.recipeHash);
    expect(s.fixture.mutations).toEqual([]);
  });

  it("keeps exact publication identity and its pin after an uncertain allocated launch", async () => {
    const s = await setup();
    const job = await s.enqueue();
    const adapter: RuntimeAdapter<NativePublication> = {
      ...s.adapter,
      launch: async (_input, hooks) => {
        const identity = {
          adapter: "boat" as const,
          resourceId: "uncertain-allocation",
          reference: "uncertain-allocation",
        };
        await hooks?.onStarted?.(identity);
        throw new LaunchRetainedError(identity, new Error("readiness reply lost"));
      },
    };
    await expect(
      processWorkspaceBuildJob({
        ...s.options(job.id),
        runtimes: [{ kind: "boat-native", artifacts: s.catalog, adapter }],
      }),
    ).rejects.toMatchObject({ errorCode: "launch-retained" });
    const saved = await Effect.runPromise(s.jobs.getJobById(job.id));
    expect(saved?.status).toBe("succeeded");
    expect(
      (await Effect.runPromise(s.instances.getRuntimeInstanceByRunId(job.runId)))?.publication,
    ).toEqual(saved?.publication);
    expect(await Effect.runPromise(nativeConsumerRows(s.db, job.runId))).toEqual([
      { state: "pending", publicationId: saved?.publicationId },
    ]);
  });

  it("parses legacy OCI and MicroVM jobs and preserves tagged MicroVM history without OCI columns", async () => {
    const s = await setup();
    const hash = "b".repeat(64);
    for (const kind of ["oci", "microvm", "tagged-microvm"] as const) {
      const job = await s.enqueue();
      const claim = await Effect.runPromise(
        s.jobs.claimJobById({ id: job.id, workerId: "legacy", leaseDurationMs: 60000 }),
      );
      if (!claim) throw new Error("missing claim");
      const reference = "arn:aws:lambda:eu-central-1:123456789012:microvm-image:legacy:1.0";
      await Effect.runPromise(
        s.jobs.markJobSucceeded({
          id: job.id,
          claim: { workerId: "legacy", attemptCount: claim.attemptCount },
          builderId: "test",
          ...(kind === "tagged-microvm"
            ? {
                publication: {
                  kind: "microvm" as const,
                  publicationId: job.id,
                  image: {
                    imageArn: reference.slice(0, reference.lastIndexOf(":")),
                    imageVersion: "1.0",
                    planHash: hash,
                  },
                  evidence: { planHash: hash },
                },
              }
            : {
                publishedReference: kind === "oci" ? "legacy:test" : reference,
                publishedDigestReference: kind === "oci" ? `legacy@sha256:${hash}` : reference,
                publishedDigest: `sha256:${hash}`,
              }),
        }),
      );
      const saved = await Effect.runPromise(s.jobs.getJobById(job.id));
      expect(saved?.publication?.kind).toBe(kind === "oci" ? "oci" : "microvm");
      expect(
        (await Effect.runPromise(s.jobs.listPublishedImages())).find(
          (image) => image.jobId === job.id,
        )?.publication,
      ).toEqual(saved?.publication);
      if (kind === "tagged-microvm") expect(saved?.publishedDigest).toBeNull();
      await Effect.runPromise(
        s.instances.upsertRuntimeInstance({
          runId: job.runId,
          status: "pending",
          reference: "legacy-executor",
        }),
      );
      expect(
        (await Effect.runPromise(s.instances.getRuntimeInstanceByRunId(job.runId)))?.publication,
      ).toBeNull();
    }
  });

  it("refuses replacement bindings and malformed serialized jobs and runtime rows", async () => {
    const s = await setup();
    const job = await s.enqueue();
    const publication = await processWorkspaceBuildJob(s.options(job.id));
    if (publication?.kind !== "boat-native") throw new Error("missing native publication");
    await expect(
      Effect.runPromise(
        s.instances.upsertRuntimeInstance({
          runId: job.runId,
          status: "pending",
          publication: { ...publication, publicationId: randomUUID() },
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(
        s.instances.upsertRuntimeInstance({
          runId: job.runId,
          status: "pending",
          imageScope: { kind: "owner", ownerUserId: "different-owner" },
        }),
      ),
    ).rejects.toBeDefined();
    expect(
      (await Effect.runPromise(s.instances.getRuntimeInstanceByRunId(job.runId)))?.publication,
    ).toEqual(publication);
    await Effect.runPromise(
      corruptWorkspacePublication(s.db, "runtime", job.runId, { kind: "boat-native" }),
    );
    await expect(
      Effect.runPromise(s.instances.getRuntimeInstanceByRunId(job.runId)),
    ).rejects.toMatchObject({ _tag: "WorkspaceRuntimeInstanceRepoUnexpectedError" });
    await Effect.runPromise(corruptWorkspacePublication(s.db, "runtime", job.runId, publication));
    await Effect.runPromise(
      corruptWorkspacePublication(s.db, "job", job.id, {
        kind: "oci",
        image: { digest: "native-recipe" },
      }),
    );
    await expect(Effect.runPromise(s.jobs.getJobById(job.id))).rejects.toMatchObject({
      _tag: "WorkspaceBuildJobRepoUnexpectedError",
    });
    await Effect.runPromise(corruptWorkspacePublication(s.db, "job", job.id, publication));
  });
});
