import type { CredentialCipher } from "@sealant/credentials";
import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type SealantDB,
} from "@sealant/db";
import type { BoatExecutionTarget } from "@sealant/validators";
import { Context, Effect, Layer, Redacted } from "effect";

import type { WebSocketConnectMaterial } from "../../sealantd/runtime.js";
import type { SealantTargetDerivationOptions } from "../../sealantd/target.js";
import { boatSealedExecutionLayer } from "../../worker/boat-allocation.js";
import { boatTargetIsCurrent } from "../../worker/boat-current.js";
import { BoatExecution, BoatExecutionError } from "./execution.js";
import { BoatAllocationProvider } from "./provider.js";

/**
 * Why a Boat run's control connection was not opened. `refused`: the run is not this deployment's
 * Boat run on that sandbox (for `connectMaterial`, its current one: ready and not stopping), or
 * Boat reports a VM that is not the one Core launched.
 * `unavailable`: the database, the sealed record or Boat's API failed. The message never carries
 * the provider key, the run's bearer or the hosted cookie.
 */
export class BoatControlError extends Error {
  readonly _tag = "BoatControlError";
  constructor(readonly reason: "refused" | "unavailable") {
    super(`Boat interactive control ${reason}`);
  }
}

/**
 * Fresh connect material for one control connection to a running Boat run: the run's control URL,
 * its bearer and the hosted-proxy headers, with a hosted cookie Boat issued for this connection.
 */
export class BoatControlMaterial extends Context.Service<
  BoatControlMaterial,
  {
    readonly connectMaterial: (
      runId: string,
      sandboxId: string,
    ) => Effect.Effect<WebSocketConnectMaterial, BoatControlError>;
    /**
     * The same material for the worker's drains, which must reach a daemon whose run is stopping
     * or never became ready: its FINAL flush is what they are there to ask for. It requires only
     * this deployment's run, on this sandbox, with the bearer its launch sealed, and Boat's own
     * labels on the VM. It opens nothing for another deployment's run or another sandbox. Never
     * for a caller that acts for a user: exec jobs and the API use `connectMaterial`.
     */
    readonly drainMaterial: (
      runId: string,
      sandboxId: string,
    ) => Effect.Effect<WebSocketConnectMaterial, BoatControlError>;
  }
>()("@sealant/workspaces/boat/BoatControlMaterial") {}

const refused = () => new BoatControlError("refused");
const unavailable = () => new BoatControlError("unavailable");
/** Execution failures that mean "not this run" refuse; every other failure is unavailability. */
const executionFailure = (error: unknown) =>
  error instanceof BoatExecutionError &&
  (error.code === "target-mismatch" || error.code === "invocation-held")
    ? refused()
    : unavailable();

type Dependencies =
  | BoatAllocationRepo
  | WorkspaceRuntimeInstanceRepo
  | BoatExecution
  | BoatAllocationProvider;
const make: Effect.Effect<BoatControlMaterial["Service"], never, Dependencies> = Effect.gen(
  function* () {
    const allocations = yield* BoatAllocationRepo;
    const instances = yield* WorkspaceRuntimeInstanceRepo;
    const execution = yield* BoatExecution;
    const { deploymentId } = yield* BoatAllocationProvider;
    /** The run is ready, not being stopped, on this sandbox, and its allocation is bound to it. */
    const current = (target: BoatExecutionTarget) =>
      Effect.gen(function* () {
        const instance = yield* instances.getRuntimeInstanceByRunId(target.runId);
        const ready =
          instance?.adapter === "boat" &&
          instance.status === "ready" &&
          instance.stopReason === null &&
          instance.resourceId === target.sandboxId &&
          (yield* boatTargetIsCurrent(target).pipe(
            Effect.provideService(BoatAllocationRepo, allocations),
          ));
        if (!ready) return yield* Effect.fail(refused());
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(error instanceof BoatControlError ? error : unavailable()),
        ),
      );
    /** This deployment's run on this sandbox, as its allocation bound it. */
    const owned = (runId: string, sandboxId: string) =>
      Effect.gen(function* () {
        const allocation = yield* allocations.get(runId).pipe(Effect.mapError(() => unavailable()));
        const target = allocation?.target;
        if (
          target == null ||
          target.runId !== runId ||
          target.sandboxId !== sandboxId ||
          target.deploymentId !== deploymentId
        )
          return yield* Effect.fail(refused());
        return target;
      });
    /** Unseals the run's bearer, checks Boat's labels on the VM and asks Boat for a hosted cookie. */
    const open = (target: BoatExecutionTarget) =>
      Effect.gen(function* () {
        const control = Redacted.value(
          yield* execution.control(target).pipe(Effect.mapError(executionFailure)),
        );
        if (
          control.kind !== "websocket" ||
          control.auth === undefined ||
          control.prepare === undefined
        )
          return yield* Effect.fail(unavailable());
        const prepared = yield* Effect.tryPromise({ try: control.prepare, catch: unavailable });
        return { url: control.url, auth: control.auth, headers: prepared.headers ?? {} };
      });
    const connectMaterial = Effect.fn("BoatControlMaterial.connectMaterial")(function* (
      runId: string,
      sandboxId: string,
    ) {
      const target = yield* owned(runId, sandboxId);
      yield* current(target);
      const material = yield* open(target);
      // A Stop that won while Boat answered keeps this connection closed.
      yield* current(target);
      return material;
    });
    const drainMaterial = Effect.fn("BoatControlMaterial.drainMaterial")(function* (
      runId: string,
      sandboxId: string,
    ) {
      return yield* open(yield* owned(runId, sandboxId));
    });
    return BoatControlMaterial.of({ connectMaterial, drainMaterial });
  },
);

/** Open assembly for tests that bring their own execution owner and repositories. */
export const boatControlMaterialLayerNoDeps: Layer.Layer<BoatControlMaterial, never, Dependencies> =
  Layer.effect(BoatControlMaterial, make);

/**
 * The API's and the worker's assembly: the sealed execution owner over Boat's real API, with the
 * repositories it reads. The process root supplies the database, the cipher and the provider.
 */
export const boatControlMaterialLayer: Layer.Layer<
  BoatControlMaterial,
  never,
  SealantDB | CredentialCipher | BoatAllocationProvider
> = boatControlMaterialLayerNoDeps.pipe(
  Layer.provide(
    Layer.mergeAll(
      boatSealedExecutionLayer,
      BoatAllocationRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
    ),
  ),
);

/** The target-derivation hook, one fresh connect material per WebSocket upgrade. */
export const boatConnectMaterial =
  (
    service: BoatControlMaterial["Service"],
  ): NonNullable<SealantTargetDerivationOptions["boatConnectMaterial"]> =>
  (runId, sandboxId) =>
    Effect.runPromise(service.connectMaterial(runId, sandboxId));

/**
 * The same hook for the worker's own drains (the stop consumer, the reapers, the recovery sweep
 * and the exit reconciler): it opens for a run that is stopping or never became ready.
 */
export const boatDrainConnectMaterial =
  (
    service: BoatControlMaterial["Service"],
  ): NonNullable<SealantTargetDerivationOptions["boatConnectMaterial"]> =>
  (runId, sandboxId) =>
    Effect.runPromise(service.drainMaterial(runId, sandboxId));
