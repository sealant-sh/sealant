import { isDeepStrictEqual } from "node:util";

import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  type SealantDB,
} from "@sealant/db";
import type { BoatExecutionTarget } from "@sealant/validators";
import { Clock, Context, Effect, Layer, Redacted, Schedule } from "effect";

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
/**
 * How far into the launch budget readiness may still start a poll. A poll waits on the agent for
 * up to its requests' own budgets (health 10 s, network status 10 s, the daemon probe 15 s), so
 * the last one starts that long before the budget ends: its failure, which names the check that
 * has not passed, is what the launch reports, not the budget's bare timeout. A slow VM (Docker
 * slow to start, so sealantd late to boot) gets every second of the budget up to here.
 */
const READINESS_DEADLINE_MS = LAUNCH_BUDGET_MS - 35_000;
const POLL_SPACING_MS = 1_000;
/** Issuing the launch: twenty tries a second apart, each re-checking currency. */
const LAUNCH_RETRIES = {
  times: 20,
  schedule: Schedule.spaced(POLL_SPACING_MS),
  while: boatExecutionRetryable,
};
/**
 * Waiting for readiness: a poll a second while the VM is not ready yet, until the next one would
 * start after `deadline`. Anything `boatExecutionRetryable` rejects (`guest-failed`, `held`) ends
 * the wait at once.
 */
const readinessRetries = (deadline: number) => ({
  schedule: Schedule.spaced(POLL_SPACING_MS).pipe(
    Schedule.while(({ now }) => now + POLL_SPACING_MS <= deadline),
  ),
  while: boatExecutionRetryable,
});

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
    material: Redacted.Redacted<BoatLaunchMaterial>,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + READINESS_DEADLINE_MS;
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
    }).pipe(Effect.retry(LAUNCH_RETRIES));
    return yield* observe(target).pipe(Effect.retry(readinessRetries(deadline)));
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
