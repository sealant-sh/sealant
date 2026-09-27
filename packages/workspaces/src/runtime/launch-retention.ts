/**
 * No loss of work product at launch. Once a capture-sourced executor's daemon answers, a writer
 * can run on it (sealantd ADR-0015): a boot service, a dotfiles hook, a client that already
 * holds the endpoint. From that instant, a failure of any remaining launch step (credential file
 * injection, launch-secret cleanup, persisting the runtime row) must NOT remove the executor —
 * its disk may hold the only copy of that work. The launch reports the executor's identity
 * first (`onReady`, so a crash after it leaves a row to recover from), and a later failure
 * throws `LaunchRetainedError` carrying that identity instead of tearing the executor down. The
 * worker records the run `failed` with `LAUNCH_RETAINED_ERROR_CODE`, and the retained-launch
 * sweep drains it (FINAL flush) and only then stops it.
 *
 * Before readiness nothing can have written anything that is not already saved: a failed launch
 * there is cleaned up as before. A launch that is not capture-sourced keeps its cleanup too.
 */
import { LAUNCH_RETAINED_ERROR_CODE } from "@sealant/db";
import type { RuntimeAdapterId } from "@sealant/validators";

import type { RuntimeAdapterBlueprint } from "./runtime-adapter.js";

/** What locates a launched executor: enough to reach its daemon, drain it and stop it. */
export interface RuntimeLaunchIdentity {
  readonly adapter: RuntimeAdapterId;
  readonly resourceId: string;
  readonly reference: string;
  readonly endpoint?: string;
  /** ISO-8601; the runtime's own lifetime deadline, where it has one. */
  readonly deadline?: string;
}

/** Optional callbacks a launch caller hands the adapter. */
export interface RuntimeAdapterLaunchHooks {
  /**
   * The executor's daemon answers: record its identity before anything else happens. Awaited; a
   * failure here is a post-readiness failure like any other (retained when capture-sourced).
   */
  readonly onReady?: (identity: RuntimeLaunchIdentity) => Promise<void>;
}

/** A capture-sourced launch failed after readiness; its executor was kept, not removed. */
export class LaunchRetainedError extends Error {
  public override readonly name = "LaunchRetainedError";
  public readonly code = LAUNCH_RETAINED_ERROR_CODE;

  public constructor(
    public readonly identity: RuntimeLaunchIdentity,
    cause: unknown,
  ) {
    super(
      `The workspace launch failed after its executor became ready, and the executor was kept so no work is lost: ${
        cause instanceof Error ? cause.message : String(cause)
      } It is drained and stopped by the retained-launch sweep.`,
      { cause },
    );
  }
}

/** Whether a launch boots a capture source (its executor's disk holds unsaved work). */
export const launchHoldsCaptures = (blueprint: RuntimeAdapterBlueprint): boolean =>
  blueprint.sources.workspace.kind === "capture";

/**
 * The post-readiness half of a launch: report the identity, run the remaining steps, and on any
 * failure either keep the executor (capture-sourced: throw `LaunchRetainedError`) or run the
 * adapter's cleanup and rethrow (everything else).
 */
export const completeReadyLaunch = async <A>(input: {
  readonly blueprint: RuntimeAdapterBlueprint;
  readonly identity: RuntimeLaunchIdentity;
  readonly hooks: RuntimeAdapterLaunchHooks | undefined;
  readonly steps: () => Promise<A>;
  /** What removes the executor when it is not kept; absent when the caller's own catch does. */
  readonly cleanup?: () => Promise<void>;
}): Promise<A> => {
  try {
    await input.hooks?.onReady?.(input.identity);
    return await input.steps();
  } catch (error) {
    if (launchHoldsCaptures(input.blueprint)) {
      throw new LaunchRetainedError(input.identity, error);
    }
    await input.cleanup?.().catch(() => undefined);
    throw error;
  }
};
