import { eq } from "drizzle-orm";

import type { DB } from "../client.js";
import { boatAllocations } from "../schema/boat-allocations.js";
import { boatObservations } from "../schema/boat-observations.js";
import {
  workspaceCaptureDrains,
  workspaceRuntimeInstances,
} from "../schema/workspace-build-jobs.js";

/** Inject a malformed record only in an owned disposable database, preserving its indexed identity. */
export const corruptBoatAllocation = (db: DB, id: string, record: unknown) =>
  db.update(boatAllocations).set({ record }).where(eq(boatAllocations.runtimeInstanceId, id));

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

/** Age an allocation's reservation, as a launch issued long ago would be. */
export const backdateAllocation = (db: DB, runtimeInstanceId: string, ms: number) =>
  db
    .update(boatAllocations)
    .set({ createdAt: new Date(Date.now() - ms) })
    .where(eq(boatAllocations.runtimeInstanceId, runtimeInstanceId));

/** Age the last observation of a VM, as time passing between reconciliation passes would. */
export const backdateObservation = (db: DB, runtimeInstanceId: string, ms: number) =>
  db
    .update(boatObservations)
    .set({ observedAt: new Date(Date.now() - ms) })
    .where(eq(boatObservations.runtimeInstanceId, runtimeInstanceId));

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
