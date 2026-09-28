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
  TransportError,
  type CaptureFlushReport,
  type SealantRuntimeService,
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

/** A position in the executor's own history (sealantd's stamp). */
const origin = (observation: number) => ({
  epoch: 3,
  launch: "launch-1",
  bootId: "boot-1",
  bootGeneration: 1,
  observation,
  headN: 7,
});

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

    /**
     * What the daemon answers each round trip, in order (the last repeats): a status, `closed`
     * (the request went out and the connection closed before the answer: a lost answer), or
     * `unreachable` (no connection at all).
     */
    type Answer = CaptureFlushReport | "closed" | "unreachable";
    const setup = async (script: readonly Answer[] = [NOT_SAVED]) => {
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
      const calls: string[] = [];
      let step = 0;
      const next = () => script[Math.min(step++, script.length - 1)] ?? NOT_SAVED;
      const answer = (call: string) =>
        Effect.suspend(() => {
          calls.push(call);
          const scripted = next();
          return scripted === "closed" || scripted === "unreachable"
            ? Effect.fail(
                new TransportError({
                  operation: call === "flush" ? "captureFlush" : "captureStatus",
                  message: "connection closed",
                  cause: new Error("connection closed"),
                }),
              )
            : Effect.succeed(scripted);
        });
      const daemon: Pick<SealantSession, "captureFlush" | "captureStatus"> = {
        captureFlush: () => answer("flush"),
        captureStatus: () => answer("status"),
      };
      // `unreachable` fails at connect: the connection never opens.
      const connect = () =>
        Effect.suspend(() =>
          script[Math.min(step, script.length - 1)] === "unreachable"
            ? Effect.fail(
                new TransportError({
                  operation: "connect",
                  message: "connection refused",
                  cause: new Error("connection refused"),
                }),
              ).pipe(Effect.tap(() => Effect.sync(() => (step += 1))))
            : Effect.succeed(daemon as SealantSession),
        );
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
        Layer.succeed(SealantRuntime, { connect } as unknown as SealantRuntimeService),
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
      return { runId, workspaceId: workspace.id, run, drains, calls };
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

    // Review 7 #5 (decision 21): once a deleter holds the executor's removal, the public routes
    // ask its daemon nothing — no observation is admitted after the authorization.
    for (const route of ["flush", "status"] as const) {
      it(`asks nothing through the ${route} route while the executor's removal is held`, async () => {
        const { runId, workspaceId, run, drains, calls } = await setup();
        expect(await seedSaved(drains, runId, Date.now() - 60_000)).toBe(true);
        const ledger = databaseCaptureDrainLedger({ db, owner: "evidence-test", leaseMs: 60_000 });
        const record = await Effect.runPromise(ledger.read(runId));
        const authorization = await Effect.runPromise(
          ledger.authorizeDeletion(
            runId,
            record.readable ? (record.entry?.evidenceVersion ?? 0) : -1,
          ),
        );
        expect(authorization.kind).toBe("authorized");
        await expect(
          run(
            route === "flush"
              ? flushWorkspaceCapture({
                  workspaceId,
                  payload: { ownerUserId: owner, kind: "final" },
                })
              : getWorkspaceCaptureStatus({ workspaceId, query: { ownerUserId: owner } }),
          ),
        ).rejects.toBeDefined();
        expect(calls).toEqual([]);
        const row = await drains((repo) => repo.getByRunId(runId));
        expect(row?.lastStatus).toMatchObject({ complete: true });
        expect(row?.deletionState).toBe("deleting");
      });
    }

    it("never lets a delayed older complete roll back a newer not-saved observation", async () => {
      const { runId, workspaceId, run, drains } = await setup();
      // A complete asked for BEFORE the relayed not-saved answer, recorded after it: nothing
      // orders the two (no executor position), so it cannot make the record complete.
      await drains((repo) => repo.openObservation({ runId, token: "delayed", ttlMs: 60_000 }));
      await run(getWorkspaceCaptureStatus({ workspaceId, query: { ownerUserId: owner } }));
      expect(
        await drains((repo) =>
          repo.recordStatus({
            runId,
            status: storedCaptureStatus(SAVED),
            observedAt: new Date(Date.now() + 60_000),
            fence: "delayed",
          }),
        ),
      ).toBe(false);
      const row = await drains((repo) => repo.getByRunId(runId));
      expect(row?.lastStatus).toMatchObject({
        complete: false,
        incompleteReason: "snapshot-failed",
      });
      expect(row?.observationFences).toEqual({});

      // A complete asked for after it was recorded does replace it.
      await drains((repo) => repo.openObservation({ runId, token: "later", ttlMs: 60_000 }));
      expect(
        await drains((repo) =>
          repo.recordStatus({
            runId,
            status: storedCaptureStatus(SAVED),
            observedAt: new Date(0),
            fence: "later",
          }),
        ),
      ).toBe(true);
      expect((await drains((repo) => repo.getByRunId(runId)))?.lastStatus).toMatchObject({
        complete: true,
      });
    });

    // Review 6 #6: evidence is ordered by the executor's history (and, where that is silent, by
    // causality on the database's one clock), never by the reading worker's clock. A worker whose
    // clock ran five seconds ahead recorded a complete; the API then receives a failure from the
    // same executor — at the same epoch and head, or a later one. The failure stands.
    for (const { name, epoch, headN } of [
      { name: "same epoch and head", epoch: 3, headN: 7 },
      { name: "higher epoch and head", epoch: 4, headN: 8 },
    ]) {
      it(`records a failure received after a complete whose reader's clock ran ahead: ${name}`, async () => {
        const { runId, workspaceId, run, drains } = await setup([{ ...NOT_SAVED, epoch, headN }]);
        expect(await seedSaved(drains, runId, Date.now() + 5_000)).toBe(true);
        const answer = await run(
          getWorkspaceCaptureStatus({ workspaceId, query: { ownerUserId: owner } }),
        );
        expect(answer.complete).toBe(false);
        expect((await drains((repo) => repo.getByRunId(runId)))?.lastStatus).toMatchObject({
          complete: false,
          epoch,
          headN,
        });
        expect(await deletionAfterExit(runId)).toMatchObject({ delete: false });
      });
    }

    it("orders two answers by the executor's own positions, whichever was recorded last", async () => {
      const { runId, drains } = await setup();
      await drains((repo) => repo.openObservation({ runId, token: "a", ttlMs: 60_000 }));
      await drains((repo) => repo.openObservation({ runId, token: "b", ttlMs: 60_000 }));
      // The later failure (observation 9) is recorded first; the earlier complete (8) after it.
      await drains((repo) =>
        repo.recordStatus({
          runId,
          status: storedCaptureStatus({ ...NOT_SAVED, origin: origin(9) }),
          observedAt: new Date(0),
          fence: "b",
        }),
      );
      expect(
        await drains((repo) =>
          repo.recordStatus({
            runId,
            status: storedCaptureStatus({ ...SAVED, origin: origin(8) }),
            observedAt: new Date(Date.now() + 3_600_000),
            fence: "a",
          }),
        ),
      ).toBe(false);
      expect((await drains((repo) => repo.getByRunId(runId)))?.lastStatus).toMatchObject({
        complete: false,
        origin: origin(9),
      });
    });

    // Review 6 #5: a received answer whose recording fails fences the executor: nothing Core
    // holds of it counts as current, so the older complete no longer lets its disk go — not now,
    // and not after the fault is gone, until a later observation is recorded.
    it("keeps the executor unknown when recording a received answer fails", async () => {
      const { runId, workspaceId, run, drains } = await setup();
      expect(await seedSaved(drains, runId, Date.now() - 5_000)).toBe(true);
      expect(await deletionAfterExit(runId)).toMatchObject({ delete: true });
      const name = `refuse_incomplete_${randomUUID().replaceAll("-", "")}`;
      await Effect.runPromise(
        db.execute(
          `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${runId}' AND NEW.last_status->>'complete' = 'false' THEN RAISE EXCEPTION 'injected observation write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON workspace_capture_drains FOR EACH ROW EXECUTE FUNCTION ${name}();`,
        ),
      );
      let answer: CaptureFlushReport;
      try {
        answer = await run(
          getWorkspaceCaptureStatus({ workspaceId, query: { ownerUserId: owner } }),
        );
      } finally {
        await Effect.runPromise(
          db.execute(`DROP TRIGGER ${name} ON workspace_capture_drains; DROP FUNCTION ${name}();`),
        );
      }
      // The caller received the answer; the record could not take it.
      expect(answer).toMatchObject({ complete: false, incompleteReason: "snapshot-failed" });
      const row = await drains((repo) => repo.getByRunId(runId));
      expect(row?.lastStatus).toMatchObject({ complete: true });
      expect(Object.keys(row?.observationFences ?? {})).toHaveLength(1);
      // The fault is gone; the old complete still does not let the ended executor go.
      expect(await deletionAfterExit(runId)).toMatchObject({ delete: false });
      const ledger = databaseCaptureDrainLedger({ db, owner: "evidence-test", leaseMs: 60_000 });
      const record = await Effect.runPromise(ledger.read(runId));
      expect(
        await Effect.runPromise(
          ledger.authorizeDeletion(
            runId,
            record.readable ? (record.entry?.evidenceVersion ?? 0) : -1,
          ),
        ),
      ).toMatchObject({ kind: "changed" });
    });

    // Review 6 #4: a FINAL relay reads its lost answer again and receives "not saved"; the FINAL
    // asked again loses its answer too, and then the daemon is gone. The received "not saved" is
    // recorded before the FINAL is asked again, and it is what the caller gets back.
    it("records and returns a re-read failure when the FINAL asked again loses its answer", async () => {
      const { runId, workspaceId, run, drains, calls } = await setup([
        "closed",
        NOT_SAVED,
        "closed",
        "unreachable",
      ]);
      expect(await seedSaved(drains, runId, Date.now() - 5_000)).toBe(true);
      const answer = await run(
        flushWorkspaceCapture({ workspaceId, payload: { ownerUserId: owner, kind: "final" } }),
      );
      expect(calls.slice(0, 3)).toEqual(["flush", "status", "flush"]);
      expect(answer).toMatchObject({ complete: false, incompleteReason: "snapshot-failed" });
      const row = await drains((repo) => repo.getByRunId(runId));
      expect(row?.lastStatus).toMatchObject({
        complete: false,
        incompleteReason: "snapshot-failed",
      });
      // Every observation resolved: the lost ones received nothing.
      expect(row?.observationFences).toEqual({});
      expect(await deletionAfterExit(runId)).toMatchObject({ delete: false });
    });
  },
);
