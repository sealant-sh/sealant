import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { DB } from "../client.js";
import { boatExecutions } from "../schema/boat-executions.js";
import { boatTunnels } from "../schema/boat-tunnels.js";
import { workspaceAttempts } from "../schema/control-plane.js";

/** Inject only disposable tunnel records to exercise authentication and parser refusals. */
export const corruptBoatTunnel = (db: DB, id: string, record: unknown) =>
  db.update(boatTunnels).set({ record }).where(eq(boatTunnels.runtimeInstanceId, id));

/** Test that generic execution deletion cannot erase an outstanding tunnel obligation. */
export const deleteBoatExecutionWithTunnel = (db: DB, id: string) =>
  db.delete(boatExecutions).where(eq(boatExecutions.runtimeInstanceId, id));

/**
 * Hold host ports with disposable reservations (one run, execution and tunnel row each), written
 * straight to the tables: what fills a host's range, or stands for a reservation an earlier
 * release made, without preparing hundreds of executions. The database's own checks still apply.
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
      const target = {
        deploymentId: `occupied-${runId}`,
        workspaceId: "workspace",
        runId,
        runtimeInstanceId: runId,
        launchAttemptId: "attempt",
        sourceId: "publication",
        sandboxId: "bx_23456789",
        diskLineage: "disk",
        bootId: randomUUID(),
        manifestDigest: "b".repeat(64),
      };
      return { runId, target, listenPort, reservationId: randomUUID() };
    });
    yield* db
      .insert(workspaceAttempts)
      .values(rows.map((row) => ({ id: row.runId, ownerUserId: input.ownerUserId })));
    yield* db.insert(boatExecutions).values(
      rows.map((row) => ({
        runtimeInstanceId: row.runId,
        runId: row.runId,
        deploymentId: row.target.deploymentId,
        sandboxId: row.target.sandboxId,
        diskLineage: row.target.diskLineage,
        record: { target: row.target, phase: "control" },
      })),
    );
    yield* db.insert(boatTunnels).values(
      rows.map((row) => ({
        runtimeInstanceId: row.runId,
        gatewayHostId: input.gatewayHostId,
        listenPort: row.listenPort,
        reservationId: row.reservationId,
        record: {
          binding: { target: row.target, gatewayHostId: input.gatewayHostId },
          reservationId: row.reservationId,
          listenPort: row.listenPort,
          material: null,
        },
      })),
    );
  });
