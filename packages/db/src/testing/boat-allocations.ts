import { eq } from "drizzle-orm";

import type { DB } from "../client.js";
import { boatAllocations } from "../schema/boat-allocations.js";

/** Inject a malformed record only in an owned disposable database, preserving its indexed identity. */
export const corruptBoatAllocation = (db: DB, id: string, record: unknown) =>
  db.update(boatAllocations).set({ record }).where(eq(boatAllocations.runtimeInstanceId, id));
