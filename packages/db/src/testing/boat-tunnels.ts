import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { DB } from "../client.js";
import { boatRuns } from "../schema/boat-runs.js";
import { boatTunnels } from "../schema/boat-tunnels.js";
import { workspaceAttempts } from "../schema/control-plane.js";
import { nativePublications } from "../schema/native-publications.js";
import { boatRunSeedRows } from "./boat-runs.js";

/** Inject only disposable tunnel records to exercise authentication and parser refusals. */
export const corruptBoatTunnel = (db: DB, id: string, record: unknown) =>
  db.update(boatTunnels).set({ record }).where(eq(boatTunnels.runtimeInstanceId, id));

/**
 * Another caller's release of a run's slot, as `releaseAbsent` commits it, with the slot's row
 * held from its read to its write: `held` is called once the row is locked, and the release is
 * written and committed when `write` resolves. A release that reads the slot meanwhile finds it
 * unreleased, and its own write waits on this one.
 */
export const releaseBoatTunnelHolding = (
  db: DB,
  id: string,
  gate: { readonly held: () => void; readonly write: Promise<void> },
) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      const [row] = yield* tx
        .select()
        .from(boatTunnels)
        .where(eq(boatTunnels.runtimeInstanceId, id))
        .for("update");
      const record = row?.record;
      if (typeof record !== "object" || record === null) return yield* Effect.die("missing tunnel");
      gate.held();
      yield* Effect.promise(() => gate.write);
      yield* tx
        .update(boatTunnels)
        .set({ record: { ...record, absent: true, released: true }, releasedAt: sql`now()` })
        .where(eq(boatTunnels.runtimeInstanceId, id));
    }),
  );

/** How many statements of this database wait on another transaction's lock right now. */
export const boatTunnelLockWaiters = (db: DB) =>
  db
    .select({ waiting: sql<number>`count(*)::int` })
    .from(sql`pg_stat_activity`)
    .where(sql`datname = current_database() and wait_event_type = 'Lock'`)
    .pipe(Effect.map((rows) => rows[0]?.waiting ?? 0));

/** Test that deleting a run's row cannot erase an outstanding tunnel obligation. */
export const deleteBoatRunWithTunnel = (db: DB, id: string) =>
  db.delete(boatRuns).where(eq(boatRuns.runId, id));

/**
 * Hold host ports with disposable reservations (one attempt, run row and tunnel row each), written
 * straight to the tables: what fills a host's range, or stands for a reservation an earlier
 * release made, without preparing hundreds of launches. The database's own checks still apply.
 */
export const occupyBoatTunnelPorts = (
  db: DB,
  input: {
    readonly gatewayHostId: string;
    readonly ownerUserId: string;
    readonly ports: readonly number[];
  },
) =>
  Effect.gen(function* () {
    const rows = input.ports.map((listenPort) => {
      const runId = randomUUID();
      // Its own deployment: a deployment holds one run per VM, and these share a VM id.
      const seed = boatRunSeedRows({ runId, deploymentId: `occupied-${runId}` });
      return { runId, listenPort, reservationId: randomUUID(), seed };
    });
    yield* db
      .insert(workspaceAttempts)
      .values(rows.map((row) => ({ id: row.runId, ownerUserId: input.ownerUserId })));
    yield* db.insert(nativePublications).values(rows.map((row) => row.seed.publication));
    yield* db.insert(boatRuns).values(rows.map((row) => row.seed.run));
    yield* db.insert(boatTunnels).values(
      rows.map((row) => ({
        runtimeInstanceId: row.runId,
        gatewayHostId: input.gatewayHostId,
        listenPort: row.listenPort,
        reservationId: row.reservationId,
        record: {
          binding: { target: row.seed.target, gatewayHostId: input.gatewayHostId },
          reservationId: row.reservationId,
          listenPort: row.listenPort,
          material: null,
        },
      })),
    );
  });
