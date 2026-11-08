import { randomUUID } from "node:crypto";

import { workspacePublicationSchema as publicPublicationSchema } from "@sealant/api-contracts";
import {
  CredentialCipher,
  credentialCipherLayer,
  sha256Hex,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  BoatTunnelRepo,
  WorkspaceCaptureDrainRepo,
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  WorkspaceCaptureDrainRepoLive,
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
import { Context, Effect, Layer, Schema } from "effect";
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
import { boatProofConfigSchema } from "../operator/boat-live-check.js";
import { makeBoatProofCore } from "../operator/boat-proof-core.js";
import type { RegistryClient } from "../registry/client.js";
import { BoatRuntimeAdapter, BoatAdapterError } from "../runtime/boat/adapter.js";
import { BoatFinalClose } from "../runtime/boat/final-close.js";
import { boatSessionDaemon } from "../runtime/boat/session-daemon.fixture.js";
import { boatSessionFixture } from "../runtime/boat/session.fixture.js";
import { startCaptureChannel } from "../runtime/capture-channel.fixture.js";
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
  daemon?: Awaited<ReturnType<typeof boatSessionDaemon>>,
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
    WorkspaceCaptureDrainRepoLive,
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
  const session = daemon === undefined ? undefined : await boatSessionFixture(db, owner, daemon);
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
    launch?: { spec: typeof spec; secretEnvSealed: string },
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
        requestPayload: launch?.spec ?? spec,
        ...(launch === undefined ? {} : { secretEnvSealed: launch.secretEnvSealed }),
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
    runtimes: [
      { kind: "boat-native" as const, artifacts: catalog, adapter: session?.adapter ?? adapter },
    ],
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
    session,
    launchInputs,
    enqueue,
    options,
  };
};

const noop = async () => {};

