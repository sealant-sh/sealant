import { isDeepStrictEqual } from "node:util";

import { BoatRunRepo } from "@sealant/db";
import type { BoatExecutionTarget } from "@sealant/validators";
import { Effect } from "effect";

/**
 * A target is current while its run's row is bound to exactly it, nothing has claimed or recorded
 * the VM's deletion, and its run is still active.
 */
export const boatTargetIsCurrent = (target: BoatExecutionTarget) =>
  Effect.gen(function* () {
    const runs = yield* BoatRunRepo;
    const run = yield* runs.get(target.runId);
    return (
      run !== undefined &&
      isDeepStrictEqual(run.target, target) &&
      run.deletionClaimedAt === null &&
      run.deletionOperationId === null &&
      (yield* runs.isActive(target.runId))
    );
  });
