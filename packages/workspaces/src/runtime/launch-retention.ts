/**
 * No loss of work product at launch. A capture-sourced executor can hold unsaved work from the
 * moment it starts: sealantd boots, restores, runs dotfiles and lifecycle steps and admits
 * writers whether or not the launching worker's readiness probe ever gets through (a control
 * network partition, a TLS or socket-mount fault). So retention starts at creation, not at
 * readiness: once the executor exists, a failure of ANY later launch step — the readiness wait,
 * credential file injection, launch-secret cleanup, persisting the runtime row — must NOT remove
 * it. The adapter reports the executor's identity as soon as it exists (`onStarted`), again once
 * its daemon answers (`onReady`), and a failure after creation throws `LaunchRetainedError`
 * carrying that identity instead of tearing the executor down. The worker records the run
 * `failed` with `LAUNCH_RETAINED_ERROR_CODE`, and the retained-launch sweep drains it (FINAL
 * flush) and only then stops it — or keeps it, for as long as nothing proves its work saved.
 *
 * The same holds for a redelivered launch that finds an ENDED executor of the same run (a stopped
 * container, a Failed Pod): its disk may hold the newest work, so it is retained rather than
 * replaced. Only a launch that is not capture-sourced keeps its cleanup, and only before the
 * executor exists is a capture launch cleaned up (the adapters decide through
 * `decideExecutorDeletion`, the one preservation policy).
 */
import { LAUNCH_RETAINED_ERROR_CODE } from "@sealant/db";
import type { RuntimeAdapterId } from "@sealant/validators";

import { decideExecutorDeletion, type ExecutorRuntimeState } from "./executor-preservation.js";
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
   * The executor exists (created and started; its daemon may not answer yet): record its
   * identity at once, so a worker that dies before readiness leaves a row to find it by. Awaited;
   * a failure here is a post-start failure like any other (retained when capture-sourced).
   */
  readonly onStarted?: (identity: RuntimeLaunchIdentity) => Promise<void>;
  /**
   * The executor's daemon answers: record its identity before anything else happens. Awaited; a
   * failure here is a post-start failure like any other (retained when capture-sourced).
   */
  readonly onReady?: (identity: RuntimeLaunchIdentity) => Promise<void>;
}

/** A capture-sourced launch failed after its executor existed; the executor was kept. */
export class LaunchRetainedError extends Error {
  public override readonly name = "LaunchRetainedError";
  public readonly code = LAUNCH_RETAINED_ERROR_CODE;

  public constructor(
    public readonly identity: RuntimeLaunchIdentity,
    cause: unknown,
  ) {
    super(
      `The workspace launch failed after its executor started, and the executor was kept so no work is lost: ${
        cause instanceof Error ? cause.message : String(cause)
      } It is drained and stopped by the retained-launch sweep once its work is confirmed saved.`,
      { cause },
    );
  }
}

/** Whether a launch boots a capture source (its executor's disk holds unsaved work). */
export const launchHoldsCaptures = (blueprint: RuntimeAdapterBlueprint): boolean =>
  blueprint.sources.workspace.kind === "capture";

/**
 * A launch step failed. With no executor yet (`identity` undefined) the adapter's cleanup runs
 * and the error is rethrown. With one, the preservation policy decides: a capture-sourced
 * executor is retained (`LaunchRetainedError`, its cleanup NOT run); anything else is cleaned up
 * and the error rethrown. An error that already is a `LaunchRetainedError` passes through.
 */
export const failLaunch = async (input: {
  readonly blueprint: RuntimeAdapterBlueprint;
  readonly identity: RuntimeLaunchIdentity | undefined;
  /** What the launch knows of the executor it created or found. */
  readonly runtime: ExecutorRuntimeState;
  readonly error: unknown;
  readonly cleanup?: () => Promise<void>;
}): Promise<never> => {
  if (input.error instanceof LaunchRetainedError) {
    throw input.error;
  }
  if (input.identity !== undefined) {
    const decision = decideExecutorDeletion({
      captureSourced: launchHoldsCaptures(input.blueprint),
      runtime: input.runtime,
    });
    if (!decision.delete) {
      throw new LaunchRetainedError(input.identity, input.error);
    }
  }
  await input.cleanup?.().catch(() => undefined);
  throw input.error;
};

/** Report a created executor (`onStarted`); its failure is a post-start launch failure. */
export const reportStartedLaunch = async (
  hooks: RuntimeAdapterLaunchHooks | undefined,
  identity: RuntimeLaunchIdentity,
): Promise<void> => {
  await hooks?.onStarted?.(identity);
};

/**
 * The post-readiness half of a launch: report the identity, run the remaining steps, and on any
 * failure let the preservation policy decide (`failLaunch`): keep the executor (capture-sourced:
 * `LaunchRetainedError`) or run the adapter's cleanup and rethrow (everything else).
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
    return failLaunch({
      blueprint: input.blueprint,
      identity: input.identity,
      runtime: "running",
      error,
      ...(input.cleanup === undefined ? {} : { cleanup: input.cleanup }),
    });
  }
};
