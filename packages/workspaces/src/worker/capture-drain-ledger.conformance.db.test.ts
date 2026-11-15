/**
 * The capture removal ledger's promises, one set of cases run against both ledgers: the in-memory
 * one most worker tests use, and the Postgres one the worker runs on. A promise one keeps and the
 * other does not fails here, so the tests built on the in-memory ledger cannot drift from what the
 * database does. Each case drives only `CaptureDrainLedger`, as two workers sharing one store.
 *
 * The Postgres half is gated on SEALANT_TEST_DATABASE_URL (a disposable database with the
 * migrations applied; it writes rows under fresh ids and leaves them) and skips without it:
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/capture-drain-ledger.conformance.db.test.ts
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { createSealantDB, user, workspaceAttempts, type DB } from "@sealant/db";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { captureStatus, savedStatus } from "./capture-daemon.fixture.js";
import { databaseCaptureDrainLedger } from "./capture-drain-ledger.js";
import {
  InMemoryCaptureDrainStore,
  inMemoryCaptureDrainLedger,
  type CaptureDrainLedger,
  type DeletionTicket,
} from "./capture-drain.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

/** A recovery ticket that holds no claim: admission answers only what excludes a recovery. */
const NO_CLAIM = { token: "no-recovery-claim" };

/** Longer than any case runs: a request issued within it may still act. */
const RUNTIME_BOUND_MS = 60 * 60_000;

interface Ledgers {
  /** A run the ledgers can hold a record for, with none yet. */
  readonly newRun: () => Effect.Effect<string>;
  /** Two workers sharing one store. */
  readonly a: CaptureDrainLedger;
  readonly b: CaptureDrainLedger;
}

const evidenceVersion = (ledger: CaptureDrainLedger, runId: string) =>
  Effect.gen(function* () {
    const read = yield* ledger.read(runId);
    if (!read.readable) return yield* Effect.die("the record could not be read");
    return read.entry?.evidenceVersion ?? 0;
  });

const removalIssued = (ledger: CaptureDrainLedger, runId: string) =>
  Effect.gen(function* () {
    const read = yield* ledger.read(runId);
    if (!read.readable) return yield* Effect.die("the record could not be read");
    return read.entry?.removalIssued === true;
  });

/** The executor reported its work saved: evidence a removal can be decided on. */
const recordSaved = (ledger: CaptureDrainLedger, runId: string) =>
  ledger.recordStatus(runId, savedStatus({ headN: 7 }), Date.now());

/** A later status, received without a fence: the evidence moved. */
const recordUnsaved = (ledger: CaptureDrainLedger, runId: string, headN: number) =>
  ledger.recordStatus(
    runId,
    captureStatus({ complete: false, incompleteReason: "snapshot-failed", headN }),
    Date.now(),
  );

const authorized = (ledger: CaptureDrainLedger, runId: string, version: number) =>
  Effect.gen(function* () {
    const authorization = yield* ledger.authorizeDeletion(runId, version);
    if (authorization.kind !== "authorized") {
      return yield* Effect.die(`expected authorized, got ${authorization.kind}`);
    }
    return authorization.ticket;
  });

/**
 * A removal decided on saved evidence and issued by worker A, whose call ended with an outcome
 * nobody knows: it stays issued, its hold ended, to be settled from the runtime.
 */
const issuedAndLapsed = (ledgers: Ledgers) =>
  Effect.gen(function* () {
    const runId = yield* ledgers.newRun();
    yield* recordSaved(ledgers.a, runId);
    const ticket = yield* authorized(ledgers.a, runId, yield* evidenceVersion(ledgers.a, runId));
    expect(yield* ledgers.a.issueDeletion(runId, ticket)).toBe(true);
    yield* ledgers.a.lapseIssuedDeletion(runId, ticket);
    return { runId, ticket };
  });

const reissued = (
  ledger: CaptureDrainLedger,
  runId: string,
  fenceMs?: number,
  reauthorizedVersion?: number,
) =>
  Effect.gen(function* () {
    const settled = yield* ledger.reconcileIssuedDeletion(
      runId,
      "present",
      fenceMs,
      reauthorizedVersion,
    );
    if (settled.kind !== "reissue")
      return yield* Effect.die(`expected reissue, got ${settled.kind}`);
    return settled.ticket;
  });

