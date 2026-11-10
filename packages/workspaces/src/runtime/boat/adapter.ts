import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BoatRunRepo, WorkspaceCaptureDrainRepo, WorkspaceRuntimeInstanceRepo } from "@sealant/db";
import {
  boatSupport,
  nativeArtifactConsumerSchema,
  nativeImageScopeSchema,
  type NativePublication,
} from "@sealant/validators";
import { Effect, Option, Redacted, Result, type ManagedRuntime } from "effect";
import { z } from "zod";

import { nativeWorkspaceInstallation } from "../../buildkit/buildkit-builder.js";
import { safeCommandTail } from "../../images/boat/command-diagnostics.js";
import { SealantControlError } from "../../sealantd/runtime.js";
import { BoatReadiness } from "../../worker/boat-readiness.js";
import { liveControlChannel, type ControlChannel } from "../kubernetes/adapter.js";
import {
  completeReadyLaunch,
  failLaunch,
  type RuntimeAdapterLaunchHooks,
  type RuntimeLaunchIdentity,
} from "../launch-retention.js";
import { SECRET_ENV_FILE_PATH } from "../microvm/agent-contract.js";
import { bindsEnv } from "../mount-intent.js";
import { nativeBootEnv } from "../native-boot-env.js";
import {
  boatLaunchInputSchema,
  nothingToSaveDetail,
  removalPending,
  removalRefused,
  type RuntimeAdapter,
  type RuntimeAdapterInspectInput,
  type RuntimeAdapterInspectResult,
  type RuntimeAdapterRecoverInput,
  type RuntimeAdapterRecoverResult,
  type RuntimeLaunch,
  type RuntimeAdapterStopInput,
} from "../runtime-adapter.js";
import { BOAT_AGENT_CLOSE_UNVERIFIED } from "./agent-contract.js";
import { BoatExecution, BoatExecutionError } from "./execution.js";
import {
  boatLaunchDiagnostic,
  boatLaunchSummary,
  type BoatLaunchDiagnostic,
} from "./launch-diagnostics.js";
import { BoatRemoval, BoatRemovalError } from "./removal.js";
import { BoatVm } from "./vm.js";

/**
 * The daemon's own refusal behind a launch failure. A step after ready fails as a
 * `LaunchRetainedError` whose cause is the refusal, so the error itself is not the one to test.
 */
export const sealantRefusalBehind = (error: unknown): SealantControlError | undefined => {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (current instanceof SealantControlError) return current;
    if (!(current instanceof Error)) return undefined;
    current = current.cause;
  }
  return undefined;
};

/** What a Boat workspace that may be linked to resources is told on a deployment with no gateway. */
export const BOAT_GATEWAY_UNAVAILABLE_MESSAGE =
  'This deployment has no resource gateway for Boat: it launches only workspaces created with runtime.resources "none" (SDK `resources: "none"`), which are never linked to project resources. Create the workspace with that option, or configure SEALANT_BOAT_GATEWAY_HOST_ID, SEALANT_BOAT_GATEWAY_RELAY_HOST and SEALANT_BOAT_GATEWAY_IMAGE on the worker.';

/**
 * Public failures never carry guest responses, credentials or sealed launch material.
 * `close-pending`: Boat's deletion of the VM is not known to have completed (it is still in
 * progress, or its outcome is unknown). `close-held`: the VM is not `stop`'s to remove as it
 * stands (its run is not stopping, or its caller holds nothing that authorizes deleting it).
 * `close-unavailable`: Boat or the database could not be read before anything was asked of Boat.
 * Boat was sent nothing in either.
 */
export class BoatAdapterError extends Error {
  readonly _tag = "BoatAdapterError";
  constructor(
    readonly code:
      | "admission-refused"
      | "launch-held"
      | "close-pending"
      | "close-held"
      | "close-unavailable"
      | "target-mismatch",
    readonly diagnostic?: BoatLaunchDiagnostic,
  ) {
    super(`Boat runtime: ${code}${boatLaunchSummary(diagnostic)}`);
  }
}

