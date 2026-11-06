import { eq } from "drizzle-orm";

import type { DB } from "../client.js";
import { boatExecutions } from "../schema/boat-executions.js";

/** Corrupt only a disposable execution row to prove the read/decryption boundary refuses it. */
export const corruptBoatExecution = (db: DB, id: string, record: unknown) =>
  db.update(boatExecutions).set({ record }).where(eq(boatExecutions.runtimeInstanceId, id));
