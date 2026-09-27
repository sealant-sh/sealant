/**
 * The drain ledger against a REAL Postgres, as two workers see it: two database clients, two
 * owners, one `workspace_capture_drains` table. Gated on SEALANT_TEST_DATABASE_URL (a disposable
 * database with the migrations applied; it writes rows under fresh ids and leaves them) so it
 * skips where none is configured.
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/capture-drain-ledger.db.test.ts
 */
import { randomUUID } from "node:crypto";

import { createSealantDB, user, workspaceAttempts, type DB } from "@sealant/db";
import { Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import type { SealantTarget } from "../sealantd/runtime.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { databaseCaptureDrainLedger } from "./capture-drain-ledger.js";
import { drainCaptureBeforeStop, type CaptureDrainLedger } from "./capture-drain.js";

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
    const entry = await Effect.runPromise(b.claim(runId));
    expect(entry?.last).toMatchObject({ complete: true, pending: 0 });
    expect(entry?.lastProgressAt).toBeTypeOf("number");
  });

  it("takes over a dead worker's lease once it expires, and fences the dead worker's writes", async () => {
    const runId = await newRun();
    const dead = worker(dbA, "worker-dead", 150);
    const live = worker(dbB, "worker-live", 150);

    expect(await Effect.runPromise(dead.claim(runId))).toBeDefined();
    expect(await Effect.runPromise(live.claim(runId))).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await Effect.runPromise(live.claim(runId))).toBeDefined();
    // The dead worker comes back: its progress write is refused, and it gives the drain up.
    expect(
      await Effect.runPromise(
        dead.save(
          runId,
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
});