export type BoatAdapterServices =
  | BoatVm
  | BoatReadiness
  | BoatExecution
  | BoatRemoval
  | BoatRunRepo
  | WorkspaceCaptureDrainRepo
  | WorkspaceRuntimeInstanceRepo;

/**
 * How often `inspect` reads Boat and the agent for one VM whose run is live. In between it
 * answers `running` without a read.
 */
export const BOAT_INSPECT_READ_MS = 60_000;
/**
 * The same for a VM whose run is stopping or failed: read more often, so a stop learns soon that
 * its daemon ended or its VM is gone, and still paced, so a VM kept after a FINAL that cannot be
 * confirmed costs four reads a minute for as long as it is kept, not one every poll.
 */
export const BOAT_INSPECT_STOPPING_READ_MS = 15_000;
/**
 * The bound on one `stop`: the removal's own waits (15 s for a gateway host lock, 20 s for Boat's
 * deletion operation) and the Boat requests between them. Past it the call ends as an outcome
 * nobody knows, never as a refusal, so one stalled Boat request cannot hold a sequential sweep.
 */
export const BOAT_STOP_BOUND_MS = 45_000;
/**
 * How long this adapter's own `recover` answer that a VM holds nothing to save lets its `stop`
 * delete that VM: longer than one recovery attempt takes to go from the answer to the removal.
 */
const BOAT_NOTHING_TO_SAVE_MS = 10 * 60_000;
/** The bound on one inspection's reads; past it the answer is `running`. */
const BOAT_INSPECT_BOUND_MS = 20_000;
/** Past this many remembered VMs, the ones last read more than a period ago are forgotten. */
const BOAT_INSPECT_REMEMBERED = 1_024;

const unsupported = (detail: string) => ({ outcome: "unsupported", detail }) as const;
const nothingToSave = (detail: string) => ({ outcome: "nothing-to-save", detail }) as const;

/** Ordinary capture workspaces use the same durable owners as reconciliation. */
export class BoatRuntimeAdapter implements RuntimeAdapter<NativePublication> {
  readonly id = "boat" as const;
  /** Boat's launch and link paths read the stop request as their fence: recorded before the drain. */
  readonly stopRequestBeforeDrain = true;
  /** A VM Boat no longer has, with nothing on record that its work was saved, is reported lost. */
  readonly reportsMissingAsLost = true;
  /** `recover` answers for a VM no launch was pushed to, and refuses a restart itself. */
  readonly recoverAnswersUnstarted = true;
  constructor(
    private readonly options: {
      readonly deploymentId: string;
      readonly runtime: ManagedRuntime.ManagedRuntime<BoatAdapterServices, never>;
      readonly control?: ControlChannel;
      /**
       * Whether this deployment has a resource gateway (default: it has). Without one, only a
       * workspace created never to be linked to resources (`runtime.resources: "none"`) launches;
       * any other is refused before its image is built or a VM is created.
       */
      readonly resourceGateway?: boolean;
      /** The clock `inspect` paces its reads by. Default: the wall clock. */
      readonly now?: () => number;
      /** The bound on one inspection's reads. Default 20 s. */
      readonly inspectBoundMs?: number;
      /** The bound on one `stop`. Default `BOAT_STOP_BOUND_MS`. */
      readonly stopBoundMs?: number;
    },
  ) {}

  /** When `inspect` last read Boat for a VM and answered `running`, by VM id. This process only. */
  readonly #inspected = new Map<string, number>();
  /** When `recover` last answered that a VM holds nothing to save, by VM id. This process only. */
  readonly #nothingToSave = new Map<string, number>();

