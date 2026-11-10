import { isDeepStrictEqual } from "node:util";

import { BoatAllocationRepo, BoatAllocationRepoLive, type SealantDB } from "@sealant/db";
import type { BoatExecutionTarget } from "@sealant/validators";
import { Context, Effect, Layer, Redacted, Schedule } from "effect";

import {
  BoatExecution,
  boatExecutionRetryable,
  type BoatLaunchMaterial,
  type BoatReadyReceipt,
} from "../runtime/boat/execution.js";
import {
  boatLaunchDiagnostic,
  boatLaunchSummary,
  type BoatLaunchDiagnostic,
} from "../runtime/boat/launch-diagnostics.js";
import { boatTargetIsCurrent } from "./boat-current.js";
import { BoatResources } from "./boat-resources.js";

/** Refusal leaves the original launch and reservations in custody. No output or secrets escape. */
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
  /** Seals the launch once, prepares the tunnel, pushes the launch to the agent and observes health. */
  readonly launch: (
    target: BoatExecutionTarget,
    material: Redacted.Redacted<BoatLaunchMaterial>,
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

/** The launch budget: the VM must boot sealantd and shake hands with the gateway within it. */
const LAUNCH_BUDGET_MS = 120_000;
const RETRIES = { times: 20, schedule: Schedule.spaced("1 second"), while: boatExecutionRetryable };

const make: Effect.Effect<
  BoatReadinessService,
  never,
  BoatAllocationRepo | BoatExecution | BoatResources
> = Effect.gen(function* () {
  const execution = yield* BoatExecution;
  const resources = yield* BoatResources;
  const allocationRepo = yield* BoatAllocationRepo;
  const isCurrent = (target: BoatExecutionTarget) =>
    boatTargetIsCurrent(target).pipe(Effect.provideService(BoatAllocationRepo, allocationRepo));
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
    material: Redacted.Redacted<BoatLaunchMaterial>,
  ) {
    yield* current(target);
    yield* execution.stage(target.runtimeInstanceId, material);
    yield* current(target);
    const prepared = yield* resources.prepare(target);
    yield* current(target);
    yield* execution.recordIsolation(target, {
      resourceReceipt: prepared.guest.receipt,
      tunnelReceipt: prepared.gateway.receipt,
    });
    yield* current(target);
    // Launch owns durable issuance and exact adoption. Readiness retries never push another launch.
    yield* Effect.gen(function* () {
      yield* current(target);
      return yield* execution.launch(target.runtimeInstanceId);
    }).pipe(Effect.retry(RETRIES));
    return yield* observe(target).pipe(Effect.retry(RETRIES));
  });
  const boundary = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, BoatReadinessError> =>
    effect.pipe(
      Effect.timeout(LAUNCH_BUDGET_MS),
      Effect.mapError((error) =>
        error instanceof BoatReadinessError
          ? error
          : new BoatReadinessError("unavailable", boatLaunchDiagnostic(error, "readiness")),
      ),
    );
  return BoatReadiness.of({
    launch: (target, material) => boundary(launch(target, material)),
    observe: (target) => boundary(observe(target)),
  });
});
/** Open assembly for real stores and faithful boundary controls. */
export const boatReadinessLayerNoDeps: Layer.Layer<
  BoatReadiness,
  never,
  BoatAllocationRepo | BoatExecution | BoatResources
> = Layer.effect(BoatReadiness, make);
/** Owns allocation reads; the worker shares its existing execution and resource owners. */
export const boatReadinessLayer: Layer.Layer<
  BoatReadiness,
  never,
  SealantDB | BoatExecution | BoatResources
> = boatReadinessLayerNoDeps.pipe(Layer.provide(BoatAllocationRepoLive));
