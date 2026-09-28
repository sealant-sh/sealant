/**
 * Review 5 #1 against a REAL Postgres: a build can outlive its claim lease, and another worker
 * then claims the same job. Both builds finish; only the claim that still holds the job may commit
 * success (and go on to launch the run). Without that fence both pipelines launched, and a second
 * launch of a MicroVM capture run adopts — and could tear down — the first one's executor. Gated
 * on SEALANT_TEST_DATABASE_URL (a disposable database with the migrations applied; it writes rows
 * under fresh ids and leaves them).
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/build-job-claim.db.test.ts
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  createSealantDB,
  SealantDB,
  user,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceBuildJobRepo,
  WorkspaceBuildJobRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  workspaceAttempts,
} from "@sealant/db";
import { newWorkspaceSchema } from "@sealant/validators";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { processWorkspaceBuildJob } from "./process-workspace-build-job.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

describe.skipIf(DATABASE_URL === undefined)(
  "build job success is fenced by its claim (Postgres)",
  () => {
    it("lets only the current claimant commit success after a lease expired and was taken over", async () => {
      const db = await createSealantDB(DATABASE_URL ?? "");
      const id = randomUUID();
      const owner = `user_build_claim_${id}`;
      const run = `run_build_claim_${id}`;
      const job = `job_build_claim_${id}`;
      await Effect.runPromise(
        db.insert(user).values({ id: owner, name: "build claim", email: `${owner}@example.test` }),
      );
      await Effect.runPromise(db.insert(workspaceAttempts).values({ id: run, ownerUserId: owner }));
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* WorkspaceBuildJobRepo;
          yield* repo.insertQueuedJob({
            id: job,
            runId: run,
            registryId: "claim",
            repository: "claim",
            tag: "test",
            requestPayload: newWorkspaceSchema.parse({
              sources: {
                workspace: { kind: "git", provider: "generic", url: "https://example.test/r.git" },
              },
              harness: { id: "opencode" },
            }),
          });
          const now = new Date();
          const a = yield* repo.claimJobById({ id: job, workerId: "A", leaseDurationMs: 100, now });
          const b = yield* repo.claimJobById({
            id: job,
            workerId: "B",
            leaseDurationMs: 100,
            now: new Date(now.getTime() + 101),
          });
          const fields = {
            id: job,
            builderId: "microvm",
            publishedReference: "test",
            publishedDigestReference: "test@sha256:abc",
            publishedDigest: "sha256:abc",
          };
          const aDone = yield* repo.markJobSucceeded({
            ...fields,
            claim: { workerId: "A", attemptCount: a?.attemptCount ?? -1 },
          });
          const bDone = yield* repo.markJobSucceeded({
            ...fields,
            claim: { workerId: "B", attemptCount: b?.attemptCount ?? -1 },
          });
          const bAgain = yield* repo.markJobSucceeded({
            ...fields,
            claim: { workerId: "B", attemptCount: b?.attemptCount ?? -1 },
          });
          return { a, b, aDone, bDone, bAgain };
        }).pipe(
          Effect.provide(
            WorkspaceBuildJobRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db))),
          ),
        ),
      );
      expect(result.a?.workerId).toBe("A");
      expect(result.b?.workerId).toBe("B");
      // A's lease expired and B holds the job: A's success is refused, B's lands, once.
      expect(result.aDone).toBeNull();
      expect(result.bDone?.status).toBe("succeeded");
      expect(result.bAgain).toBeNull();
    });

    // Review 6 #8: a build that outlived its claim FAILS after the job's new claimant built and
    // launched the run. The failure is as fenced as success: the loser writes nothing over the
    // winner's job, attempt or runtime.
    it("keeps the winner's job, attempt and runtime when the expired claimant's build fails", async () => {
      const db = await createSealantDB(DATABASE_URL ?? "");
      const id = randomUUID();
      const owner = `user_build_fail_${id}`;
      const runId = `run_build_fail_${id}`;
      const jobId = `job_build_fail_${id}`;
      await Effect.runPromise(
        db.insert(user).values({ id: owner, name: "build fail", email: `${owner}@example.test` }),
      );
      await Effect.runPromise(
        db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner }),
      );
      const layer = Layer.mergeAll(
        WorkspaceBuildJobRepoLive,
        WorkspaceRuntimeInstanceRepoLive,
        WorkspaceAttemptRepoLive,
      ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));
      const run = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          WorkspaceBuildJobRepo | WorkspaceRuntimeInstanceRepo | WorkspaceAttemptRepo
        >,
      ) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
      await run(
        Effect.gen(function* () {
          yield* (yield* WorkspaceBuildJobRepo).insertQueuedJob({
            id: jobId,
            runId,
            registryId: "fence",
            repository: "fence",
            tag: "fence",
            requestPayload: newWorkspaceSchema.parse({
              sources: { workspace: { kind: "capture", endpoint: "https://mend.example.test/s" } },
              harness: { id: "opencode" },
            }),
            secretEnvSealed: 'sealed:{"SEALANT_CAPTURE_TOKEN":"fence-token"}',
          });
        }),
      );
      const failingA = Promise.withResolvers<never>();
      const startedA = Promise.withResolvers<void>();
      const publishedImage = {
        repository: "fence",
        tag: "fence",
        reference: "fence:fence",
        digestReference: "fence@sha256:a",
        digest: "sha256:a",
      };
      const launches: string[] = [];
      const adapter: RuntimeAdapter = {
        id: "docker",
        supports: () => ({ supported: true }),
        launch: async (_input, hooks) => {
          launches.push("launch");
          const identity = {
            adapter: "docker" as const,
            resourceId: "winning-container",
            reference: "winning-container",
          };
          await hooks?.onStarted?.(identity);
          await hooks?.onReady?.(identity);
          return { ...identity, status: "ready" };
        },
        stop: async () => {
          throw new Error("nothing is stopped here");
        },
      };
      const common = {
        db,
        jobId,
        leaseDurationMs: 1,
        defaultRuntimeAdapterId: "docker" as const,
        registryClient: {
          ping: async () => undefined,
          repositoryExists: async () => false,
          listTags: async () => [],
          getManifest: async () => null,
          headManifest: async () => null,
          discoverExtensions: async () => [],
          publishOciImage: async () => {
            throw new Error("nothing is published here");
          },
          deleteImage: async () => {
            throw new Error("nothing is deleted here");
          },
        },
        credentialCipher: {
          encrypt: (value: string) => Effect.succeed({ sealed: `sealed:${value}`, keyId: "fence" }),
          decrypt: (value: string) => Effect.succeed(value.slice("sealed:".length)),
        },
        launchMaterialStager: {
          stage: async () => ({}),
          removeSecretEnv: async () => undefined,
          removeAll: async () => undefined,
        },
      };
      const a = processWorkspaceBuildJob({
        ...common,
        workerId: "A",
        runtimes: [
          {
            adapter,
            imageBuilder: {
              isolation: "isolated",
              plan: undefined,
              buildAndPublish: async () => {
                startedA.resolve();
                return failingA.promise;
              },
            },
          },
        ],
      }).catch((error: unknown) => error);
      await startedA.promise;
      // A's 1 ms lease lapses under its build; B claims the job, builds it and launches the run.
      await delay(20);
      const b = await processWorkspaceBuildJob({
        ...common,
        workerId: "B",
        runtimes: [
          {
            adapter,
            imageBuilder: {
              isolation: "isolated",
              plan: undefined,
              buildAndPublish: async () => ({
                publishedImage,
                build: { builder: { id: "nix", osFamily: "nix" }, artifacts: [] },
              }),
            },
          },
        ],
      });
      expect(b).toEqual(publishedImage);
      const state = () =>
        run(
          Effect.gen(function* () {
            return {
              job: yield* (yield* WorkspaceBuildJobRepo).getJobById(jobId),
              instance: yield* (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(
                runId,
              ),
              attempt: yield* (yield* WorkspaceAttemptRepo).getAttemptById(runId),
            };
          }),
        );
      const before = await state();
      expect(before.job?.status).toBe("succeeded");
      expect(before.instance?.status).toBe("ready");
      expect(before.attempt?.status).toBe("succeeded");

      failingA.reject(new Error("the expired claimant's build failed"));
      expect(await a).toBeInstanceOf(Error);

      const after = await state();
      expect(launches).toEqual(["launch"]);
      expect(after.job?.status).toBe("succeeded");
      expect(after.job?.errorMessage ?? null).toBeNull();
      expect(after.job?.finishedAt?.getTime()).toBe(before.job?.finishedAt?.getTime());
      expect(after.instance?.status).toBe("ready");
      expect(after.instance?.resourceId).toBe("winning-container");
      expect(after.attempt?.status).toBe("succeeded");
    });
  },
);