  supports(input: Parameters<RuntimeAdapter<NativePublication>["supports"]>[0]) {
    const support = boatSupport(input.blueprint);
    if (!support.supported) return support;
    if (
      input.blueprint.sources.workspace.kind !== "capture" ||
      input.blueprint.runtime.dotfilesArchives.length > 0
    )
      return {
        supported: false as const,
        reason: "runtime-requirement-unsupported" as const,
        message: "Boat currently requires a capture source without inline dotfiles archives.",
      };
    if (this.options.resourceGateway === false && input.blueprint.runtime.resources !== "none")
      return {
        supported: false as const,
        reason: "gateway-unavailable" as const,
        message: BOAT_GATEWAY_UNAVAILABLE_MESSAGE,
      };
    return { supported: true as const };
  }

  async launch(raw: RuntimeLaunch<NativePublication>, hooks?: RuntimeAdapterLaunchHooks) {
    let identity: RuntimeLaunchIdentity | undefined;
    let step: BoatLaunchDiagnostic["step"] = "prepare-launch";
    try {
      const input = boatLaunchInputSchema.parse(raw);
      const { runId, workspaceId, principalId } = input;
      const support = this.supports(input);
      // Refused before allocation: no VM exists, and nothing is asked of a gateway host.
      if (!support.supported && support.reason === "gateway-unavailable")
        throw new BoatAdapterError("admission-refused", {
          step: "prepare-launch",
          errorClass: "BoatAdapterError",
          code: "gateway-unavailable",
        });
      if (
        runId === undefined ||
        workspaceId === undefined ||
        principalId === undefined ||
        !support.supported ||
        input.admissionPins === undefined
      )
        throw new BoatAdapterError("admission-refused");
      const secretEnv = z
        .record(z.string(), z.string())
        .parse(
          input.secretEnv ??
            (input.secretEnvDir === undefined
              ? {}
              : JSON.parse(await readFile(join(input.secretEnvDir, "env.json"), "utf8"))),
        );
      const binds = bindsEnv(input.binds);
      const bootEnv = {
        ...Object.fromEntries(nativeWorkspaceInstallation(input.blueprint).bootEntries),
        ...(binds === undefined ? {} : { SEALANT_BINDS: binds }),
        ...nativeBootEnv(input, {
          secretEnvFile: true,
          dotfiles: false,
          secretEnvFilePath: SECRET_ENV_FILE_PATH,
          stopGraceMs: 60_000,
        }),
      };
      // What the agent receives in one push: the boot environment, the secret environment it
      // writes 0600 before `sealantd boot`, and whether the VM's own Docker must be up first.
      const material = Redacted.make({
        bootEnv,
        secretEnv,
        pins: input.admissionPins,
        docker: input.blueprint.tooling.services?.docker?.enabled === true,
      });
      const deploymentId = this.options.deploymentId;
      step = "prepare-allocation";
      const target = await this.options.runtime.runPromise(
        Effect.gen(function* () {
          const instances = yield* WorkspaceRuntimeInstanceRepo;
          const instance = yield* instances.getRuntimeInstanceByRunId(runId);
          if (
            instance?.adapter !== "boat" ||
            instance.publicationId !== input.publication.publicationId ||
            instance.stopReason !== null
          )
            return yield* Effect.fail(new BoatAdapterError("target-mismatch"));
          const scope = nativeImageScopeSchema.safeParse(instance.imageScope);
          if (!scope.success) return yield* Effect.fail(new BoatAdapterError("target-mismatch"));
          return yield* (yield* BoatVm).prepare({
            deploymentId,
            workspaceId,
            consumer: nativeArtifactConsumerSchema.parse({ runId, runtimeInstanceId: runId }),
            launchAttemptId: input.launchId ?? runId,
            publication: input.publication,
            scope: scope.data,
            sourceKind: "capture",
            // Read once from the run's stored spec and frozen on the run's row: readiness, the
            // removal and every sweep read it from there.
            ...(input.blueprint.runtime.resources === "none" ? { resources: "none" as const } : {}),
          });
        }),
      );
      identity = { adapter: "boat", resourceId: target.sandboxId, reference: runId };
      step = "report-started";
      await hooks?.onStarted?.(identity);
      step = "readiness";
      await this.options.runtime.runPromise(
        Effect.flatMap(BoatReadiness, (ready) => ready.launch(target, material)),
      );
      step = "control";
      const control = Redacted.value(
        await this.options.runtime.runPromise(
          Effect.flatMap(BoatExecution, (execution) => execution.control(target)),
        ),
      );
      if (control.kind !== "websocket") throw new BoatAdapterError("target-mismatch");
      identity = { ...identity, endpoint: control.url };
      const readyIdentity = identity;
      step = "report-ready";
      return await completeReadyLaunch({
        blueprint: input.blueprint,
        identity: readyIdentity,
        hooks,
        steps: async () => {
          step = "credentials";
          if (input.credentialFiles !== undefined && input.credentialFiles.length > 0)
            await (this.options.control ?? liveControlChannel).writeCredentialFiles(
              control,
              input.credentialFiles,
            );
          return { ...readyIdentity, status: "ready" as const };
        },
      });
    } catch (error) {
      // The diagnostic is an allowlist with no free text. What sealantd itself said when it refused
      // an operation goes to the worker's log, where an operator can read it.
      const refusal = sealantRefusalBehind(error);
      if (refusal !== undefined)
        console.warn(`Boat launch · run ${raw.runId ?? "unknown"}: sealantd refused at ${step}`, {
          operation: refusal.operation,
          code: refusal.code,
          message: safeCommandTail(refusal.message),
        });
      if (identity === undefined && raw.runId !== undefined) {
        try {
          identity = await this.locate({ runId: raw.runId });
        } catch {
          /* Durable reconciliation retains unknown allocations. */
        }
      }
      return failLaunch({
        blueprint: raw.blueprint,
        identity,
        runtime: "running",
        error: new BoatAdapterError(
          error instanceof BoatAdapterError ? error.code : "launch-held",
          boatLaunchDiagnostic(error, step),
        ),
      });
    }
  }

