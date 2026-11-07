import { eq } from "drizzle-orm";

import type { DB } from "../client.js";
import { boatExecutions } from "../schema/boat-executions.js";
import { boatTunnels } from "../schema/boat-tunnels.js";

/** Inject only disposable tunnel records to exercise authentication and parser refusals. */
export const corruptBoatTunnel = (db: DB, id: string, record: unknown) =>
  db.update(boatTunnels).set({ record }).where(eq(boatTunnels.runtimeInstanceId, id));

/** Test that generic execution deletion cannot erase an outstanding tunnel obligation. */
export const deleteBoatExecutionWithTunnel = (db: DB, id: string) =>
  db.delete(boatExecutions).where(eq(boatExecutions.runtimeInstanceId, id));