describe.skipIf(!enabled)("native publication worker and persistence (disposable Postgres)", () => {
  it("builds, readies, shells, FINAL closes and resumes a fresh Boat VM through the real worker", async () => {
    const bundle = process.env.SEALANT_BOAT_RUNTIME_BUNDLE;
    if (bundle === undefined) throw new Error("exact runtime bundle required");
    const daemon = await boatSessionDaemon(bundle);
    const channel = await startCaptureChannel({ token: "local-capture-only", worktreeId: "wt_1" });
    try {
      await withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
        const s = await setup(undefined, undefined, url, "normal", daemon);
        const session = s.session;
        if (session === undefined) throw new Error("missing session fixture");
        try {
          const workspaceId = randomUUID();
          await Effect.runPromise(
            s.workspaces.createWorkspace({
              id: workspaceId,
              name: "Boat chain",
              ownerUserId: s.owner,
            }),
          );
          const cipher = await Effect.runPromise(
            credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") }).pipe(
              Layer.build,
              Effect.map((ctx) => Context.get(ctx, CredentialCipher)),
              Effect.scoped,
            ),
          );
          const spec = newWorkspaceSchema.parse({
            ...s.spec,
            sources: {
              ...s.spec.sources,
              workspace: {
                kind: "capture",
                endpoint: channel.endpoint,
                worktreeId: "wt_1",
                harnessHome: "/workspace/harness-home",
              },
            },
            customization: { ...s.spec.customization, applyDotfiles: false },
            lifecycle: {
              setup: [],
              startup: {
                steps: [],
                foreground: { kind: "command", run: "sleep infinity", shell: "bash" },
              },
            },
          });
          const launch = async () => {
            const sealed = await Effect.runPromise(
              cipher.encrypt(JSON.stringify({ SEALANT_CAPTURE_TOKEN: "local-capture-only" })),
            );
            const job = await s.enqueue(undefined, undefined, {
              spec,
              secretEnvSealed: sealed.sealed,
            });
            await Effect.runPromise(
              s.workspaces.linkWorkspaceAttempt({ workspaceId, attemptId: job.runId }),
            );
            channel.state.executor = job.runId;
            try {
              await processWorkspaceBuildJob({
                ...s.options(job.id),
                credentialCipher: cipher,
                launchMaterialStager: {
                  ...s.options(job.id).launchMaterialStager,
                  stage: async () => ({
                    secretEnv: { SEALANT_CAPTURE_TOKEN: "local-capture-only" },
                  }),
                },
              });
            } catch (error) {
              expect(session.failures).toEqual([]);
              throw error;
            }
            const instance = await Effect.runPromise(
              s.instances.getRuntimeInstanceByRunId(job.runId),
            );
            expect(instance).toMatchObject({
              adapter: "boat",
              status: "ready",
              sourceKind: "capture",
              launchOwner: null,
            });
            expect(instance?.resourceId).toMatch(/^bx_/);
            return { job, instance };
          };
          const stop = async (runId: string, sandboxId: string) => {
            await Effect.runPromise(s.instances.markStopRequested({ runId, stopReason: "user" }));
            try {
              expect(
                await session.adapter.stop({ resourceId: sandboxId, reference: runId }),
              ).toMatchObject({ outcome: "stopped" });
            } catch (error) {
              if (!(error instanceof BoatAdapterError) || error.code !== "close-pending")
                throw error;
              // FINAL may first answer "sealing". The ordinary worker resumes that same close.
              for (let tick = 0; tick < 100; tick++) {
                const observed = await session.runtime.runPromise(
                  Effect.flatMap(BoatFinalClose, (owner) => owner.reconcile({ limit: 20 })),
                );
                if (
                  observed.entries.some(
                    (entry) => entry.runId === runId && entry.outcome === "closed",
                  )
                )
                  break;
                if (tick === 99)
                  throw new Error(`FINAL did not complete: ${JSON.stringify(observed)}`, {
                    cause: error,
                  });
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
              }
            }
            expect(
              await Effect.runPromise(s.instances.getRuntimeInstanceByRunId(runId)),
            ).toMatchObject({ status: "stopped", removedAt: expect.any(Date) });
            expect(
              await session.runtime.runPromise(
                Effect.flatMap(BoatTunnelRepo, (repo) => repo.get(runId)),
              ),
            ).toMatchObject({ released: true, removal: { completed: true } });
            expect(
              await session.runtime.runPromise(
                Effect.flatMap(WorkspaceCaptureDrainRepo, (repo) => repo.getByRunId(runId)),
              ),
            ).toMatchObject({ deletionState: "deleted" });
            expect((await Effect.runPromise(nativeConsumerRows(s.db, runId)))[0]?.state).toBe(
              "released",
            );
          };
          // Match run 5's leftover: a real failed launch, ready publication and pending pin,
          // with no allocation. A different consumer must still reuse that publication.
          const failedSecret = await Effect.runPromise(
            cipher.encrypt(JSON.stringify({ SEALANT_CAPTURE_TOKEN: "local-capture-only" })),
          );
          const failed = await s.enqueue(undefined, undefined, {
            spec,
            secretEnvSealed: failedSecret.sealed,
          });
          await Effect.runPromise(
            s.workspaces.linkWorkspaceAttempt({ workspaceId, attemptId: failed.runId }),
          );
          await expect(
            processWorkspaceBuildJob({
              ...s.options(failed.id),
              credentialCipher: cipher,
              runtimes: [
                {
                  kind: "boat-native",
                  artifacts: s.catalog,
                  adapter: new BoatRuntimeAdapter({
                    deploymentId: s.owner,
                    ownerIds: [],
                    runtime: session.runtime,
                  }),
                },
              ],
            }),
          ).rejects.toMatchObject({ cause: { code: "admission-refused" } });
          const failedPin = (await Effect.runPromise(nativeConsumerRows(s.db, failed.runId)))[0];
          expect(failedPin?.state).toBe("pending");
          expect(session.provider).toBeUndefined();
          const first = await launch();
          expect(first.instance?.publicationId).toBe(failedPin?.publicationId);
          expect(s.fixture.posts()).toBe(1);
          if (first.instance?.resourceId == null) throw new Error("missing first VM");
          expect(session.provider?.creates).toHaveLength(1);
          expect(
            await session.shell(
              first.job.runId,
              "printf intact > /workspace/repo/user-edit; cat /workspace/repo/user-edit",
            ),
          ).toEqual({ exitCode: 0, stdout: "intact" });
          await stop(first.job.runId, first.instance.resourceId);
          expect(channel.state.head).toBeDefined();
          channel.state.epoch++;
          const resumed = await launch();
          expect(resumed.instance?.publicationId).toBe(first.instance.publicationId);
          expect(resumed.instance?.resourceId).not.toBe(first.instance.resourceId);
          expect(await session.shell(resumed.job.runId, "cat /workspace/repo/user-edit")).toEqual({
            exitCode: 0,
            stdout: "intact",
          });
          if (resumed.instance?.resourceId == null) throw new Error("missing resumed VM");
          await stop(resumed.job.runId, resumed.instance.resourceId);
          expect(daemon.boots).toHaveLength(2);
          expect(new Set(session.guest.targets.map((target) => target.bootId)).size).toBe(2);
          expect((await Effect.runPromise(nativeConsumerRows(s.db, failed.runId)))[0]?.state).toBe(
            "pending",
          );
          expect(session.provider?.creates).toHaveLength(2);
          expect(session.provider?.deleteCalls).toBe(2);
          expect(session.gateway.removeCalls).toBe(2);
          expect(channel.state.errors).toEqual([]);
          expect(session.failures).toEqual([]);
        } finally {
          await session.dispose();
        }
      });
    } finally {
      await channel.close();
      await daemon.dispose();
    }
  }, 120_000);
  it("accounts only for ready owned publication snapshots with the provider's exact immutable identity", async () => {
    await withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
      const s = await setup(undefined, undefined, url);
      const job = await s.enqueue();
      await processWorkspaceBuildJob(s.options(job.id));
      const publication = s.launches[0];
      if (publication === undefined) throw new Error("missing ready publication");
      const core = makeBoatProofCore({
        config: boatProofConfigSchema.parse({
          origin: "https://mend.example.invalid",
          projectId: "proof",
          ownerId: s.owner,
          deploymentId: s.owner,
          resourceHost: "db",
          resourcePort: 5432,
        }),
        databaseUrl: url,
        builderOwner: s.fixture.owner,
        journalDirectory: s.fixture.root,
        api: s.fixture.api,
      });
      try {
        const census = {
          snapshots: [publication.snapshot.identity.name, "unexplained"],
          sandboxes: ["bx_3456789a"],
          pages: 1,
        };
        expect(await core.accountInventory(census)).toEqual({
          ...census,
          retainedSnapshots: [
            { publicationId: publication.publicationId, name: publication.snapshot.identity.name },
          ],
        });
        s.fixture.replaceSnapshot(publication.snapshot.identity.name);
        expect(await core.accountInventory(census)).toEqual({ ...census, retainedSnapshots: [] });
      } finally {
        await core.dispose();
      }
    });
  });
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

  it.each(["transport-failed", "provider-http-failed", "status-http-failed"] as const)(
    "logs safe provider failure through the real build job: %s",
    async (mode) => {
      await withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
        const s = await setup(undefined, undefined, url, mode);
        const job = await s.enqueue();
        const providerFailure = {
          operation: mode === "status-http-failed" ? "commandStatus" : "execute",
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

  it("records exhausted native build recovery as failed jobs and runtimes instead of starting forever", async () => {
    await withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
      const s = await setup(undefined, undefined, url, "command-failed");
      for (let attempt = 1; attempt <= 3; attempt++) {
        const job = await s.enqueue();
        const code = attempt === 3 ? "publication-build-attempts-exhausted" : "mechanism-failed";
        await expect(processWorkspaceBuildJob(s.options(job.id))).rejects.toMatchObject({
          errorCode: code,
        });
        expect(await Effect.runPromise(s.jobs.getJobById(job.id))).toMatchObject({
          status: "failed",
          errorCode: code,
        });
        expect(
          await Effect.runPromise(s.instances.getRuntimeInstanceByRunId(job.runId)),
        ).toMatchObject({ status: "failed", errorCode: code });
        if (attempt === 3) {
          const stored = await Effect.runPromise(s.jobs.getJobById(job.id));
          expect(stored?.errorMessage).toContain("failed twice");
          expect(stored?.errorMessage).toContain("native-guest-command-failed");
        }
      }
      expect(s.fixture.mutations.filter((m) => m === "POST /api/v1/sandboxes")).toHaveLength(2);
      expect(s.launches).toEqual([]);
    });
  });

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
