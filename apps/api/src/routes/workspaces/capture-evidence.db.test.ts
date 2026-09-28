/**
 * Review 5 #3 against a REAL Postgres: every capture status Core relays from an executor through
 * the public flush and status routes is evidence about that executor's disk. Core had observed a
 * complete final flush (and the control plane holds a seal of it); new work arrives; a FINAL or
 * a status read through the API says `snapshot-failed`. That answer is recorded against the run's
 * executor before it is returned, so the older seal is no longer accepted at stop and the older
 * complete no longer lets the ended executor's disk go. Ordered by when Core read it: a delayed
 * older complete (a drain's slow write, a late relayed answer) never rolls the record back.
 * Gated on SEALANT_TEST_DATABASE_URL (a disposable, migrated database).
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  SealantDB,
  user,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  workspaceAttempts,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type DB,
  type Workspace,
  type WorkspaceCaptureDrainRepoService,
  type WorkspaceAttemptSnapshot,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import {
  databaseCaptureDrainLedger,
  decideExecutorDeletion,
  recordedDeletionEvidence,
  SealantRuntime,
  storedCaptureStatus,
  type CaptureFlushReport,
  type SealantSession,
} from "@sealant/workspaces";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { WorkspaceLifecyclePublisherService } from "../../services/control-plane-capabilities.js";
import {
  flushWorkspaceCapture,
  getWorkspaceCaptureStatus,
  stopWorkspace,
} from "./workspaces.module.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const SAVED: CaptureFlushReport = {
  epoch: 3,
  worktreeId: "wt_1",
  headN: 7,
  pending: 0,
  stagedBytes: 0,
  uploadedObjects: 2,
  uploadedBytes: 4096,
  registered: 2,
  fenced: false,
  paused: false,
  refused: [],
  complete: true,
};
const NOT_SAVED: CaptureFlushReport = {
  ...SAVED,
  complete: false,
  incompleteReason: "snapshot-failed",
  unreadable: 1,
  unreadablePaths: ["unique-work.txt"],
};

describe.skipIf(DATABASE_URL === undefined)(
  "capture observations relayed by the API are evidence (Postgres, review 5 #3)",
  () => {
    let db: DB;
    const owner = `user_capture_evidence_${randomUUID()}`;

    beforeAll(async () => {
      db = await createSealantDB(DATABASE_URL ?? "");
      await Effect.runPromise(
        db.insert(user).values({ id: owner, name: "evidence", email: `${owner}@example.test` }),
      );
    });

    const setup = async () => {
      const runId = `run_capture_evidence_${randomUUID()}`;
      await Effect.runPromise(
        db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner }),
      );
      const workspace = {
        id: `ws_${runId}`,
        ownerUserId: owner,
        latestRunId: runId,
        status: "ready",
      };
      const spec = {
        sources: {
          workspace: {
            kind: "capture",
            endpoint: "https://mend.example.test/session/s1",
            worktreeId: "wt_1",
          },
        },
        harness: { id: "claude-code" },
      };
      const instance = {
        runId,
        status: "ready",
        adapter: "docker",
        endpoint: "unix:///run/sealant/evidence.sock",
        resourceId: "container_1",
        reference: "container_1",
      };
      const daemon: Pick<SealantSession, "captureFlush" | "captureStatus"> = {
        captureFlush: () => Effect.succeed(NOT_SAVED),
        captureStatus: () => Effect.succeed(NOT_SAVED),
      };
      const layer = Layer.mergeAll(
        Layer.mock(WorkspaceRepo, {
          getWorkspaceById: () => Effect.succeed(workspace as unknown as Workspace),
          setWorkspaceStatus: () => Effect.succeed(workspace as unknown as Workspace),
        }),
        Layer.mock(WorkspaceAttemptRepo, {
          getAttemptSnapshotByRunId: () =>
            Effect.succeed({ resolvedSpecPayload: spec } as unknown as WorkspaceAttemptSnapshot),
          getAttemptById: () => Effect.succeed(undefined),
        }),
        Layer.mock(WorkspaceBuildJobRepo, { getLatestJobByRunId: () => Effect.succeed(undefined) }),
        Layer.mock(WorkspaceRuntimeInstanceRepo, {
          getRuntimeInstanceByRunId: () =>
            Effect.succeed(instance as unknown as WorkspaceRuntimeInstance),
          markStopRequested: () => Effect.void,
        }),
        WorkspaceCaptureDrainRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db))),
        Layer.succeed(SealantRuntime, {
          connect: () => Effect.succeed(daemon as SealantSession),
        }),
        Layer.succeed(WorkspaceLifecyclePublisherService, {
          publishStopRequested: async () => undefined,
        }),
      );
      const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
        Effect.runPromise(effect.pipe(Effect.provide(layer)));
      const drains = <A, E>(use: (repo: WorkspaceCaptureDrainRepoService) => Effect.Effect<A, E>) =>
        run(
          Effect.gen(function* () {
            return yield* use(yield* WorkspaceCaptureDrainRepo);
          }),
        );
      return { runId, workspaceId: workspace.id, run, drains };
    };

    /** Core earlier read the final flush complete from this executor (a drain, at `atMs`). */
    const seedSaved = (
      drains: Awaited<ReturnType<typeof setup>>["drains"],
      runId: string,
      atMs: number,
    ) =>
      drains((repo) =>
        repo.recordStatus({
          runId,
          status: storedCaptureStatus(SAVED),
          observedAt: new Date(atMs),
        }),
      );

    const deletionAfterExit = async (runId: string) => {
      const ledger = databaseCaptureDrainLedger({ db, owner: "evidence-test", leaseMs: 60_000 });
      const record = await Effect.runPromise(ledger.read(runId));
      return decideExecutorDeletion({
        captureSourced: true,
        runtime: "exited",
        ...recordedDeletionEvidence(record, {
          runId,
          resourceId: "container_1",
          reference: "container_1",
        }),
      });
    };

    for (const route of ["flush", "status"] as const) {
      it(`records a ${route} answer that says not saved: the older seal and complete no longer count`, async () => {
        const { runId, workspaceId, run, drains } = await setup();
        const sealedAtMs = Date.now() - 5 * 60_000;
        expect(await seedSaved(drains, runId, sealedAtMs - 1_000)).toBe(true);
        // Before the relayed answer the old complete would let the ended executor go.
        expect(await deletionAfterExit(runId)).toMatchObject({ delete: true });

        const answer = await run(
          route === "flush"
            ? flushWorkspaceCapture({ workspaceId, payload: { ownerUserId: owner, kind: "final" } })
            : getWorkspaceCaptureStatus({ workspaceId, query: { ownerUserId: owner } }),
        );
        expect(answer).toMatchObject({ complete: false, incompleteReason: "snapshot-failed" });

        const row = await drains((repo) => repo.getByRunId(runId));
        expect(row?.lastStatus).toMatchObject({
          complete: false,
          incompleteReason: "snapshot-failed",
        });

        // The control plane then attests the older seal (its FINAL answer was lost): refused.
        const stop = await run(
          stopWorkspace({
            workspaceId,
            payload: {
              ownerUserId: owner,
              completion: {
                executorId: "container_1",
                epoch: 3,
                captureN: 7,
                sealedAt: new Date(sealedAtMs).toISOString(),
              },
            },
          }),
        );
        expect(stop.completion).toMatchObject({ outcome: "ignored" });
        // And the ended executor's disk is kept: nothing says its newest work is saved.
        expect(await deletionAfterExit(runId)).toMatchObject({ delete: false });
      });
    }

    it("never lets a delayed older complete roll back a newer not-saved observation", async () => {
      const { runId, workspaceId, run, drains } = await setup();
      await run(getWorkspaceCaptureStatus({ workspaceId, query: { ownerUserId: owner } }));
      const observedAt = (await drains((repo) => repo.getByRunId(runId)))?.lastStatusAt;
      expect(observedAt).toBeInstanceOf(Date);
      const at = observedAt?.getTime() ?? 0;

      // A relayed complete read earlier, written late: refused.
      expect(await seedSaved(drains, runId, at - 1_000)).toBe(false);

      // A drain's slower write of an older complete read (its lease held): the record stands.
      const ledger = databaseCaptureDrainLedger({ db, owner: "evidence-drain", leaseMs: 60_000 });
      const claimed = await Effect.runPromise(ledger.claim(runId));
      expect(claimed).toBeDefined();
      await Effect.runPromise(
        ledger.save(
          runId,
          claimed?.token ?? "",
          {
            ...(claimed?.entry ?? {
              lastProgressAt: undefined,
              last: undefined,
              unreachableSince: undefined,
              keptLogged: false,
              silentLogged: false,
            }),
            last: SAVED,
            lastAtMs: at - 500,
          },
          undefined,
        ),
      );
      const row = await drains((repo) => repo.getByRunId(runId));
      expect(row?.lastStatus).toMatchObject({
        complete: false,
        incompleteReason: "snapshot-failed",
      });

      // A newer complete read does replace it.
      expect(await seedSaved(drains, runId, at + 1_000)).toBe(true);
      expect((await drains((repo) => repo.getByRunId(runId)))?.lastStatus).toMatchObject({
        complete: true,
      });
    });
  },
);