  async locate(input: { readonly runId: string }): Promise<RuntimeLaunchIdentity | undefined> {
    const run = await this.options.runtime.runPromise(
      Effect.flatMap(BoatRunRepo, (repo) => repo.get(input.runId)),
    );
    if (run?.deploymentId !== this.options.deploymentId) return undefined;
    if (run.sandboxId !== null)
      return { adapter: "boat", resourceId: run.sandboxId, reference: input.runId };
    // Boat was never asked for a VM, or holds none by its own word: the run has no executor.
    if (run.createIssuedAt === null || run.absentAt !== null) return undefined;
    // A create was issued and nobody knows yet whether Boat made a VM for it: unknown is never
    // taken for none. The VM sweep keeps looking, and adopts the VM if it appears.
    throw new BoatAdapterError("launch-held");
  }

  /**
   * The one deletion of the VM (`BoatRemoval.remove`), found by its id, which a deployment holds
   * one run for; `reference` is not read (adopting the VM rewrites it to `boat:<sandbox>`, which
   * names no run).
   *
   * Authorization. Nothing here weighs the work on the VM: that is its caller's, and `stop` checks
   * that the caller holds what it says. A VM Boat no longer has is only cleaned up, and a recorded
   * deletion operation is only polled. A DELETE is sent only for a run that is stopping or failed,
   * and then only when one of these holds, read at the moment the DELETE is about to be sent:
   *
   *  - no launch was ever pushed to the VM (it was never bound, or it was fenced with no launch
   *    issued): Core's own record that no daemon ran on it;
   *  - the run's capture record holds an issued removal under a live hold: the shared path's
   *    deletion ticket, which it issues right before this call and only while the evidence it was
   *    authorized on (a complete FINAL observed or attested) is still current, with no
   *    observation in flight;
   *  - the owner's discard is on that record;
   *  - this adapter's own `recover` answered, in this process and within the last ten minutes,
   *    that the VM holds nothing to save (the agent's typed answer).
   *
   * Every caller of `stop` in the shared path holds one of those, or acts on an executor the
   * runtime reported `missing`, which here only cleans up. Anything else is refused before Boat
   * is asked (`close-held`).
   *
   * It fences the run, claims the first DELETE on the run's row, sends it once, records Boat's
   * operation and waits at most the removal's bound for `completed`. Idempotent on the recorded
   * operation: a repeat polls it and never sends DELETE again. Resolves once Boat no longer has
   * the VM; what the VM held (gateway, tunnel slot, publication pin) is released in the same
   * call, and whatever of it could not be is retried by Boat's
   * convergence sweep. A deletion Boat accepted and has not finished throws `close-pending` marked
   * `removalPending`: nothing is released, and the next call polls it. A failure once Boat was
   * asked and before its operation was recorded throws `close-pending` unmarked: an outcome nobody
   * knows. Only a failure before Boat was asked anything (`close-held`, `close-unavailable`, or no
   * run for the VM) is marked `removalRefused`.
   *
   * It declares no `removalFenceMs`: Boat states no bound on a deletion.
   */
  async stop(input: RuntimeAdapterStopInput) {
    const { deploymentId } = this.options;
    const now = this.options.now ?? Date.now;
    const saidNothingToSave = this.#nothingToSave;
    const settled = await this.options.runtime.runPromise(
      Effect.gen(function* () {
        const run = yield* (yield* BoatRunRepo)
          .getBySandbox({ deploymentId, sandboxId: input.resourceId })
          .pipe(Effect.mapError(() => new BoatRemovalError("unavailable", false)));
        if (run === undefined) return "unknown-vm" as const;
        const drains = yield* WorkspaceCaptureDrainRepo;
        // Read when the removal is about to send DELETE to a VM a daemon may have run on. A read
        // that fails authorizes nothing.
        const authorized = drains.getByRunId(run.runId).pipe(
          Effect.map((record) => {
            if (record?.discardRequestedAt != null) return true;
            // The hold is the database's instant: weighed against the wall clock, never the
            // adapter's own pacing clock.
            if (
              record?.deletionState === "deleting-issued" &&
              record.deletionExpiresAt != null &&
              record.deletionExpiresAt.getTime() > Date.now()
            )
              return true;
            const said = saidNothingToSave.get(input.resourceId);
            return said !== undefined && now() - said < BOAT_NOTHING_TO_SAVE_MS;
          }),
          Effect.orElseSucceed(() => false),
        );
        return yield* (yield* BoatRemoval).remove(run, { authorized });
      }).pipe(Effect.result, Effect.timeoutOption(this.options.stopBoundMs ?? BOAT_STOP_BOUND_MS)),
    );
    // Not answered within the bound: Boat may have been asked, and nobody knows.
    if (Option.isNone(settled)) throw new BoatAdapterError("close-pending");
    const result = settled.value;
    if (Result.isFailure(result)) {
      const failure = result.failure;
      if (!failure.requested)
        throw removalRefused(
          new BoatAdapterError(failure.code === "held" ? "close-held" : "close-unavailable"),
        );
      // Boat's deletion operation is on record and this call could not read how far it is: Boat
      // accepted the deletion, and it is still deleting as far as anyone knows.
      if (failure.recorded && failure.code === "unavailable")
        throw removalPending(new BoatAdapterError("close-pending"));
      throw new BoatAdapterError("close-pending");
    }
    if (result.success === "unknown-vm")
      throw removalRefused(new BoatAdapterError("target-mismatch"));
    if (result.success === "deleting") throw removalPending(new BoatAdapterError("close-pending"));
    saidNothingToSave.delete(input.resourceId);
    return { adapter: this.id, resourceId: input.resourceId, outcome: "stopped" as const };
  }

