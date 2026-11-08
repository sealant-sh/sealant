import { isDeepStrictEqual } from "node:util";

import { BoatAllocationRepo, WorkspaceCaptureDrainRepo } from "@sealant/db";
import type { BoatExecutionTarget } from "@sealant/validators";
import { Effect } from "effect";

/** Resolves custody before any resource or launch consumer can use a historical source target. */
export const boatTargetIsCurrent = (target: BoatExecutionTarget, allowRecovery = false) =>
  Effect.gen(function* () {
    const canonical = yield* WorkspaceCaptureDrainRepo;
    const root = yield* canonical.getByRunId(target.runId);
    if (root?.custodyContract === 3) {
      const custody = yield* canonical.preservation;
      return isDeepStrictEqual(
        yield* custody.resolveExecution(target.runId, allowRecovery),
        target,
      );
    }
    const allocations = yield* BoatAllocationRepo;
    const allocation = yield* allocations.get(target.runtimeInstanceId);
    return (
      allocation?.phase === "bound" &&
      isDeepStrictEqual(allocation.target, target) &&
      (yield* allocations.isActive(target.runId))
    );
  });
