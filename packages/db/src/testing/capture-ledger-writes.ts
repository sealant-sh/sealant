/**
 * TEST FIXTURE — raw writes to `workspace_capture_drains` marked as the CURRENT ledger contract
 * (`CAPTURE_LEDGER_CONTRACT`), so tests can check what the table's trigger enforces for every
 * writer, the current one included (review 12 #3, rule (G)). Not used by any production path.
 */
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { DB } from "../client.js";
import { markCurrentWriter } from "../repositories/workspace-capture-drains.js";
import { workspaceCaptureDrains, type WorkspaceCaptureDeletionRequest } from "../schema.js";

/** Give the run's removal up with `requests` on the row, as a current writer, bypassing the repo. */
export const releaseRemovalAsCurrentWriter = (
  db: DB,
  runId: string,
  requests: readonly WorkspaceCaptureDeletionRequest[],
) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      yield* tx
        .update(workspaceCaptureDrains)
        .set({ deletionState: null, deletionToken: null, deletionRequests: [...requests] })
        .where(eq(workspaceCaptureDrains.runId, runId));
    }),
  );