  /**
   * Recover a retained VM: one whose run is stopping or failed and whose daemon is not known to
   * be up. Fences first, so nothing can start on the VM again whatever is answered:
   *
   *  - a launch never pushed to the VM's agent is never pushed (the fence and the push are each
   *    one statement on the run's row: whichever is first decides, and the fence says which), and
   *    a VM never bound has none to push: `nothing-to-save`, by Core's own record that no daemon
   *    ran on it;
   *  - a launch that may have been pushed is held, and the agent is asked to recover it on the
   *    VM's own disk (`POST /sealant/recover`), handed the capture token the sweep unsealed. Only
   *    when its launch recorded a daemon with sealantd's recovery boot, and only with that token:
   *    otherwise `unsupported`, as the sweep itself answers for every other runtime.
   *
   * The agent's answers: `running` (the daemon is up: drain it), `restarted` (sealantd is booting
   * in recovery mode: drain it), `nothing-to-save` (the recovery boot exited 76, or the agent
   * recorded no launch on the boot it was bound on). Its refusals (`recover-new-boot`,
   * `recover-binding-conflict`, `recover-state-unknown`) and a 503 for a stop it could not prove
   * are `unsupported`: the capture cannot be recovered here, and the VM is kept until its owner
   * discards it.
   *
   * It never answers `nothing-to-save` while a launch push is in flight. The agent's `no-launch`
   * is taken only once the launch that issued the push is over (its worker finished or lost its
   * lease): until then a push still on its way could start a daemon after the agent answered.
   *
   * `missing` only from Boat's committed absence.
   */
  async recover(input: RuntimeAdapterRecoverInput): Promise<RuntimeAdapterRecoverResult> {
    const { deploymentId } = this.options;
    const sandboxId = input.resourceId;
    const result = await this.options.runtime.runPromise(
      Effect.gen(function* () {
        const runs = yield* BoatRunRepo;
        const run = yield* runs.getBySandbox({ deploymentId, sandboxId });
        if (run === undefined)
          return unsupported(
            `no Boat run of this deployment names VM ${sandboxId}; it is not this adapter's to recover`,
          );
        const instance = yield* (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(
          run.runId,
        );
        // Only a run that is stopping or failed is ever fenced.
        if (
          instance?.adapter !== "boat" ||
          instance.resourceId !== sandboxId ||
          (instance.stopReason === null && instance.status !== "failed")
        )
          return unsupported(
            `the run of Boat VM ${sandboxId} is not stopping; nothing on it is fenced or recovered`,
          );
        const presence = yield* (yield* BoatVm).observe(run);
        if (presence.kind === "absent") return { outcome: "missing" } as const;
        // Boat did not answer for the exact owned VM: nothing is concluded, and nothing fenced.
        if (presence.kind !== "present")
          return yield* Effect.fail(new BoatAdapterError("close-unavailable"));
        const target = run.target;
        if (target === null)
          return nothingToSave(
            `Boat VM ${sandboxId} was never bound: no launch could be pushed to it, so no daemon ran on it`,
          );
        const execution = yield* BoatExecution;
        // The durable fence against the push: one statement, which says whether a push was issued
        // before it. Once fenced, no launch is ever pushed.
        const fenced = yield* runs.fence(run.runId);
        if (fenced.launchIssuedAt === null)
          return nothingToSave(
            `no launch was ever pushed to the agent of Boat VM ${sandboxId}, so no daemon ran on it`,
          );
        // A daemon that is up needs no recovery boot and no token: it is drained as it is. This
        // is every attempt after the one that restarted it, which the sweep hands no token (it
        // reads the daemon as running), and whose drain is the only thing left to do. With a
        // token and a recovery boot the agent is asked, and answers `running` for it itself.
        if (
          (input.daemonRecoveryBoot !== true || input.secretEnv === undefined) &&
          (yield* execution.daemon(target)).kind === "up"
        )
          return { outcome: "running" } as const;
        // A daemon may have run on it: only a recovery boot can save what its disk holds. One
        // without it would run its ordinary boot over that work, and one without its capture
        // token could ship nothing.
        if (input.daemonRecoveryBoot !== true)
          return unsupported(
            `not recoverable in place · the daemon of Boat VM ${sandboxId} ${
              input.daemonRecoveryBoot === false
                ? "predates sealantd's recovery boot"
                : "is of a build Core cannot tell has sealantd's recovery boot"
            }: restarting it would run its ordinary boot over the work its disk holds. It is kept until its owner discards it`,
          );
        if (input.secretEnv === undefined)
          return unsupported(
            `not recoverable · no capture token · Boat VM ${sandboxId} is still up, and this recovery carries no capture token to boot its daemon with. It is kept until its owner discards it`,
          );
        const answered = yield* execution.recover(target, Redacted.make(input.secretEnv)).pipe(
          Effect.catch((error) => {
            const reason =
              error instanceof BoatExecutionError ? error.diagnostic?.agent?.reason : undefined;
            if (error instanceof BoatExecutionError && error.code === "agent-refused")
              return Effect.succeed(
                unsupported(
                  `the agent of Boat VM ${sandboxId} refused the recovery (${reason ?? "unknown"}): its capture cannot be recovered here. The VM is kept until its owner discards it`,
                ),
              );
            if (
              error instanceof BoatExecutionError &&
              error.code === "agent-not-ready" &&
              reason !== undefined &&
              BOAT_AGENT_CLOSE_UNVERIFIED.some((unverified) => unverified === reason)
            )
              return Effect.succeed(
                unsupported(
                  `the agent of Boat VM ${sandboxId} could not prove the workspace's processes stopped (${reason}), so it started nothing. The VM is kept`,
                ),
              );
            return Effect.fail(error);
          }),
        );
        if (answered === "running") return { outcome: "running" } as const;
        if (answered === "restarted") return { outcome: "restarted" } as const;
        if ("outcome" in answered && answered.outcome === "unsupported") return answered;
        if (answered.basis === "daemon") return nothingToSave(nothingToSaveDetail(answered.detail));
        // `no-launch`: the agent recorded no launch on this boot. A push the launch issued may
        // still be on its way while that launch runs: taken only once it is over.
        if (yield* runs.launchInFlight(run.runId))
          return unsupported(
            `the agent of Boat VM ${sandboxId} recorded no launch, and the launch that issued one is still in flight; asked again once it is over`,
          );
        return nothingToSave(
          `the agent of Boat VM ${sandboxId} recorded no launch on the boot it was bound on, so no daemon ran on it`,
        );
      }),
    );
    if (result.outcome === "nothing-to-save")
      this.#nothingToSave.set(sandboxId, (this.options.now ?? Date.now)());
    return result;
  }

  /**
   * What Boat and the VM's agent say of a launched executor, found by its VM id.
   *
   * - `missing`: only from a committed absence: Boat's typed 404 for a VM that was seen past
   *   creation, or a completed deletion operation.
   * - `exited` with `platformEnded: false`: the agent's health names `daemonExit`; or the run is
   *   stopping or failed and no daemon is known to be up on its VM (no launch was pushed, a push
   *   was never confirmed, or the agent reports no launch on its boot and the run was never
   *   ready). Nothing is removed on that answer without evidence: it sends the run to its
   *   recovery, which fences it and asks the agent.
   * - `running`: everything else, including every failed, timed-out or unreadable read of Boat or
   *   the agent, a launch still in flight, and an agent that reports no launch on its boot for a
   *   run that was ready (its daemon may still be alive: the agent restarted and could not adopt
   *   its record).
   *
   * Boat is read at most once per VM per `BOAT_INSPECT_READ_MS` (`BOAT_INSPECT_STOPPING_READ_MS`
   * once the run is stopping or failed) and `running` is answered in between. Only `running` is
   * ever answered without a read, and only after a read that answered `running`: an `exited` or
   * `missing` is never served from memory. The daemon's last output is redacted with the run's
   * bearer only (the agent removes the launch's secrets itself).
   */
  async inspect(input: RuntimeAdapterInspectInput): Promise<RuntimeAdapterInspectResult> {
    const { deploymentId, runtime } = this.options;
    const inspected = this.#inspected;
    const now = (this.options.now ?? Date.now)();
    const sandboxId = input.resourceId;
    const running: RuntimeAdapterInspectResult = { state: "running" };
    const read = Effect.gen(function* () {
      const run = yield* (yield* BoatRunRepo).getBySandbox({ deploymentId, sandboxId });
      // No run of this deployment names the VM: nothing here can say anything of it.
      if (run === undefined) return running;
      const instance = yield* (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(
        run.runId,
      );
      // The run is stopping, or its launch failed or its daemon ended: its desired state is
      // stopped.
      const stopping =
        instance !== undefined && (instance.stopReason !== null || instance.status === "failed");
      const last = inspected.get(sandboxId);
      if (
        last !== undefined &&
        now - last < (stopping ? BOAT_INSPECT_STOPPING_READ_MS : BOAT_INSPECT_READ_MS)
      )
        return running;
      // Marked before the reads, so a failed or slow one is not repeated every poll either.
      if (inspected.size >= BOAT_INSPECT_REMEMBERED)
        for (const [id, at] of inspected)
          if (now - at >= BOAT_INSPECT_READ_MS) inspected.delete(id);
      inspected.set(sandboxId, now);
      const presence = yield* (yield* BoatVm).observe(run);
      if (presence.kind === "absent") return { state: "missing" } as const;
      // A 404 before Boat ever reported the VM past creation, a failed read, another VM's labels.
      if (presence.kind !== "present") return running;
      const platformState = presence.sandbox.state;
      const exited = { state: "exited", platformEnded: false, platformState } as const;
      const neverConfirmed = {
        ...exited,
        detail:
          "The run is stopping or failed, and no launch was confirmed running on its Boat VM: its recovery fences it and asks the VM's agent.",
      };
      // Never bound: no launch could be pushed. While its launch may still bind it, it is running.
      if (run.target === null) return stopping ? neverConfirmed : running;
      const daemon = yield* (yield* BoatExecution).daemon(run.target);
      switch (daemon.kind) {
        case "exited":
          return {
            ...exited,
            ...(daemon.exitCode === null ? {} : { exitCode: daemon.exitCode }),
            detail: `sealantd in the Boat VM exited before the workspace stopped (code ${String(daemon.exitCode)}, signal ${String(daemon.signal)}).${
              daemon.output === undefined || daemon.output.trim() === ""
                ? ""
                : ` Its last output:\n${daemon.output.trim()}`
            }`,
          };
        case "not-booted":
          // The agent says so with a valid bearer only after it restarted on the same boot and
          // could not adopt its launch record: the daemon of a run that was ready may still be
          // alive, and nothing observed it end.
          return instance?.status === "ready"
            ? ({ state: "running", platformState } as const)
            : {
                ...exited,
                detail: "The Boat VM's agent reports no daemon launched on its current boot.",
              };
        case "never-launched":
          return {
            ...exited,
            detail:
              "No launch was ever pushed to the Boat VM's agent, and its execution is fenced: no daemon ran on it.",
          };
        case "unasked":
          // The launch was not pushed, or its push was never confirmed. A launch still in flight
          // is running; once its run is stopping or failed, its recovery decides.
          return stopping ? neverConfirmed : ({ state: "running", platformState } as const);
        case "up":
          return { state: "running", platformState } as const;
      }
    }).pipe(
      Effect.timeoutOption(this.options.inspectBoundMs ?? BOAT_INSPECT_BOUND_MS),
      Effect.map((result) => Option.getOrElse(result, () => running)),
      // Unknown is never an exit and never absence.
      Effect.catchCause(() => Effect.succeed(running)),
    );
    const result: RuntimeAdapterInspectResult = await runtime.runPromise(read);
    // An ended answer is never remembered: the next call reads again.
    if (result.state !== "running") inspected.delete(sandboxId);
    return result;
  }
}
