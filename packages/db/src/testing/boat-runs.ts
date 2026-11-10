import { randomUUID } from "node:crypto";

import { boatExecutionTargetSchema, type BoatExecutionTarget } from "@sealant/validators";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { DB } from "../client.js";
import { boatRuns } from "../schema/boat-runs.js";
import { nativePublications } from "../schema/native-publications.js";
import {
  workspaceCaptureDrains,
  workspaceRuntimeInstances,
} from "../schema/workspace-build-jobs.js";

/**
 * Write columns of a run's row as they are, only in an owned disposable database: a malformed
 * value the repository must refuse, or a state no statement of its own reaches. The table's
 * checks still apply.
 */
export const corruptBoatRun = (
  db: DB,
  runId: string,
  columns: Partial<typeof boatRuns.$inferInsert>,
) => db.update(boatRuns).set(columns).where(eq(boatRuns.runId, runId));

interface BoatRunSeed {
  readonly runId: string;
  readonly deploymentId?: string;
  readonly workspaceId?: string;
  readonly launchAttemptId?: string;
  readonly sandboxId?: string;
  readonly diskLineage?: string;
  readonly bound?: boolean;
}

/** The rows `seedBoatRun` writes, for a caller that writes many at once. */
export const boatRunSeedRows = (input: BoatRunSeed) => {
  const publicationId = randomUUID();
  const deploymentId = input.deploymentId ?? "test";
  const target: BoatExecutionTarget = boatExecutionTargetSchema.parse({
    deploymentId,
    workspaceId: input.workspaceId ?? "workspace",
    runId: input.runId,
    runtimeInstanceId: input.runId,
    launchAttemptId: input.launchAttemptId ?? "attempt",
    sourceId: publicationId,
    sandboxId: input.sandboxId ?? "bx_23456789",
    diskLineage: input.diskLineage ?? randomUUID(),
    bootId: randomUUID(),
    manifestDigest: "b".repeat(64),
  });
  return {
    target,
    publication: {
      id: publicationId,
      buildId: randomUUID(),
      keyHash: randomUUID(),
      keyPayload: {},
      deploymentId,
      scopeKind: "owner",
      scopeId: "seeded",
      recipeHash: "e".repeat(64),
    } satisfies typeof nativePublications.$inferInsert,
    run: {
      runId: target.runId,
      deploymentId,
      publicationId,
      workspaceId: target.workspaceId,
      launchAttemptId: target.launchAttemptId,
      manifestDigest: target.manifestDigest,
      snapshotName: "seeded",
      idempotencyKey: randomUUID(),
      diskLineage: target.diskLineage,
      // A minute ago: an issue time is never in the future, whichever clock reads it.
      createIssuedAt: new Date(Date.now() - 60_000),
      sandboxId: target.sandboxId,
      createdSeenAt: new Date(Date.now() - 60_000),
      target: input.bound === false ? null : target,
    } satisfies typeof boatRuns.$inferInsert,
  };
};

/**
 * A run's row with a VM on record, bound to its boot unless `bound` is false, written straight to
 * the table: what a test of the launch owner or the tunnel starts from without creating a VM. It
 * makes the publication the row names. The run's attempt must exist.
 */
export const seedBoatRun = (db: DB, input: BoatRunSeed) =>
  Effect.gen(function* () {
    const rows = boatRunSeedRows(input);
    yield* db.insert(nativePublications).values(rows.publication);
    yield* db.insert(boatRuns).values(rows.run);
    return rows.target;
  });

/** Reconstruct a pre-fix closed launch with the untouched capture-token row it left behind. */
export const restoreUnprogressedCaptureDrain = (db: DB, runId: string, sealed: string) =>
  db
    .update(workspaceCaptureDrains)
    .set({
      state: null,
      detail: null,
      observedAt: null,
      captureTokenSealed: sealed,
    })
    .where(eq(workspaceCaptureDrains.runId, runId));

/**
 * End the hold on a run's removal now, as it ends on its own once its holder (a worker that
 * died) stops renewing it: what is recorded of the removal stays as it is.
 */
export const lapseCaptureDeletionHold = (db: DB, runId: string) =>
  db
    .update(workspaceCaptureDrains)
    .set({ deletionExpiresAt: new Date(Date.now() - 1_000) })
    .where(eq(workspaceCaptureDrains.runId, runId));

/** A Boat launch that failed after its VM was created, as the build worker records it. */
export const recordRetainedBoatLaunch = (
  db: DB,
  input: { readonly runId: string; readonly sandboxId: string; readonly errorCode: string },
) =>
  db
    .update(workspaceRuntimeInstances)
    .set({
      adapter: "boat",
      status: "failed",
      resourceId: input.sandboxId,
      reference: input.runId,
      errorCode: input.errorCode,
      errorMessage: "launch failed after the VM was created",
    })
    .where(eq(workspaceRuntimeInstances.runId, input.runId));

/** Age a run's create, as a launch issued long ago would be: its replay window is read from it. */
export const backdateBoatCreate = (db: DB, runId: string, ms: number) =>
  db
    .update(boatRuns)
    .set({ createIssuedAt: sql`now() - ${ms} * interval '1 millisecond'` })
    .where(eq(boatRuns.runId, runId));

/**
 * A claim on the run's first DELETE taken `ms` ago, as a removal that claimed and vanished left
 * it: nothing recorded of the DELETE it may have sent. The run's VM is fenced with it.
 */
export const claimBoatDeletionAgo = (db: DB, runId: string, ms: number) =>
  db
    .update(boatRuns)
    .set({
      deletionClaimedAt: sql`date_trunc('milliseconds', now() - ${ms} * interval '1 millisecond')`,
      fencedAt: sql`coalesce(${boatRuns.fencedAt}, now())`,
    })
    .where(eq(boatRuns.runId, runId));

/** A launch whose worker died: its row stays pending and its launch ownership has lapsed. */
export const strandBoatLaunch = (
  db: DB,
  input: { readonly runId: string; readonly sandboxId: string },
) =>
  db
    .update(workspaceRuntimeInstances)
    .set({
      adapter: "boat",
      status: "pending",
      resourceId: input.sandboxId,
      reference: input.runId,
      stopReason: null,
      launchOwner: "worker-that-died",
      launchLeaseExpiresAt: new Date(Date.now() - 60_000),
    })
    .where(eq(workspaceRuntimeInstances.runId, input.runId));

/** A launch whose worker is alive: its row is pending and its launch ownership is current. */
export const holdBoatLaunch = (db: DB, runId: string) =>
  db
    .update(workspaceRuntimeInstances)
    .set({
      adapter: "boat",
      status: "pending",
      stopReason: null,
      launchOwner: "worker-still-launching",
      launchLeaseExpiresAt: new Date(Date.now() + 5 * 60_000),
    })
    .where(eq(workspaceRuntimeInstances.runId, runId));
