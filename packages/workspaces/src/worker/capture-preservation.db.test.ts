import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  makeSealantDBLayer,
  SealantDB,
  user,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  workspaceAttempts,
  type DB,
  type WorkspaceCaptureDrainRepoService,
} from "@sealant/db";
import { runMigrations } from "@sealant/db/migrate";
import {
  expireParkingClaim,
  oldParkingWriter,
  parkingRows,
  releaseParkingPublication,
  rewriteParkingSource,
  seedIssuedParkingClose,
  seedMissingParkingDetail,
  seedParkingAllowance,
  seedParkingRemoval,
  seedParkingSource,
  seedUnknownParkingRecovery,
  seedHeldParkingChild,
  resetIssuedParkingOperation,
  rejectsUnenrolledParkingPointer,
  seedUnattributedParkingReceipt,
} from "@sealant/db/testing/capture-preservation";
import { Arbitrary, Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseCaptureDrainLedger } from "./capture-drain-ledger.js";
import { authorizedDeletion, removeUnderDeletion } from "./capture-drain.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
const past = new Date("2026-01-01T00:00:00Z");
type ResolvedCaptureRepo = Omit<WorkspaceCaptureDrainRepoService, "preservation"> & {
  readonly preservation: Effect.Success<WorkspaceCaptureDrainRepoService["preservation"]>;
};

const repo = <A, E>(db: DB, use: (value: ResolvedCaptureRepo) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const value = yield* WorkspaceCaptureDrainRepo;
      return yield* use({ ...value, preservation: yield* value.preservation });
    }).pipe(
      Effect.provide(
        WorkspaceCaptureDrainRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db))),
      ),
    ),
  );

