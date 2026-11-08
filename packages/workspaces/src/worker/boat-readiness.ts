import { isDeepStrictEqual } from "node:util";

import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  type SealantDB,
} from "@sealant/db";
import type { BoatExecutionTarget } from "@sealant/validators";
import { Context, Effect, Layer, Schedule } from "effect";

import {
  BoatExecution,
  BoatExecutionError,
  type BoatReadyReceipt,
} from "../runtime/boat/execution.js";
import {
  boatLaunchDiagnostic,
  boatLaunchSummary,
  type BoatLaunchDiagnostic,
} from "../runtime/boat/launch-diagnostics.js";
import { boatTargetIsCurrent } from "./boat-current.js";
import { BoatResources } from "./boat-resources.js";

/** Refusal leaves the original invocation and reservations in custody. No output or secrets escape. */
export class BoatReadinessError extends Error {
  readonly _tag = "BoatReadinessError";
  constructor(
    readonly code: "held" | "unavailable",
    readonly diagnostic?: BoatLaunchDiagnostic,
  ) {
    super(`Boat readiness: ${code}${boatLaunchSummary(diagnostic)}`);
  }
}
/** Explicit launch and fresh observation. Neither method publishes readiness or enables runtime registration. */
export interface BoatReadinessService {
  /** Stages once, proves isolation, starts the original invocation and observes authenticated health. */
  readonly launch: (
    target: BoatExecutionTarget,
    payload: Parameters<BoatExecution["Service"]["stage"]>[1],
  ) => Effect.Effect<BoatReadyReceipt, BoatReadinessError>;
  /** Read-only with respect to execution. A previous successful observation never authorizes a new one. */
  readonly observe: (
    target: BoatExecutionTarget,
  ) => Effect.Effect<BoatReadyReceipt, BoatReadinessError>;
}
/** Coordinates current allocation authority, resource custody and authenticated guest readiness. */
export class BoatReadiness extends Context.Service<BoatReadiness, BoatReadinessService>()(
  "@sealant/workspaces/boat/BoatReadiness",
) {}

const make: Effect.Effect<
  BoatReadinessService,
  never,
  BoatAllocationRepo | WorkspaceCaptureDrainRepo | BoatExecution | BoatResources
> = Effect.gen(function* () {
  const execution = yield* BoatExecution;
  const resources = yield* BoatResources;
  const canonical = yield* WorkspaceCaptureDrainRepo;
  const allocationRepo = yield* BoatAllocationRepo;
  const isCurrent = (target: BoatExecutionTarget) =>
    boatTargetIsCurrent(target, true).pipe(
      Effect.provideService(WorkspaceCaptureDrainRepo, canonical),
      Effect.provideService(BoatAllocationRepo, allocationRepo),
    );
  const current = (target: BoatExecutionTarget) =>
    Effect.gen(function* () {
      if (!(yield* isCurrent(target))) return yield* Effect.fail(new BoatReadinessError("held"));
    });
  const observe = Effect.fn("BoatReadiness.observe")(function* (target: BoatExecutionTarget) {
    yield* current(target);
    const prepared = yield* resources.prepare(target);
    yield* current(target);
    const receipt = yield* execution.readiness(target);
    yield* current(target);
    const after = yield* resources.prepare(target);
    if (!isDeepStrictEqual(prepared, after))
      return yield* Effect.fail(new BoatReadinessError("held"));
    yield* current(target);
    return receipt;
  });
  const launch = Effect.fn("BoatReadiness.launch")(function* (
    target: BoatExecutionTarget,
    payload: Parameters<BoatReadinessService["launch"]>[1],
  ) {
    yield* current(target);
    yield* execution.stage(target.runtimeInstanceId, payload);
    yield* current(target);
    const prepared = yield* resources.prepare(target);
    yield* current(target);
    yield* execution.permit(target, {
      resourceReceipt: prepared.guest.receipt,
      tunnelReceipt: prepared.gateway.receipt,
    });
    yield* current(target);
    // Start owns durable issuance and exact adoption. Readiness retries never issue another invocation.
    yield* Effect.gen(function* () {
      yield* current(target);
      return yield* execution.start(target.runtimeInstanceId);
    }).pipe(
      Effect.retry({
        times: 20,
        schedule: Schedule.spaced("1 second"),
        while: (error) =>
          error instanceof BoatExecutionError && error.code === "transport-unavailable",
      }),
    );
    return yield* observe(target).pipe(
      Effect.retry({
        times: 20,
        schedule: Schedule.spaced("1 second"),
        while: (error) =>
          error instanceof BoatExecutionError && error.code === "transport-unavailable",
      }),
    );
  });
  const boundary = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, BoatReadinessError> =>
    effect.pipe(
      Effect.timeout(120_000),
      Effect.mapError((error) =>
        error instanceof BoatReadinessError
          ? error
          : new BoatReadinessError("unavailable", boatLaunchDiagnostic(error, "readiness")),
      ),
    );
  return BoatReadiness.of({
    launch: (target, payload) => boundary(launch(target, payload)),
    observe: (target) => boundary(observe(target)),
  });
});
/** Open assembly for real stores and faithful boundary controls. */
export const boatReadinessLayerNoDeps: Layer.Layer<
  BoatReadiness,
  never,
  BoatAllocationRepo | WorkspaceCaptureDrainRepo | BoatExecution | BoatResources
> = Layer.effect(BoatReadiness, make);
/** Owns allocation reads; the worker shares its existing execution and resource owners. */
export const boatReadinessLayer: Layer.Layer<
  BoatReadiness,
  never,
  SealantDB | BoatExecution | BoatResources
> = boatReadinessLayerNoDeps.pipe(
  Layer.provide(Layer.merge(BoatAllocationRepoLive, WorkspaceCaptureDrainRepoLive)),
);