const removalLedgerCases = (ledgersOf: () => Ledgers) => {
  it.effect(
    "authorizes a removal only on the current evidence, with no observation in flight",
    () =>
      Effect.gen(function* () {
        const { newRun, a } = ledgersOf();
        const runId = yield* newRun();
        yield* recordSaved(a, runId);
        const decided = yield* evidenceVersion(a, runId);
        yield* recordUnsaved(a, runId, 8);
        expect(yield* a.authorizeDeletion(runId, decided)).toEqual({ kind: "changed" });

        const fence = yield* a.openObservation(runId, 60_000);
        if (fence === undefined) return yield* Effect.die("the observation was not opened");
        expect(yield* a.authorizeDeletion(runId, yield* evidenceVersion(a, runId))).toEqual({
          kind: "changed",
        });

        yield* a.closeObservation(runId, fence);
        expect((yield* a.authorizeDeletion(runId, yield* evidenceVersion(a, runId))).kind).toBe(
          "authorized",
        );
      }),
  );

  it.effect(
    "admits no observation and no other deleter while a removal is held; a status recorded anyway voids it",
    () =>
      Effect.gen(function* () {
        const { newRun, a, b } = ledgersOf();
        const runId = yield* newRun();
        yield* recordSaved(a, runId);
        const ticket = yield* authorized(a, runId, yield* evidenceVersion(a, runId));

        expect(yield* b.openObservation(runId, 60_000)).toBeUndefined();
        expect(yield* b.authorizeDeletion(runId, yield* evidenceVersion(b, runId))).toEqual({
          kind: "held",
        });

        yield* recordUnsaved(b, runId, 8);
        expect(yield* a.confirmDeletion(runId, ticket)).toBe(false);
        expect(yield* a.issueDeletion(runId, ticket)).toBe(false);
        // Voided, not merely stale: nothing holds the executor, and it is decided again at once.
        expect((yield* b.authorizeDeletion(runId, yield* evidenceVersion(b, runId))).kind).toBe(
          "authorized",
        );
      }),
  );

  it.effect("gives up a removal whose call was not made, so it can be decided again", () =>
    Effect.gen(function* () {
      const { newRun, a, b } = ledgersOf();
      const runId = yield* newRun();
      yield* recordSaved(a, runId);
      const ticket = yield* authorized(a, runId, yield* evidenceVersion(a, runId));
      yield* a.releaseDeletion(runId, ticket);
      expect((yield* b.authorizeDeletion(runId, yield* evidenceVersion(b, runId))).kind).toBe(
        "authorized",
      );
    }),
  );

  it.effect(
    "keeps an issued removal exclusionary until it is recorded done, then admits nothing more",
    () =>
      Effect.gen(function* () {
        const { newRun, a, b } = ledgersOf();
        const runId = yield* newRun();
        yield* recordSaved(a, runId);
        const ticket = yield* authorized(a, runId, yield* evidenceVersion(a, runId));
        expect(yield* a.issueDeletion(runId, ticket)).toBe(true);

        expect(yield* removalIssued(b, runId)).toBe(true);
        expect(yield* b.authorizeDeletion(runId, yield* evidenceVersion(b, runId))).toEqual({
          kind: "held",
        });
        expect(yield* b.openObservation(runId, 60_000)).toBeUndefined();
        expect(yield* b.admitRecovery(runId, NO_CLAIM)).toBe("deleting");

        yield* a.completeDeletion(runId, ticket);
        expect(yield* b.authorizeDeletion(runId, yield* evidenceVersion(b, runId))).toEqual({
          kind: "deleted",
        });
        expect(yield* b.openObservation(runId, 60_000)).toBeUndefined();
        expect(yield* b.admitRecovery(runId, NO_CLAIM)).toBe("deleted");
        expect(yield* b.reconcileIssuedDeletion(runId, "gone")).toEqual({
          kind: "already-deleted",
        });
      }),
  );

  it.effect("settles nothing while no removal is issued, or while its issuer holds it", () =>
    Effect.gen(function* () {
      const { newRun, a, b } = ledgersOf();
      const runId = yield* newRun();
      yield* recordSaved(a, runId);
      expect(yield* b.reconcileIssuedDeletion(runId, "gone")).toEqual({ kind: "none" });

      const ticket = yield* authorized(a, runId, yield* evidenceVersion(a, runId));
      expect(yield* b.reconcileIssuedDeletion(runId, "gone")).toEqual({ kind: "none" });
      expect(yield* a.issueDeletion(runId, ticket)).toBe(true);
      expect(yield* b.reconcileIssuedDeletion(runId, "gone")).toEqual({ kind: "held" });
      expect(yield* removalIssued(b, runId)).toBe(true);
    }),
  );

  it.effect(
    "records an issued removal deleted, once, when its issuer's hold ended and the runtime no longer has the executor",
    () =>
      Effect.gen(function* () {
        const ledgers = ledgersOf();
        const { b } = ledgers;
        const { runId } = yield* issuedAndLapsed(ledgers);
        expect(yield* b.authorizeDeletion(runId, yield* evidenceVersion(b, runId))).toEqual({
          kind: "unresolved",
        });

        expect(yield* b.reconcileIssuedDeletion(runId, "gone")).toEqual({ kind: "deleted" });
        expect(yield* b.reconcileIssuedDeletion(runId, "gone")).toEqual({
          kind: "already-deleted",
        });
        expect(yield* b.reconcileIssuedDeletion(runId, "present")).toEqual({
          kind: "already-deleted",
        });
        expect(yield* b.admitRecovery(runId, NO_CLAIM)).toBe("deleted");
      }),
  );

  it.effect(
    "hands an issued removal to a new holder when the runtime still has the executor and its evidence stands",
    () =>
      Effect.gen(function* () {
        const ledgers = ledgersOf();
        const { a, b } = ledgers;
        const { runId, ticket: lapsed } = yield* issuedAndLapsed(ledgers);

        const ticket = yield* reissued(b, runId);
        expect(ticket.token).not.toBe(lapsed.token);
        expect(yield* a.confirmDeletion(runId, lapsed)).toBe(false);
        expect(yield* a.reconcileIssuedDeletion(runId, "present")).toEqual({ kind: "held" });
        expect(yield* b.issueDeletion(runId, ticket)).toBe(true);
      }),
  );

  it.effect(
    "keeps an issued removal outstanding after the evidence moved while its request may still act, and gives it up past the runtime's bound",
    () =>
      Effect.gen(function* () {
        const ledgers = ledgersOf();
        const { a, b } = ledgers;
        const { runId } = yield* issuedAndLapsed(ledgers);
        yield* recordUnsaved(a, runId, 8);
        expect(yield* removalIssued(b, runId)).toBe(true);

        expect(yield* b.reconcileIssuedDeletion(runId, "present")).toEqual({ kind: "outstanding" });
        expect(yield* b.reconcileIssuedDeletion(runId, "present", RUNTIME_BOUND_MS)).toEqual({
          kind: "outstanding",
        });
        expect(yield* b.openObservation(runId, 60_000)).toBeUndefined();
        expect(yield* b.admitRecovery(runId, NO_CLAIM)).toBe("deleting");

        // A bound of 0: every request it sent is past it, and none can act any more.
        expect(yield* b.reconcileIssuedDeletion(runId, "present", 0)).toEqual({ kind: "released" });
        expect(yield* removalIssued(b, runId)).toBe(false);
        expect(yield* b.openObservation(runId, 60_000)).toBeDefined();
      }),
  );

  it.effect(
    "issues a removal again on evidence that moved when the decision made on it now authorizes the same removal",
    () =>
      Effect.gen(function* () {
        const ledgers = ledgersOf();
        const { a, b } = ledgers;
        const { runId } = yield* issuedAndLapsed(ledgers);
        yield* recordUnsaved(a, runId, 8);
        const current = yield* evidenceVersion(b, runId);

        const ticket: DeletionTicket = yield* reissued(b, runId, RUNTIME_BOUND_MS, current);
        expect(yield* removalIssued(b, runId)).toBe(true);
        // Re-based on what is current: the request may be sent, where the evidence it was first
        // authorized on would refuse it.
        expect(yield* b.issueDeletion(runId, ticket)).toBe(true);
      }),
  );

  it.effect(
    "keeps an issued removal outstanding when the decision that would authorize it again was made before the evidence last moved",
    () =>
      Effect.gen(function* () {
        const ledgers = ledgersOf();
        const { a, b } = ledgers;
        const { runId } = yield* issuedAndLapsed(ledgers);
        yield* recordUnsaved(a, runId, 8);
        const decided = yield* evidenceVersion(b, runId);
        yield* recordUnsaved(a, runId, 9);

        expect(
          yield* b.reconcileIssuedDeletion(runId, "present", RUNTIME_BOUND_MS, decided),
        ).toEqual({ kind: "outstanding" });
        expect(yield* removalIssued(b, runId)).toBe(true);
      }),
  );
};