describe("canonical Boat custody in migrated Postgres", () => {
  let dbA: DB;
  let dbB: DB;
  let close: () => Promise<void>;
  const owner = `parking_${randomUUID()}`;
  const source = async (retainedAt?: Date) => {
    const runId = `run_parking_${randomUUID()}`;
    await Effect.runPromise(
      dbA.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner }),
    );
    const input = await Effect.runPromise(seedParkingSource(dbA, runId, retainedAt));
    const incarnationId = await repo(dbA, (r) => r.preservation.enrollSource(input));
    return { ...input, incarnationId };
  };
  const retained = async (retainedAt?: Date) => {
    const input = await source(retainedAt);
    await repo(dbA, (r) => r.markRetained({ runId: input.runId, reason: "FINAL incomplete" }));
    return input;
  };

  beforeAll(async () => {
    if (databaseUrl === undefined)
      throw new Error(
        "SEALANT_TEST_DATABASE_URL must name an isolated migrated Postgres; this proof cannot skip",
      );
    await runMigrations({
      databaseUrl,
      migrationsFolder: fileURLToPath(new URL("../../../db/drizzle", import.meta.url)),
      log: () => undefined,
    });
    const scope = await Effect.runPromise(Scope.make());
    const a = await Effect.runPromise(Layer.buildWithScope(makeSealantDBLayer(databaseUrl), scope));
    const b = await Effect.runPromise(Layer.buildWithScope(makeSealantDBLayer(databaseUrl), scope));
    dbA = Context.get(a, SealantDB);
    dbB = Context.get(b, SealantDB);
    close = () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    await Effect.runPromise(
      dbA
        .insert(user)
        .values({ id: owner, name: "parking ledger", email: `${owner}@example.invalid` }),
    );
  }, 90000);
  afterAll(async () => {
    await close?.();
  });

  it("records a running failure using DB time and freezes the default deadline once", async () => {
    const s = await retained();
    const first = await Effect.runPromise(parkingRows(dbA, s.runId));
    expect(first.episode).toHaveLength(1);
    const episode = first.episode[0];
    expect(episode?.timeBasis).toBe("recorded");
    expect(episode?.retainedAt).toEqual(episode?.recordedAt);
    expect(episode?.delaySeconds).toBe(3600);
    expect((episode?.eligibleAt.getTime() ?? 0) - (episode?.retainedAt.getTime() ?? 0)).toBe(
      3600000,
    );
    await repo(dbB, (r) =>
      r.markRetained({
        runId: s.runId,
        reason: "another failure after reload",
        policy: { retainedParkingDelaySeconds: 300, automaticParkingEnabled: false },
      }),
    );
    await repo(dbB, (r) =>
      r.recordRecoveryAttempt({
        runId: s.runId,
        error: "not activated",
        nextRecoveryAt: new Date("2027-01-01T00:00:00Z"),
      }),
    );
    const reloaded = await Effect.runPromise(parkingRows(dbB, s.runId));
    expect(reloaded.episode).toEqual(first.episode);
    expect(reloaded.root?.retainedAt).toEqual(first.root?.retainedAt);
    expect(reloaded.root?.captureTokenSealed).toBe("synthetic-sealed-value");
    const facts = await repo(dbB, (r) => r.preservation.read(s.runId));
    expect(facts).toMatchObject({
      state: "retained",
      snapshotOnly: false,
      parkingDelaySeconds: 3600,
      allowance: { state: "unknown", reason: "not-observed" },
    });
    expect(facts?.vms[0]).toMatchObject({
      id: s.sandboxId,
      compute: { state: "unknown", reason: "not-observed" },
    });
    expect(JSON.parse(JSON.stringify(facts))).toEqual(facts);
  });

  it("rejects an unenrolled current pointer before the deferred identity check", async () => {
    const runId = `run_parking_${randomUUID()}`;
    await Effect.runPromise(
      dbA.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner }),
    );
    await Effect.runPromise(seedParkingSource(dbA, runId));
    expect(await Effect.runPromise(rejectsUnenrolledParkingPointer(dbA, runId))).toBe(true);
    expect(
      (await Effect.runPromise(parkingRows(dbB, runId))).root?.currentIncarnationId,
    ).toBeNull();
  });

  it.each([0, -1, 299, 604801, 300.5, null, "3600", Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid delay %s before retaining anything",
    async (delay) => {
      const s = await source();
      await expect(
        repo(dbA, (r) =>
          r.markRetained({
            runId: s.runId,
            reason: "failed",
            policy: { retainedParkingDelaySeconds: delay },
          }),
        ),
      ).rejects.toThrow();
      expect((await Effect.runPromise(parkingRows(dbA, s.runId))).root?.retainedAt).toBeNull();
    },
  );

  it.each([300, 604800])("accepts delay boundary %s", async (delay) => {
    const s = await source();
    await repo(dbA, (r) =>
      r.markRetained({
        runId: s.runId,
        reason: "failed",
        policy: { retainedParkingDelaySeconds: delay },
      }),
    );
    expect((await repo(dbA, (r) => r.preservation.read(s.runId)))?.parkingDelaySeconds).toBe(delay);
  });

  it("keeps trusted historical retention without inventing an earlier failure", async () => {
    const s = await retained(past);
    const rows = await Effect.runPromise(parkingRows(dbA, s.runId));
    expect(rows.episode[0]).toMatchObject({
      retainedAt: past,
      timeBasis: "existing-retention",
      eligibleAt: new Date(past.getTime() + 3600000),
    });
  });

  it("adopts an existing retained source and its policy atomically across a crash", async () => {
    const runId = `run_parking_${randomUUID()}`;
    await Effect.runPromise(
      dbA.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner }),
    );
    const input = await Effect.runPromise(seedParkingSource(dbA, runId, past));
    const policy = { retainedParkingDelaySeconds: 300 };
    await expect(
      repo(dbA, (r) =>
        dbA.transaction(() =>
          Effect.gen(function* () {
            yield* r.preservation.enrollSource(input, policy);
            return yield* Effect.fail(new Error("injected crash before adoption commit"));
          }),
        ),
      ),
    ).rejects.toThrow("injected crash");
    const failed = await Effect.runPromise(parkingRows(dbB, runId));
    expect(failed.root?.custodyContract).toBeNull();
    expect(failed.sources).toEqual([]);
    expect(failed.episode).toEqual([]);
    const id = await repo(dbB, (r) => r.preservation.enrollSource(input, policy));
    const before = await Effect.runPromise(parkingRows(dbB, runId));
    expect(before.episode[0]).toMatchObject({
      retainedAt: past,
      delaySeconds: 300,
      timeBasis: "existing-retention",
    });
    expect(await repo(dbA, (r) => r.preservation.enrollSource(input))).toBe(id);
    expect((await Effect.runPromise(parkingRows(dbA, runId))).episode).toEqual(before.episode);
  });

  it("reserves only eligible close intentions and never grants dispatch", async () => {
    const early = await retained();
    const earlyClaim = await repo(dbA, (r) => r.preservation.claim(early.runId));
    if (earlyClaim === undefined) throw new Error("missing claim");
    expect(await repo(dbA, (r) => r.preservation.reserveClose(earlyClaim))).toEqual({
      kind: "blocked",
      reason: "not-eligible",
    });
    const s = await retained(past);
    const claim = await repo(dbA, (r) => r.preservation.claim(s.runId));
    if (claim === undefined) throw new Error("missing claim");
    expect(
      await repo(dbA, (r) =>
        r.preservation.reserveClose(claim, { automaticParkingEnabled: false }),
      ),
    ).toEqual({ kind: "blocked", reason: "automatic-parking-disabled" });
    const result = await repo(dbA, (r) => r.preservation.reserveClose(claim));
    if (result.kind !== "reserved") throw new Error("missing reservation");
    expect(await repo(dbA, (r) => r.preservation.issue(claim, result.operationId))).toEqual({
      kind: "blocked",
      reason: "executor-unavailable",
    });
    const rows = await Effect.runPromise(parkingRows(dbA, s.runId));
    expect(rows.effects).toHaveLength(1);
    expect(rows.effects[0]).toMatchObject({ state: "prepared", issuedAt: null, issuedFence: null });
    await Effect.runPromise(expireParkingClaim(dbB, s.runId));
    const restarted = await repo(dbB, (r) => r.preservation.claim(s.runId));
    if (restarted === undefined) throw new Error("missing restarted claim");
    expect(
      await repo(dbB, (r) =>
        r.preservation.reserveClose(restarted, { automaticParkingEnabled: false }),
      ),
    ).toEqual(result);
    expect((await Effect.runPromise(parkingRows(dbB, s.runId))).effects).toHaveLength(1);
  });

  it("admits one concurrent claimant and refuses an expired owner before and after takeover", async () => {
    const s = await retained(past);
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        repo(n % 2 === 0 ? dbA : dbB, (r) => r.preservation.claim(s.runId)),
      ),
    );
    const winners = claims.filter((claim) => claim !== undefined);
    expect(winners).toHaveLength(1);
    const old = winners[0];
    if (old === undefined) throw new Error("missing winner");
    await Effect.runPromise(expireParkingClaim(dbB, s.runId));
    expect(await repo(dbA, (r) => r.preservation.renew(old))).toBe(false);
    expect(await repo(dbA, (r) => r.preservation.reserveClose(old))).toEqual({
      kind: "claim-lost",
    });
    const fresh = await repo(dbB, (r) => r.preservation.claim(s.runId));
    expect(fresh?.fence).toBe(old.fence + 1);
    expect(await repo(dbA, (r) => r.preservation.reserveClose(old))).toEqual({
      kind: "claim-lost",
    });
    await repo(dbA, (r) => r.preservation.release(old));
    expect((await Effect.runPromise(parkingRows(dbA, s.runId))).root?.preservationClaimToken).toBe(
      fresh?.token,
    );
  });

  it("claims disjoint bounded due batches using two connections", async () => {
    await retained(past);
    await retained(past);
    const [a, b] = await Promise.all([
      repo(dbA, (r) => r.preservation.claimDue(10)),
      repo(dbB, (r) => r.preservation.claimDue(10)),
    ]);
    expect(a.length + b.length).toBeGreaterThanOrEqual(2);
    expect(a.length).toBeLessThanOrEqual(10);
    expect(b.length).toBeLessThanOrEqual(10);
    expect(a.some((claim) => b.some((other) => claim.runId === other.runId))).toBe(false);
  });

  it.each(["stopped", "gone", "discarded"] as const)(
    "refuses contract-2 and terminal %s clears",
    async (state) => {
      const s = await retained(past);
      const before = await Effect.runPromise(parkingRows(dbA, s.runId));
      await expect(Effect.runPromise(oldParkingWriter(dbA, s.runId, state))).rejects.toThrow();
      await expect(
        repo(dbA, (r) => r.recordObservation({ runId: s.runId, state, detail: "old path" })),
      ).rejects.toThrow();
      const after = await Effect.runPromise(parkingRows(dbB, s.runId));
      expect(after.root?.retainedAt).toEqual(before.root?.retainedAt);
      expect(after.root?.retentionEpisodeId).toEqual(before.root?.retentionEpisodeId);
      expect(after.root?.captureTokenSealed).toEqual(before.root?.captureTokenSealed);
      expect(after.pin?.state).toBe("retained");
    },
  );

  it("keeps the original runtime and source incarnation immutable", async () => {
    const s = await retained();
    const { incarnationId, ...input } = s;
    expect(await repo(dbA, (r) => r.preservation.enrollSource(input))).toBe(incarnationId);
    await expect(
      repo(dbA, (r) => r.preservation.enrollSource({ ...input, sandboxId: "bx_different" })),
    ).rejects.toThrow();
    await expect(Effect.runPromise(rewriteParkingSource(dbA, s.runId))).rejects.toThrow();
    const rows = await Effect.runPromise(parkingRows(dbB, s.runId));
    expect(rows.sources).toHaveLength(1);
    expect(rows.sources[0]).toMatchObject({
      id: s.incarnationId,
      sandboxId: s.sandboxId,
      runtimeInstanceId: s.runId,
    });
  });

  it("refuses issued removal without committed verified custody and rolls the entire transaction back", async () => {
    const s = await retained();
    await expect(Effect.runPromise(seedParkingRemoval(dbA, s.runId, false))).rejects.toThrow();
    expect((await Effect.runPromise(parkingRows(dbB, s.runId))).effects).toHaveLength(0);
    expect((await repo(dbA, (r) => r.preservation.read(s.runId)))?.snapshots).toEqual([]);
    await expect(Effect.runPromise(seedMissingParkingDetail(dbA, s.runId))).rejects.toThrow();
    expect((await Effect.runPromise(parkingRows(dbB, s.runId))).effects).toHaveLength(0);
  });

  it("keeps unknown issued effects occupied after restart with new intentions disabled", async () => {
    const s = await retained(past);
    const effect = await Effect.runPromise(seedIssuedParkingClose(dbA, s.runId));
    const first = await repo(dbA, (r) => r.preservation.claim(s.runId));
    if (first === undefined) throw new Error("missing claim");
    await Effect.runPromise(expireParkingClaim(dbB, s.runId));
    const restarted = await repo(dbB, (r) => r.preservation.claim(s.runId));
    if (restarted === undefined) throw new Error("missing restarted claim");
    expect(
      await repo(dbB, (r) =>
        r.preservation.reserveClose(restarted, { automaticParkingEnabled: false }),
      ),
    ).toEqual({ kind: "observe-only" });
    const observation = {
      runId: s.runId,
      ...effect,
      receiptId: randomUUID(),
      kind: "unknown",
      observedAt: new Date(),
    };
    expect(await repo(dbA, (r) => r.preservation.observe(observation))).toBe("recorded");
    expect(await repo(dbB, (r) => r.preservation.observe(observation))).toBe("duplicate");
    expect(await repo(dbB, (r) => r.preservation.issue(restarted, effect.operationId))).toEqual({
      kind: "observe-only",
    });
    const rows = await Effect.runPromise(parkingRows(dbB, s.runId));
    expect(rows.effects).toHaveLength(1);
    expect(rows.effects[0]?.state).toBe("unknown");
    await expect(
      Effect.runPromise(resetIssuedParkingOperation(dbB, effect.operationId)),
    ).rejects.toThrow();
    await expect(Effect.runPromise(releaseParkingPublication(dbA, s.runId))).rejects.toThrow();
  });

  it("distinguishes verified snapshot with unresolved compute from exact completed source removal", async () => {
    const s = await retained(past);
    const effect = await Effect.runPromise(seedParkingRemoval(dbA, s.runId, true));
    const parking = await repo(dbA, (r) => r.preservation.read(s.runId));
    expect(parking).toMatchObject({ state: "parking", snapshotOnly: false });
    expect(parking?.vms[0]).toMatchObject({
      id: s.sandboxId,
      removal: "unresolved",
      compute: { state: "unknown", reason: "removal-unresolved" },
    });
    expect(parking?.snapshots[0]).toMatchObject({
      snapshotId: "snapshot_exact",
      state: "verified",
    });
    const observation = {
      runId: s.runId,
      ...effect,
      receiptId: randomUUID(),
      kind: "removal-completed",
      observedAt: new Date(),
    };
    expect(await repo(dbB, (r) => r.preservation.observe(observation))).toBe("recorded");
    expect(await repo(dbA, (r) => r.preservation.observe(observation))).toBe("duplicate");
    const parked = await repo(dbB, (r) => r.preservation.read(s.runId));
    expect(parked).toMatchObject({
      state: "parked",
      snapshotOnly: true,
      currentIncarnationId: s.incarnationId,
    });
    expect(parked?.vms[0]).toMatchObject({
      id: s.sandboxId,
      removal: "completed",
      compute: { state: "not-running", basis: "completed-removal" },
    });
    const rows = await Effect.runPromise(parkingRows(dbB, s.runId));
    expect(rows.root?.state).toBe("kept");
    expect(rows.root?.retainedAt).toEqual(past);
    expect(rows.root?.captureTokenSealed).toBe("synthetic-sealed-value");
    expect(rows.sources[0]?.sandboxId).toBe(s.sandboxId);
    await expect(Effect.runPromise(releaseParkingPublication(dbA, s.runId))).rejects.toThrow();
  });

  it("quarantines a wrong-target receipt without settling the issued operation", async () => {
    const s = await retained();
    const effect = await Effect.runPromise(seedParkingRemoval(dbA, s.runId, true));
    expect(
      await repo(dbB, (r) =>
        r.preservation.observe({
          runId: s.runId,
          ...effect,
          sandboxId: "wrong-vm",
          receiptId: randomUUID(),
          kind: "removal-completed",
          observedAt: new Date(),
        }),
      ),
    ).toBe("conflict");
    expect((await repo(dbB, (r) => r.preservation.read(s.runId)))?.state).toBe("unknown");
    const rows = await Effect.runPromise(parkingRows(dbA, s.runId));
    expect(rows.sources[0]?.removedAt).toBeNull();
    expect(rows.effects.find((op) => op.id === effect.operationId)?.state).toBe("issued");
  });

  it("rolls back crashes before a retention or intention commit", async () => {
    const s = await source();
    await expect(
      repo(dbA, (r) =>
        dbA.transaction(() =>
          Effect.gen(function* () {
            yield* r.markRetained({ runId: s.runId, reason: "failed" });
            return yield* Effect.fail(new Error("injected crash before retention commit"));
          }),
        ),
      ),
    ).rejects.toThrow("injected crash");
    expect((await Effect.runPromise(parkingRows(dbB, s.runId))).episode).toEqual([]);
    await repo(dbA, (r) => r.markRetained({ runId: s.runId, reason: "retry after crash" }));
    const due = await retained(past);
    const claim = await repo(dbA, (r) => r.preservation.claim(due.runId));
    if (claim === undefined) throw new Error("missing claim");
    await expect(
      repo(dbA, (r) =>
        dbA.transaction(() =>
          Effect.gen(function* () {
            yield* r.preservation.reserveClose(claim);
            return yield* Effect.fail(new Error("injected crash before intention commit"));
          }),
        ),
      ),
    ).rejects.toThrow("injected crash");
    expect((await Effect.runPromise(parkingRows(dbB, due.runId))).effects).toEqual([]);
    expect((await repo(dbB, (r) => r.preservation.reserveClose(claim))).kind).toBe("reserved");
  });

  it("keeps allowance as a dated aggregate against ten included slots", async () => {
    const s = await retained();
    await Effect.runPromise(seedParkingAllowance(dbA, s.accountScope, true));
    const facts = await repo(dbB, (r) => r.preservation.read(s.runId));
    expect(facts?.allowance).toMatchObject({
      state: "unknown",
      reason: "stale",
      lastObserved: {
        scope: s.accountScope,
        included: 10,
        used: 12,
        extra: 2,
        extraDailyDollars: 0.112,
      },
    });
    expect(facts?.allowance.lastObserved?.observedAt).toBeTypeOf("string");
  });

  it("records monotonic discard and blocks the generic ticketless deletion path", async () => {
    const s = await retained(past);
    await repo(dbA, (r) => r.requestDiscard({ runId: s.runId, requestedBy: owner }));
    await repo(dbB, (r) => r.requestRecovery(s.runId));
    const second = await repo(dbB, (r) =>
      r.requestDiscard({ runId: s.runId, requestedBy: "different-owner" }),
    );
    expect(second.discardRequestedBy).toBe(owner);
    expect((await repo(dbA, (r) => r.preservation.read(s.runId)))?.desired).toBe("discard");
    const ledger = databaseCaptureDrainLedger({ db: dbA, owner: "legacy-worker", leaseMs: 60000 });
    const authorized = await Effect.runPromise(
      authorizedDeletion({
        ledger,
        runId: s.runId,
        runtime: "running",
        decide: () => ({ delete: true, basis: "discarded" }),
      }),
    );
    expect(authorized.decision.delete).toBe(false);
    let destructiveCalls = 0;
    const result = await Effect.runPromise(
      removeUnderDeletion({
        ledger,
        runId: s.runId,
        ticket: undefined,
        remove: Effect.sync(() => {
          destructiveCalls += 1;
        }),
      }),
    );
    expect(result.removed).toBe(false);
    expect(destructiveCalls).toBe(0);
    const unreadable = await Effect.runPromise(
      removeUnderDeletion({
        ledger: { ...ledger, read: () => Effect.succeed({ readable: false }) },
        runId: s.runId,
        ticket: undefined,
        remove: Effect.sync(() => {
          destructiveCalls += 1;
        }),
      }),
    );
    expect(unreadable.removed).toBe(false);
    expect(destructiveCalls).toBe(0);
    expect(await Effect.runPromise(ledger.claim(s.runId))).toBeUndefined();
    expect(await Effect.runPromise(ledger.claimRecovery(s.runId, 60000))).toBeUndefined();
    const claim = await repo(dbA, (r) => r.preservation.claim(s.runId));
    if (claim === undefined) throw new Error("missing claim");
    expect(await repo(dbA, (r) => r.preservation.reserveClose(claim))).toEqual({
      kind: "blocked",
      reason: "discard-requested",
    });
  });

  it("preserves issued removal through a crash before receipt commit and accepts late replay", async () => {
    const s = await retained(past);
    const effect = await Effect.runPromise(seedParkingRemoval(dbA, s.runId, true));
    await expect(
      Effect.runPromise(
        seedUnattributedParkingReceipt(dbA, s.runId, effect.operationId, s.sandboxId),
      ),
    ).rejects.toThrow();
    const observation = {
      runId: s.runId,
      ...effect,
      receiptId: randomUUID(),
      kind: "removal-completed",
      observedAt: new Date(),
    };
    await expect(
      repo(dbA, (r) =>
        dbA.transaction(() =>
          Effect.gen(function* () {
            yield* r.preservation.observe(observation);
            return yield* Effect.fail(new Error("injected crash before receipt commit"));
          }),
        ),
      ),
    ).rejects.toThrow("injected crash");
    expect((await repo(dbB, (r) => r.preservation.read(s.runId)))?.state).toBe("parking");
    expect((await Effect.runPromise(parkingRows(dbB, s.runId))).sources[0]?.removedAt).toBeNull();
    expect(await repo(dbB, (r) => r.preservation.observe(observation))).toBe("recorded");
    expect(
      await repo(dbA, (r) => r.preservation.observe({ ...observation, receiptId: randomUUID() })),
    ).toBe("duplicate");
    expect((await repo(dbB, (r) => r.preservation.read(s.runId)))?.state).toBe("parked");
  });

  it("keeps unknown recovery allocation exclusive and preserves the episode for a new held child", async () => {
    const s = await retained(past);
    const effect = await Effect.runPromise(seedParkingRemoval(dbA, s.runId, true));
    await repo(dbA, (r) =>
      r.preservation.observe({
        runId: s.runId,
        ...effect,
        receiptId: randomUUID(),
        kind: "removal-completed",
        observedAt: new Date(),
      }),
    );
    const before = await Effect.runPromise(parkingRows(dbA, s.runId));
    const reservation = await Effect.runPromise(
      seedUnknownParkingRecovery(dbA, s.runId, effect.operationId),
    );
    await expect(
      Effect.runPromise(seedUnknownParkingRecovery(dbB, s.runId, effect.operationId)),
    ).rejects.toThrow();
    expect(await repo(dbB, (r) => r.preservation.read(s.runId))).toMatchObject({
      state: "recovering",
      snapshotOnly: false,
    });
    const childSandboxId = await Effect.runPromise(seedHeldParkingChild(dbB, s.runId, reservation));
    await repo(dbB, (r) =>
      r.markRetained({
        runId: s.runId,
        reason: "held child not activated",
        policy: { retainedParkingDelaySeconds: 300 },
      }),
    );
    const after = await Effect.runPromise(parkingRows(dbA, s.runId));
    expect(after.episode).toEqual(before.episode);
    expect(after.root?.currentIncarnationId).toBe(s.incarnationId);
    expect(after.sources.find((row) => row.id === s.incarnationId)).toEqual(before.sources[0]);
    expect(
      after.sources.find((row) => row.id === reservation.destinationIncarnationId),
    ).toMatchObject({
      parentIncarnationId: s.incarnationId,
      sandboxId: childSandboxId,
      runtimeInstanceId: reservation.destinationRuntimeInstanceId,
    });
    expect((await repo(dbA, (r) => r.preservation.read(s.runId)))?.vms).toHaveLength(2);
    await expect(Effect.runPromise(releaseParkingPublication(dbA, s.runId))).rejects.toThrow();
  });

  it("projects dated running compute and refuses stale or wrong-target replacement", async () => {
    const s = await retained();
    const observation = {
      runId: s.runId,
      incarnationId: s.incarnationId,
      sandboxId: s.sandboxId,
      state: "running",
      observedAt: new Date(),
    };
    expect(await repo(dbA, (r) => r.preservation.recordCompute(observation))).toBe(true);
    expect((await repo(dbB, (r) => r.preservation.read(s.runId)))?.vms[0]?.compute).toMatchObject({
      state: "running",
      basis: "provider-running",
      observedAt: observation.observedAt.toISOString(),
    });
    expect(
      await repo(dbA, (r) =>
        r.preservation.recordCompute({ ...observation, observedAt: past, state: "not-running" }),
      ),
    ).toBe(false);
    expect(
      await repo(dbA, (r) =>
        r.preservation.recordCompute({ ...observation, sandboxId: "wrong-vm" }),
      ),
    ).toBe(false);
    const stale = await retained();
    expect(
      await repo(dbA, (r) =>
        r.preservation.recordCompute({
          runId: stale.runId,
          incarnationId: stale.incarnationId,
          sandboxId: stale.sandboxId,
          state: "running",
          observedAt: past,
        }),
      ),
    ).toBe(true);
    expect(
      (await repo(dbB, (r) => r.preservation.read(stale.runId)))?.vms[0]?.compute,
    ).toMatchObject({
      state: "unknown",
      reason: "stale",
      lastObserved: { state: "running", observedAt: past.toISOString() },
    });
  });

  it("preserves issued packets and frozen policy across generated retry and owner schedules", async () => {
    const schedules = Arbitrary.array(
      Arbitrary.schema(
        Schema.Literals([
          "expire",
          "observe-unknown",
          "observe-pending",
          "reload",
          "discard",
          "recover",
          "old-writer",
        ]),
      ),
      { minLength: 1, maxLength: 10 },
    );
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(
        schedules,
        (commands) =>
          Effect.tryPromise(async () => {
            const s = await retained(past);
            const effect = await Effect.runPromise(seedIssuedParkingClose(dbA, s.runId));
            const before = await Effect.runPromise(parkingRows(dbA, s.runId));
            for (const command of commands) {
              switch (command) {
                case "expire": {
                  await Effect.runPromise(expireParkingClaim(dbA, s.runId));
                  const claim = await repo(dbB, (r) => r.preservation.claim(s.runId));
                  if (claim !== undefined)
                    expect(
                      await repo(dbB, (r) => r.preservation.issue(claim, effect.operationId)),
                    ).toEqual({ kind: "observe-only" });
                  break;
                }
                case "observe-unknown":
                case "observe-pending":
                  await repo(dbB, (r) =>
                    r.preservation.observe({
                      runId: s.runId,
                      ...effect,
                      receiptId: randomUUID(),
                      kind: command === "observe-unknown" ? "unknown" : "pending",
                      observedAt: new Date(),
                    }),
                  );
                  break;
                case "reload":
                  await repo(dbB, (r) =>
                    r.markRetained({
                      runId: s.runId,
                      reason: "repeated failure",
                      policy: {
                        retainedParkingDelaySeconds: 604800,
                        automaticParkingEnabled: false,
                      },
                    }),
                  );
                  break;
                case "discard":
                  await repo(dbB, (r) => r.requestDiscard({ runId: s.runId, requestedBy: owner }));
                  break;
                case "recover":
                  await repo(dbB, (r) => r.requestRecovery(s.runId));
                  break;
                case "old-writer":
                  await expect(
                    Effect.runPromise(oldParkingWriter(dbA, s.runId, "gone")),
                  ).rejects.toThrow();
                  break;
              }
              const after = await Effect.runPromise(parkingRows(dbA, s.runId));
              expect(after.episode).toEqual(before.episode);
              expect(after.sources).toEqual(before.sources);
              expect(after.effects).toHaveLength(1);
              expect(after.effects[0]?.issuedAt).toEqual(before.effects[0]?.issuedAt);
              expect(after.effects[0]?.requestDigest).toEqual(before.effects[0]?.requestDigest);
              expect(after.effects[0]?.state).not.toBe("prepared");
              expect(after.pin?.releasedAt).toBeNull();
              expect(after.root?.captureTokenSealed).toBe("synthetic-sealed-value");
            }
            return true;
          }),
        { runs: 16, size: 10, seed: "boat-parking-ledger-stage1" },
      ),
    );
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
    expect(result).toMatchObject({ _tag: "Passed", runs: 16 });
  }, 30000);
});
