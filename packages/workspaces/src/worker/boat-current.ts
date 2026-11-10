import { isDeepStrictEqual } from "node:util";

import { BoatAllocationRepo } from "@sealant/db";
import type { BoatExecutionTarget } from "@sealant/validators";
import { Effect } from "effect";

/** A target is current while its allocation is bound to exactly it and its run is still active. */
export const boatTargetIsCurrent = (target: BoatExecutionTarget) =>
  Effect.gen(function* () {
    const allocations = yield* BoatAllocationRepo;
    const allocation = yield* allocations.get(target.runtimeInstanceId);
    return (
      allocation?.phase === "bound" &&
      isDeepStrictEqual(allocation.target, target) &&
      (yield* allocations.isActive(target.runId))
    );
  });
