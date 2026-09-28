/**
 * The drain ledger against a REAL Postgres, as two workers see it: two database clients, two
 * owners, one `workspace_capture_drains` table. Gated on SEALANT_TEST_DATABASE_URL (a disposable
 * database with the migrations applied; it writes rows under fresh ids and leaves them) so it
 * skips where none is configured.
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/capture-drain-ledger.db.test.ts
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  SealantDB,
  user,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  workspaceAttempts,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import type { SealantTarget } from "../sealantd/runtime.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { databaseCaptureDrainLedger } from "./capture-drain-ledger.js";
import {
  attestedCompleteFor,
  drainCaptureBeforeStop,
  type CaptureDrainLedger,
} from "./capture-drain.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
const TARGET: SealantTarget = { kind: "unix-socket", socketPath: "/run/sealant/control.sock" };

const worker = (db: DB, owner: string, leaseMs = 60_000): CaptureDrainLedger =>
  databaseCaptureDrainLedger({ db, owner, leaseMs });

describe.skipIf(DATABASE_URL === undefined)("capture drain ledger (Postgres, two workers)", () => {
  let dbA: DB;
  let dbB: DB;
  const userId = `user_ledger_${randomUUID()}`;

  const newRun = async (): Promise<string> => {
    const runId = `run_ledger_${randomUUID()}`;
    await Effect.runPromise(
      dbA.insert(workspaceAttempts).values({ id: runId, ownerUserId: userId }),
    );
    return runId;
  };

  const drain = (
    runId: string,
    ledger: CaptureDrainLedger,
    script: Parameters<typeof fakeCaptureDaemon>[0],
  ) => {
    const daemon = fakeCaptureDaemon(script);
    return Effect.runPromise(
      drainCaptureBeforeStop({
        runId,
        target: TARGET,
        ledger,
        settings: {
          pollIntervalMs: 5,
          stallWindowMs: 60_000,
          unreachableWindowMs: 60_000,
          requestTimeoutMs: 1_000,
        },
        budgetMs: 2_000,
        label: "db test",
        runtimeState: Effect.succeed("running"),
      }).pipe(Effect.provide(daemon.layer)),
    ).then((outcome) => ({ outcome, daemon }));
  };

  beforeAll(async () => {
    dbA = await createSealantDB(DATABASE_URL ?? "");
    dbB = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      dbA.insert(user).values({ id: userId, name: "ledger", email: `${userId}@example.test` }),
    );
  });

  it("lets exactly one of many racing workers claim a run", async () => {
    const runId = await newRun();
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        Effect.runPromise(
          worker(index % 2 === 0 ? dbA : dbB, `worker-${String(index)}`).claim(runId),
        ),
      ),
    );
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
  });

  it("refuses worker B while worker A drains, then hands B the run with A's progress", async () => {
    const runId = await newRun();
    const a = worker(dbA, "worker-a");
    const b = worker(dbB, "worker-b");

    let uploaded = 0;
    const moving = Array.from({ length: 40 }, () => {
      uploaded += 10;
      return captureStatus({ pending: 2, uploadedBytes: uploaded });
    });
    const inFlight = drain(runId, a, [...moving, savedStatus()]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await drain(runId, b, [savedStatus()]);
    expect(second.outcome.kind).toBe("busy");
    expect(second.daemon.connect).not.toHaveBeenCalled();
    expect((await inFlight).outcome.kind).toBe("drained");

    // Released: worker B claims now and loads what worker A recorded.
    const claim = await Effect.runPromise(b.claim(runId));
    expect(claim?.entry.last).toMatchObject({ complete: true, pending: 0 });
    expect(claim?.entry.lastProgressAt).toBeTypeOf("number");
  });

  it("takes over a dead worker's lease once it expires, and fences the dead worker's writes", async () => {
    const runId = await newRun();
    const dead = worker(dbA, "worker-dead", 150);
    const live = worker(dbB, "worker-live", 150);

    const deadClaim = await Effect.runPromise(dead.claim(runId));
    expect(deadClaim).toBeDefined();
    expect(await Effect.runPromise(live.claim(runId))).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await Effect.runPromise(live.claim(runId))).toBeDefined();
    // The dead worker comes back: its progress write is refused, and it gives the drain up.
    expect(
      await Effect.runPromise(
        dead.save(
          runId,
          deadClaim?.token ?? "",
          {
            lastProgressAt: Date.now(),
            last: undefined,
            unreachableSince: undefined,
            keptLogged: false,
            silentLogged: false,
          },
          { state: "saved", detail: "stale" },
        ),
      ),
    ).toBe(false);
  });

  it("fences an exit behind a stop under way, so the planned stop settles stopped", async () => {
    const runId = await newRun();
    const layer = Layer.mergeAll(
      WorkspaceRuntimeInstanceRepoLive,
      WorkspaceCaptureDrainRepoLive,
    ).pipe(Layer.provide(Layer.succeed(SealantDB, dbA)));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const instances = yield* WorkspaceRuntimeInstanceRepo;
        yield* instances.upsertRuntimeInstance({
          runId,
          status: "ready",
          adapter: "docker",
          resourceId: "container-1",
          reference: "sealant-x",
        });
        yield* instances.markStopRequested({ runId, stopReason: "user" });
        const exited = yield* instances.markExited({
          runId,
          resourceId: "container-1",
          errorMessage: "exited",
        });
        const stopped = yield* instances.markStopped({ runId, stopReason: "user" });
        return { exited, stopped };
      }).pipe(Effect.provide(layer)),
    );
    expect(result.exited).toBeUndefined();
    expect(result.stopped).toMatchObject({ status: "stopped", stopReason: "user" });
  });

  it("keeps the first discard request as the audit, and reads it back through the ledger", async () => {
    const runId = await newRun();
    const layer = WorkspaceCaptureDrainRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, dbA)));
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        const drains = yield* WorkspaceCaptureDrainRepo;
        const a = yield* drains.requestDiscard({ runId, requestedBy: "user_owner" });
        const b = yield* drains.requestDiscard({ runId, requestedBy: "someone_else" });
        return [a, b] as const;
      }).pipe(Effect.provide(layer)),
    );
    expect(first.discardRequestedBy).toBe("user_owner");
    expect(second.discardRequestedBy).toBe("user_owner");
    expect(second.discardRequestedAt?.getTime()).toBe(first.discardRequestedAt?.getTime());
    const read = await Effect.runPromise(worker(dbB, "worker-b").read(runId));
    expect(read.readable && read.entry?.discardRequested?.by).toBe("user_owner");
  });

  it("lets one of two simultaneous claims of one worker process through, and neither releases the other", async () => {
    // Review 2 RISK: every stop path of a worker shares its lease owner, and the claim admitted a
    // live lease of the same owner, so two drains of one run in one process both ran.
    const runId = await newRun();
    const ledger = worker(dbA, "one-worker");
    const claims = await Promise.all([
      Effect.runPromise(ledger.claim(runId)),
      Effect.runPromise(ledger.claim(runId)),
    ]);
    const granted = claims.filter((claim) => claim !== undefined);
    expect(granted).toHaveLength(1);
    // A stale token (another drain's) cannot release the live claim.
    await Effect.runPromise(ledger.release(runId, "not-the-holder"));
    expect(await Effect.runPromise(ledger.claim(runId))).toBeUndefined();
    await Effect.runPromise(ledger.release(runId, granted[0]?.token ?? ""));
    expect(await Effect.runPromise(ledger.claim(runId))).toBeDefined();
  });

  it("records a retained executor, lists it due, counts attempts, and releases it when stopped", async () => {
    const runId = await newRun();
    const layer = WorkspaceCaptureDrainRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, dbA)));
    const ledger = worker(dbB, "worker-b");
    await Effect.runPromise(ledger.markRetained(runId, "executor exited · exit 75"));
    await Effect.runPromise(ledger.markRetained(runId, "executor exited · again"));
    const due = await Effect.runPromise(
      Effect.gen(function* () {
        const drains = yield* WorkspaceCaptureDrainRepo;
        return yield* drains.listRetainedDue({ limit: 1_000 });
      }).pipe(Effect.provide(layer)),
    );
    const row = due.find((candidate) => candidate.runId === runId);
    expect(row).toMatchObject({ retainedReason: "executor exited · again", state: "kept" });
    const later = new Date(Date.now() + 60_000);
    await Effect.runPromise(
      Effect.gen(function* () {
        const drains = yield* WorkspaceCaptureDrainRepo;
        yield* drains.recordRecoveryAttempt({
          runId,
          error: "docker start failed",
          nextRecoveryAt: later,
        });
      }).pipe(Effect.provide(layer)),
    );
    const read = await Effect.runPromise(ledger.read(runId));
    expect(read.readable && read.entry?.retained).toMatchObject({
      atMs: row?.retainedAt?.getTime(),
      recoveryAttempts: 1,
      lastRecoveryError: "docker start failed",
      nextRecoveryAtMs: later.getTime(),
    });
    const notDue = await Effect.runPromise(
      Effect.gen(function* () {
        const drains = yield* WorkspaceCaptureDrainRepo;
        return yield* drains.listRetainedDue({ limit: 1_000 });
      }).pipe(Effect.provide(layer)),
    );
    expect(notDue.some((candidate) => candidate.runId === runId)).toBe(false);
    await Effect.runPromise(ledger.observe(runId, { state: "stopped", detail: "removed" }));
    const released = await Effect.runPromise(ledger.read(runId));
    expect(released.readable && released.entry?.retained).toBeUndefined();
  });

  it("reads a completion attestation back through the ledger", async () => {
    const runId = await newRun();
    const layer = WorkspaceCaptureDrainRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, dbA)));
    await Effect.runPromise(
      Effect.gen(function* () {
        const drains = yield* WorkspaceCaptureDrainRepo;
        yield* drains.attestCompletion({
          runId,
          executorId: "container-1",
          epoch: 3,
          captureN: 41,
          attestedBy: "user_owner",
        });
      }).pipe(Effect.provide(layer)),
    );
    const read = await Effect.runPromise(worker(dbB, "worker-b").read(runId));
    expect(read.readable && read.entry?.completionAttested).toMatchObject({
      executorId: "container-1",
      epoch: 3,
      captureN: 41,
      by: "user_owner",
    });
  });

  it("keeps when each status was read and when a seal was made, and weighs them at consumption (review 4 #1)", async () => {
    const runId = await newRun();
    const sealedAt = new Date(Date.now() - 60 * 60_000);
    const layer = WorkspaceCaptureDrainRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, dbA)));
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* WorkspaceCaptureDrainRepo).attestCompletion({
          runId,
          executorId: "container-1",
          epoch: 1,
          captureN: 0,
          attestedBy: "user_owner",
          sealedAt,
        });
      }).pipe(Effect.provide(layer)),
    );
    // A drain reads the daemon AFTER the seal: its FINAL could not snapshot a changed path.
    await drain(runId, worker(dbA, "worker-a"), [
      captureStatus({ headN: 0, complete: false, incompleteReason: "snapshot-failed" }),
    ]);
    const read = await Effect.runPromise(worker(dbB, "worker-b").read(runId));
    const entry = read.readable ? read.entry : undefined;
    expect(entry?.completionAttested?.sealedAtMs).toBe(sealedAt.getTime());
    expect(entry?.lastAtMs).toBeGreaterThan(sealedAt.getTime());
    expect(attestedCompleteFor(entry, { runId, resourceId: "container-1", reference: null })).toBe(
      false,
    );
  });

  // Review 6 #3/#5 (decision 18): a deletion is authorized only on the evidence version it was
  // decided on, with no observation in flight; a lapsed fence is resolved only by an observation
  // opened after it lapsed and recorded.
  it("authorizes a deletion only on the current evidence, with nothing in flight", async () => {
    const runId = await newRun();
    const ledger = worker(dbA, "worker-a");
    await Effect.runPromise(ledger.recordStatus(runId, savedStatus(), Date.now()));
    const version = async () => {
      const read = await Effect.runPromise(ledger.read(runId));
      return read.readable ? (read.entry?.evidenceVersion ?? -1) : -1;
    };
    const decidedOn = await version();
    // Evidence changes after the decision was made: refused.
    await Effect.runPromise(ledger.recordStatus(runId, savedStatus(), Date.now()));
    expect(await Effect.runPromise(ledger.authorizeDeletion(runId, decidedOn))).toBe(false);
    expect(await Effect.runPromise(ledger.authorizeDeletion(runId, await version()))).toBe(true);

    // An observation that lapses at once, and is never resolved (its worker died).
    const lapsed = await Effect.runPromise(ledger.openObservation(runId, 0));
    expect(lapsed).toBeDefined();
    expect(await Effect.runPromise(ledger.authorizeDeletion(runId, await version()))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A later observation, opened after it lapsed and recorded, resolves it.
    const later = await Effect.runPromise(ledger.openObservation(runId, 60_000));
    expect(await Effect.runPromise(ledger.authorizeDeletion(runId, await version()))).toBe(false);
    expect(
      await Effect.runPromise(ledger.recordStatus(runId, savedStatus(), Date.now(), later)),
    ).toBe(true);
    const read = await Effect.runPromise(ledger.read(runId));
    expect(read.readable ? read.entry?.observationsInFlight : -1).toBe(0);
    expect(await Effect.runPromise(ledger.authorizeDeletion(runId, await version()))).toBe(true);
  });
});
