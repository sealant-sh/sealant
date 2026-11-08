import {
  WorkspaceCaptureDrainRepo,
  LAUNCH_RETAINED_ERROR_CODE,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Effect, Option } from "effect";

/** Historical runtime rows stay immutable; interactive consumers resolve the canonical child. */
export const currentWorkspaceRuntime = (instance: WorkspaceRuntimeInstance | undefined) =>
  Effect.gen(function* () {
    if (instance?.adapter !== "boat") return instance;
    const selected = yield* Effect.serviceOption(WorkspaceCaptureDrainRepo);
    if (Option.isNone(selected))
      return yield* Effect.fail(new Error("Boat current custody is unavailable"));
    const canonical = selected.value;
    const root = yield* canonical.getByRunId(instance.runId);
    if (root?.custodyContract !== 3)
      return root?.retainedAt == null
        ? instance
        : { ...instance, status: "failed" as const, errorCode: LAUNCH_RETAINED_ERROR_CODE };
    const custody = yield* canonical.preservation;
    const facts = yield* custody.read(instance.runId);
    const target = yield* custody.resolveExecution(instance.runId);
    const status: WorkspaceRuntimeInstance["status"] =
      facts?.state === "active" ? "ready" : facts?.state === "closed" ? "stopped" : "failed";
    return {
      ...instance,
      status,
      adapter: "boat" as const,
      resourceId: target?.sandboxId ?? null,
      reference: target?.sandboxId ?? null,
      endpoint: null,
      errorCode: status === "failed" ? LAUNCH_RETAINED_ERROR_CODE : null,
      errorMessage: null,
      stopReason: null,
    };
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
