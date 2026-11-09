import { eq } from "drizzle-orm";

import type { DB } from "../client.js";
import { boatAllocations } from "../schema/boat-allocations.js";
import { workspaceCaptureDrains } from "../schema/workspace-build-jobs.js";

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
