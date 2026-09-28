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

import {
  createSealantDB,
  SealantDB,
  user,
  WorkspaceBuildJobRepo,
  WorkspaceBuildJobRepoLive,
  workspaceAttempts,
} from "@sealant/db";
import { newWorkspaceSchema } from "@sealant/validators";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

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
  },
);