describe("capture removal ledger (in memory)", () => {
  removalLedgerCases(() => {
    const store = new InMemoryCaptureDrainStore();
    return {
      newRun: () => Effect.sync(() => `run_conformance_${randomUUID()}`),
      a: inMemoryCaptureDrainLedger({ store, owner: "worker-a" }),
      b: inMemoryCaptureDrainLedger({ store, owner: "worker-b" }),
    };
  });
});

describe.skipIf(DATABASE_URL === undefined)("capture removal ledger (Postgres)", () => {
  let dbA: DB;
  let dbB: DB;
  const userId = `user_conformance_${randomUUID()}`;

  beforeAll(async () => {
    dbA = await createSealantDB(DATABASE_URL ?? "");
    dbB = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      dbA.insert(user).values({ id: userId, name: "conformance", email: `${userId}@example.test` }),
    );
  });

  removalLedgerCases(() => ({
    newRun: () =>
      Effect.gen(function* () {
        const runId = `run_conformance_${randomUUID()}`;
        yield* dbA.insert(workspaceAttempts).values({ id: runId, ownerUserId: userId });
        return runId;
      }).pipe(Effect.orDie),
    a: databaseCaptureDrainLedger({ db: dbA, owner: "worker-a", leaseMs: 60_000 }),
    b: databaseCaptureDrainLedger({ db: dbB, owner: "worker-b", leaseMs: 60_000 }),
  }));
});
