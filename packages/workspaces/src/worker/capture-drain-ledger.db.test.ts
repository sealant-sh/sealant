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
  type WorkspaceCaptureDrainRepoService,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import type { SealantTarget } from "../sealantd/runtime.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { databaseCaptureDrainLedger } from "./capture-drain-ledger.js";
import {
  attestedCompleteFor,
  drainCaptureBeforeStop,
  observedComplete,
  removeUnderDeletion,
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
    const authorize = async () =>
      (await Effect.runPromise(ledger.authorizeDeletion(runId, await version()))).kind;
    // Evidence changes after the decision was made: refused.
    await Effect.runPromise(ledger.recordStatus(runId, savedStatus(), Date.now()));
    expect((await Effect.runPromise(ledger.authorizeDeletion(runId, decidedOn))).kind).toBe(
      "changed",
    );
    const held = await Effect.runPromise(ledger.authorizeDeletion(runId, await version()));
    expect(held.kind).toBe("authorized");
    // Given up (its runtime call was not made): observations are admitted again.
    if (held.kind === "authorized") {
      await Effect.runPromise(ledger.releaseDeletion(runId, held.ticket));
    }

    // An observation that lapses at once, and is never resolved (its worker died).
    const lapsed = await Effect.runPromise(ledger.openObservation(runId, 0));
    expect(lapsed).toBeDefined();
    expect(await authorize()).toBe("changed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A later observation, opened after it lapsed and recorded, resolves it.
    const later = await Effect.runPromise(ledger.openObservation(runId, 60_000));
    expect(await authorize()).toBe("changed");
    expect(
      await Effect.runPromise(ledger.recordStatus(runId, savedStatus(), Date.now(), later)),
    ).toBe(true);
    const read = await Effect.runPromise(ledger.read(runId));
    expect(read.readable ? read.entry?.observationsInFlight : -1).toBe(0);
    expect(await authorize()).toBe("authorized");
  });

  // Review 7 #5 (decision 21): authorizing a removal returned a boolean and committed, and an
  // observation opened after it was admitted and became current while the deleter went on to the
  // runtime call. The authorization now takes the removal as an owned durable transition.
  it("admits no observation once a removal is authorized; a status recorded anyway voids it", async () => {
    const runId = await newRun();
    const a = worker(dbA, "worker-a");
    const b = worker(dbB, "worker-b");
    await Effect.runPromise(a.recordStatus(runId, savedStatus(), Date.now() - 1_000));
    const read = await Effect.runPromise(a.read(runId));
    const version = read.readable ? (read.entry?.evidenceVersion ?? -1) : -1;
    const authorization = await Effect.runPromise(a.authorizeDeletion(runId, version));
    expect(authorization.kind).toBe("authorized");
    if (authorization.kind !== "authorized") {
      return;
    }
    // Another worker's observation, asked after the authorization: refused, nothing is asked.
    expect(await Effect.runPromise(b.openObservation(runId, 1_000))).toBeUndefined();
    // Another deleter: the removal is held.
    expect((await Effect.runPromise(b.authorizeDeletion(runId, version))).kind).toBe("held");
    // Recovery does not start it under the removal.
    expect(await Effect.runPromise(b.admitRecovery(runId))).toBe("deleting");
    // Held and untouched: the deleter's re-check passes.
    expect(await Effect.runPromise(a.confirmDeletion(runId, authorization.ticket))).toBe(true);
    // A status received anyway (asked without a fence): recorded, and the removal is voided.
    await Effect.runPromise(
      b.recordStatus(
        runId,
        captureStatus({ complete: false, incompleteReason: "snapshot-failed", headN: 8 }),
        Date.now(),
      ),
    );
    expect(await Effect.runPromise(a.confirmDeletion(runId, authorization.ticket))).toBe(false);
    const after = await Effect.runPromise(a.read(runId));
    expect(after.readable && after.entry?.last?.complete).toBe(false);
    // Voided: observations are admitted again.
    expect(await Effect.runPromise(b.openObservation(runId, 1_000))).toBeDefined();
  });

  it("admits nothing once the removal completed: no observation, no recovery, no second removal", async () => {
    const runId = await newRun();
    const a = worker(dbA, "worker-a");
    const b = worker(dbB, "worker-b");
    await Effect.runPromise(a.recordStatus(runId, savedStatus(), Date.now() - 1_000));
    const read = await Effect.runPromise(a.read(runId));
    const version = read.readable ? (read.entry?.evidenceVersion ?? -1) : -1;
    const authorization = await Effect.runPromise(a.authorizeDeletion(runId, version));
    if (authorization.kind !== "authorized") {
      throw new Error(`expected an authorized removal, got ${authorization.kind}`);
    }
    expect(await Effect.runPromise(a.confirmDeletion(runId, authorization.ticket))).toBe(true);
    await Effect.runPromise(a.completeDeletion(runId, authorization.ticket));
    expect(await Effect.runPromise(b.openObservation(runId, 1_000))).toBeUndefined();
    expect(await Effect.runPromise(b.admitRecovery(runId))).toBe("deleted");
    const again = await Effect.runPromise(b.read(runId));
    const current = again.readable ? (again.entry?.evidenceVersion ?? -1) : -1;
    expect((await Effect.runPromise(b.authorizeDeletion(runId, current))).kind).toBe("deleted");
  });

  it("voids a removal whose hold lapsed (its deleter died) by what it admits", async () => {
    const runId = await newRun();
    const repo = <A, E>(use: (drains: WorkspaceCaptureDrainRepoService) => Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* use(yield* WorkspaceCaptureDrainRepo);
        }).pipe(
          Effect.provide(
            WorkspaceCaptureDrainRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, dbA))),
          ),
        ),
      );
    const deleter = randomUUID();
    const lapsingRemoval = async () => {
      const row = await repo((drains) => drains.getByRunId(runId));
      return repo((drains) =>
        drains.authorizeDeletion({
          runId,
          evidenceVersion: row?.evidenceVersion ?? 0,
          token: deleter,
          leaseMs: 1,
        }),
      );
    };
    await repo((drains) => drains.recordObservation({ runId, state: "kept", detail: null }));
    expect(await lapsingRemoval()).toBe("authorized");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Lapsed: an observation is admitted and voids it; its deleter's re-check fails.
    expect(
      await repo((drains) => drains.openObservation({ runId, token: randomUUID(), ttlMs: 60_000 })),
    ).toHaveProperty("openedAt");
    expect(
      await repo((drains) => drains.confirmDeletion({ runId, token: deleter, leaseMs: 1 })),
    ).toBe(false);
    // Recovery admission voids a lapsed removal too.
    const fenceless = await repo((drains) => drains.getByRunId(runId));
    await repo((drains) =>
      drains.closeObservation({
        runId,
        token: Object.keys(fenceless?.observationFences ?? {})[0] ?? "",
      }),
    );
    expect(await lapsingRemoval()).toBe("authorized");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await repo((drains) => drains.admitRecovery({ runId }))).toBe("admitted");
    expect((await repo((drains) => drains.getByRunId(runId)))?.deletionState).toBeNull();
  });

  // Review 8 #7: the removal's hold lapsed while the runtime call it authorized was still out
  // (its renewals failed, or its worker is cut off), and the database then admitted observations
  // and recovery as though nothing were being removed; the old call still removed the executor.
  // A removal the runtime was asked to make stays exclusionary until its outcome is known.
  it("keeps an issued removal exclusionary past its hold while the runtime call runs (review 8 #7)", async () => {
    const runId = await newRun();
    // A 200 ms hold: renewals (every 30 s) never land before it lapses.
    const a = databaseCaptureDrainLedger({
      db: dbA,
      owner: "worker-a",
      leaseMs: 60_000,
      deletionHoldMs: 200,
    });
    const b = worker(dbB, "worker-b");
    await Effect.runPromise(a.recordStatus(runId, savedStatus({ headN: 7 }), Date.now() - 1_000));
    const version = async () => {
      const read = await Effect.runPromise(b.read(runId));
      return read.readable ? (read.entry?.evidenceVersion ?? -1) : -1;
    };
    const authorization = await Effect.runPromise(a.authorizeDeletion(runId, await version()));
    if (authorization.kind !== "authorized") {
      throw new Error(`expected an authorized removal, got ${authorization.kind}`);
    }
    let issued = false;
    const issuedYet = () => issued;
    let finish!: () => void;
    const provider = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const deleting = Effect.runPromise(
      removeUnderDeletion({
        ledger: a,
        runId,
        ticket: authorization.ticket,
        remove: Effect.promise(async () => {
          issued = true;
          await provider;
        }),
      }),
    );
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !issuedYet()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(issued).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Past the hold, the runtime call still out: nothing is admitted.
    expect(await Effect.runPromise(b.openObservation(runId, 1_000))).toBeUndefined();
    expect(await Effect.runPromise(b.admitRecovery(runId))).toBe("deleting");
    expect((await Effect.runPromise(b.authorizeDeletion(runId, await version()))).kind).not.toBe(
      "authorized",
    );
    finish();
    expect(await deleting).toMatchObject({ removed: true });
    const after = await Effect.runPromise(b.read(runId));
    expect(after.readable && after.entry?.last?.headN).toBe(7);
    expect(await Effect.runPromise(b.admitRecovery(runId))).toBe("deleted");
  });

  it("settles an issued removal whose issuer died from what the runtime says (review 8 #7)", async () => {
    const repo = <A, E>(use: (drains: WorkspaceCaptureDrainRepoService) => Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* use(yield* WorkspaceCaptureDrainRepo);
        }).pipe(
          Effect.provide(
            WorkspaceCaptureDrainRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, dbA))),
          ),
        ),
      );
    const a = worker(dbA, "worker-a");
    // A removal authorized on saved/head 7 and issued, whose issuer's hold lapses at once.
    const issuedAndLapsed = async () => {
      const runId = await newRun();
      await Effect.runPromise(a.recordStatus(runId, savedStatus({ headN: 7 }), Date.now()));
      const row = await repo((drains) => drains.getByRunId(runId));
      const token = randomUUID();
      expect(
        await repo((drains) =>
          drains.authorizeDeletion({
            runId,
            evidenceVersion: row?.evidenceVersion ?? 0,
            token,
            leaseMs: 60_000,
          }),
        ),
      ).toBe("authorized");
      expect(await repo((drains) => drains.issueDeletion({ runId, token, leaseMs: 1 }))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { runId, token };
    };
    const state = async (runId: string) =>
      (await repo((drains) => drains.getByRunId(runId)))?.deletionState;
    const reconcile = (runId: string, runtime: "gone" | "present", fenceMs?: number) =>
      repo((drains) =>
        drains.reconcileIssuedDeletion({
          runId,
          runtime,
          token: randomUUID(),
          leaseMs: 60_000,
          ...(fenceMs === undefined ? {} : { fenceMs }),
        }),
      );

    // Lapsed and issued: still exclusionary.
    const gone = await issuedAndLapsed();
    expect(
      await repo((drains) =>
        drains.openObservation({ runId: gone.runId, token: randomUUID(), ttlMs: 1_000 }),
      ),
    ).toEqual({ refused: "deleting" });
    expect(await repo((drains) => drains.admitRecovery({ runId: gone.runId }))).toBe("deleting");
    const goneRow = await repo((drains) => drains.getByRunId(gone.runId));
    expect(
      await repo((drains) =>
        drains.authorizeDeletion({
          runId: gone.runId,
          evidenceVersion: goneRow?.evidenceVersion ?? 0,
          token: randomUUID(),
          leaseMs: 60_000,
        }),
      ),
    ).toBe("unresolved");
    // The runtime no longer has it: deleted.
    expect(await reconcile(gone.runId, "gone")).toBe("deleted");
    expect(await state(gone.runId)).toBe("deleted");

    // Still there, evidence unchanged: taken over, still issued, the old issuer's hold gone.
    const present = await issuedAndLapsed();
    expect(await reconcile(present.runId, "present")).toBe("reissue");
    expect(await state(present.runId)).toBe("deleting-issued");
    expect(
      await repo((drains) =>
        drains.confirmDeletion({ runId: present.runId, token: present.token, leaseMs: 60_000 }),
      ),
    ).toBe(false);
    await repo((drains) => drains.releaseDeletion({ runId: present.runId, token: present.token }));
    expect(await state(present.runId)).toBe("deleting-issued");
    // Held again by its new holder: nothing to settle now.
    expect(await reconcile(present.runId, "present")).toBe("held");

    // Still there, evidence changed since (a status recorded without a fence): kept as evidence,
    // never voiding the issued removal; settled by giving it up, and observations resume.
    const changed = await issuedAndLapsed();
    await Effect.runPromise(
      a.recordStatus(
        changed.runId,
        captureStatus({ complete: false, incompleteReason: "snapshot-failed", headN: 8 }),
        Date.now(),
      ),
    );
    expect(await state(changed.runId)).toBe("deleting-issued");
    // Review 9 #5: present proves only that the request has not finished. It stays issued and
    // exclusionary while the request may still act — with no bound from the runtime, or before
    // the runtime's bound has passed since it was issued.
    expect(await reconcile(changed.runId, "present")).toBe("outstanding");
    expect(await reconcile(changed.runId, "present", 60 * 60_000)).toBe("outstanding");
    expect(await state(changed.runId)).toBe("deleting-issued");
    expect(
      await repo((drains) =>
        drains.openObservation({ runId: changed.runId, token: randomUUID(), ttlMs: 1_000 }),
      ),
    ).toEqual({ refused: "deleting" });
    expect(await repo((drains) => drains.admitRecovery({ runId: changed.runId }))).toBe("deleting");
    // Past the runtime's bound on the request since it was issued: it can no longer act; given
    // up, and observations resume.
    expect(await reconcile(changed.runId, "present", 10)).toBe("released");
    expect(await state(changed.runId)).toBeNull();
    expect(
      await repo((drains) =>
        drains.openObservation({ runId: changed.runId, token: randomUUID(), ttlMs: 1_000 }),
      ),
    ).toHaveProperty("openedAt");
  });

  it("keeps a removal issued when its runtime call failed with an outcome nobody knows (review 9 #5)", async () => {
    const runId = await newRun();
    const ledger = worker(dbA, "review9-deletion");
    await Effect.runPromise(ledger.recordStatus(runId, savedStatus({ headN: 7 }), Date.now()));
    const read = await Effect.runPromise(ledger.read(runId));
    const authorized = await Effect.runPromise(
      ledger.authorizeDeletion(runId, read.readable ? (read.entry?.evidenceVersion ?? 0) : -1),
    );
    if (authorized.kind !== "authorized") {
      throw new Error(authorized.kind);
    }
    const exit = await Effect.runPromise(
      removeUnderDeletion({
        ledger,
        runId,
        ticket: authorized.ticket,
        remove: Effect.tryPromise(async () => {
          throw new Error("socket closed after TerminateMicrovm was sent");
        }),
      }).pipe(Effect.exit),
    );
    expect(exit._tag).toBe("Failure");
    const after = await Effect.runPromise(ledger.read(runId));
    expect(after.readable && after.entry?.removalIssued).toBe(true);
    expect(await Effect.runPromise(ledger.admitRecovery(runId))).toBe("deleting");
    expect(await Effect.runPromise(ledger.openObservation(runId, 1_000))).toBeUndefined();
    // Its hold ended with the call: settled from the runtime at once.
    expect((await Effect.runPromise(ledger.reconcileIssuedDeletion(runId, "gone"))).kind).toBe(
      "deleted",
    );
  });

  it("keeps an unsaved answer no later one covers, so a delayed older answer cannot revive a seal (review 9 #4)", async () => {
    const runId = await newRun();
    const repo = <A, E>(use: (drains: WorkspaceCaptureDrainRepoService) => Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* use(yield* WorkspaceCaptureDrainRepo);
        }).pipe(
          Effect.provide(
            WorkspaceCaptureDrainRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, dbA))),
          ),
        ),
      );
    const ledger = worker(dbA, "review9-evidence");
    const originA = {
      epoch: 1,
      launch: "launch9",
      bootId: "boot-A",
      bootGeneration: 1,
      observation: 100,
      headN: 7,
    };
    await repo((drains) =>
      drains.attestCompletion({
        runId,
        executorId: runId,
        epoch: 1,
        captureN: 7,
        origin: originA,
        attestedBy: "control plane",
      }),
    );
    // Four requests sent before any answer was recorded: the order they are received in orders
    // nothing.
    const oldA = await Effect.runPromise(ledger.openObservation(runId, 60_000));
    const savedA = await Effect.runPromise(ledger.openObservation(runId, 60_000));
    const failedB = await Effect.runPromise(ledger.openObservation(runId, 60_000));
    const lateSavedA = await Effect.runPromise(ledger.openObservation(runId, 60_000));
    if (
      oldA === undefined ||
      savedA === undefined ||
      failedB === undefined ||
      lateSavedA === undefined
    ) {
      throw new Error("no observation could be opened");
    }
    await Effect.runPromise(
      ledger.recordStatus(
        runId,
        savedStatus({ epoch: 1, headN: 7, origin: originA }),
        Date.now(),
        savedA,
      ),
    );
    // A recovery boot whose generation could not be persisted (0): incomparable with boot A.
    await Effect.runPromise(
      ledger.recordStatus(
        runId,
        captureStatus({
          epoch: 1,
          headN: 7,
          complete: false,
          incompleteReason: "snapshot-failed",
          origin: { ...originA, bootId: "boot-B", bootGeneration: 0, observation: 1 },
        }),
        Date.now(),
        failedB,
      ),
    );
    const blocked = await Effect.runPromise(ledger.read(runId));
    if (!blocked.readable) {
      throw new Error("unreadable");
    }
    expect(attestedCompleteFor(blocked.entry, { runId, resourceId: null, reference: null })).toBe(
      false,
    );
    // Boot A's older, pre-seal answer arrives last. It is incomparable with boot B's failure and
    // must not erase it.
    await Effect.runPromise(
      ledger.recordStatus(
        runId,
        captureStatus({
          epoch: 1,
          headN: 7,
          complete: false,
          incompleteReason: "sealing",
          origin: { ...originA, observation: 90 },
        }),
        Date.now(),
        oldA,
      ),
    );
    const after = await Effect.runPromise(ledger.read(runId));
    if (!after.readable) {
      throw new Error("unreadable");
    }
    expect(attestedCompleteFor(after.entry, { runId, resourceId: null, reference: null })).toBe(
      false,
    );
    expect(observedComplete(after.entry)).toBe(false);
    expect(after.entry?.unsaved?.map((status) => status.origin?.bootId).sort()).toEqual([
      "boot-A",
      "boot-B",
    ]);

    // Boot A's next answer, complete, asked for before boot B's failure was recorded: it covers
    // boot A's older answer, not boot B's. Still not saved, though the latest answer is complete.
    await Effect.runPromise(
      ledger.recordStatus(
        runId,
        savedStatus({ epoch: 1, headN: 7, origin: { ...originA, observation: 101 } }),
        Date.now(),
        lateSavedA,
      ),
    );
    const partly = await Effect.runPromise(ledger.read(runId));
    if (!partly.readable) {
      throw new Error("unreadable");
    }
    expect(partly.entry?.observationsInFlight).toBe(0);
    expect(partly.entry?.last?.complete).toBe(true);
    expect(partly.entry?.unsaved?.map((status) => status.origin?.bootId)).toEqual(["boot-B"]);
    expect(observedComplete(partly.entry)).toBe(false);
    expect(attestedCompleteFor(partly.entry, { runId, resourceId: null, reference: null })).toBe(
      false,
    );
    // Only an answer asked for after both were recorded covers them all.
    const fresh = await Effect.runPromise(ledger.openObservation(runId, 60_000));
    if (fresh === undefined) {
      throw new Error("no observation could be opened");
    }
    await Effect.runPromise(
      ledger.recordStatus(
        runId,
        savedStatus({
          epoch: 1,
          headN: 7,
          origin: { ...originA, bootId: "boot-C", bootGeneration: 0, observation: 1 },
        }),
        Date.now(),
        fresh,
      ),
    );
    const saved = await Effect.runPromise(ledger.read(runId));
    if (!saved.readable) {
      throw new Error("unreadable");
    }
    expect(saved.entry?.unsaved ?? []).toEqual([]);
    expect(observedComplete(saved.entry)).toBe(true);
  });
});
