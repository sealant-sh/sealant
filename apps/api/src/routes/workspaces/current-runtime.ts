import {
  WorkspaceCaptureDrainRepo,
  LAUNCH_RETAINED_ERROR_CODE,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Effect, Option } from "effect";

/**
 * A Boat VM kept because its capture is not confirmed saved reads as a retained launch for as long
 * as the VM exists, whatever its runtime row says. Every other runtime's row is already current.
 */
export const currentWorkspaceRuntime = (instance: WorkspaceRuntimeInstance | undefined) =>
  Effect.gen(function* () {
    if (instance?.adapter !== "boat") return instance;
    const selected = yield* Effect.serviceOption(WorkspaceCaptureDrainRepo);
    if (Option.isNone(selected))
      return yield* Effect.fail(new Error("The Boat capture ledger is unavailable"));
    const root = yield* selected.value.getByRunId(instance.runId);
    return root?.retainedAt == null || instance.removedAt !== null
      ? instance
      : { ...instance, status: "failed" as const, errorCode: LAUNCH_RETAINED_ERROR_CODE };
  });

export const currentWorkspaceRuntimes = (
  instances: ReadonlyMap<string, WorkspaceRuntimeInstance>,
) =>
  Effect.forEach([...instances], ([runId, instance]) =>
    currentWorkspaceRuntime(instance).pipe(
      Effect.map((current): readonly [string, WorkspaceRuntimeInstance | undefined] => [
        runId,
        current,
      ]),
    ),
  ).pipe(
    Effect.map(
      (pairs) =>
        new Map(
          pairs.flatMap(([runId, instance]) =>
            instance === undefined ? [] : [[runId, instance] as const],
          ),
        ),
    ),
  );
