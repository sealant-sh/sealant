import { eq } from "drizzle-orm";

import type { DB } from "../client.js";
import { boatAllocations } from "../schema/boat-allocations.js";
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
