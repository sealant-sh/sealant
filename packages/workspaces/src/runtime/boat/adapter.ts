import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BoatAllocationRepo, WorkspaceRuntimeInstanceRepo } from "@sealant/db";
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
  removalRefused,
  type RuntimeAdapter,
  type RuntimeAdapterInspectInput,
  type RuntimeAdapterInspectResult,
  type RuntimeLaunch,
  type RuntimeAdapterStopInput,
} from "../runtime-adapter.js";
import { BoatAllocation } from "./allocation.js";
import { BoatExecution } from "./execution.js";
import { BoatFinalClose } from "./final-close.js";
import {
  boatLaunchDiagnostic,
  boatLaunchSummary,
  type BoatLaunchDiagnostic,
} from "./launch-diagnostics.js";
import { BoatObserver } from "./observation.js";
import { BoatRemoval, BoatRemovalError } from "./removal.js";

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
 * stands. `close-unavailable`: Boat or the database could not be read before anything was asked
 * of Boat. Boat was sent nothing in either.
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
  | BoatAllocation
  | BoatReadiness
  | BoatExecution
  | BoatFinalClose
  | BoatRemoval
  | BoatObserver
  | BoatAllocationRepo
  | WorkspaceRuntimeInstanceRepo;

/**
 * How often `inspect` reads Boat and the agent for one VM whose run is not stopping (the period
 * the lifecycle sweep observes a ready VM at). In between it answers `running` without a read.
 */
export const BOAT_INSPECT_READ_MS = 60_000;
/** The bound on one inspection's reads; past it the answer is `running`. */
const BOAT_INSPECT_BOUND_MS = 20_000;
/** Past this many remembered VMs, the ones last read more than a period ago are forgotten. */
const BOAT_INSPECT_REMEMBERED = 1_024;

/** Ordinary capture workspaces use the same durable owners as reconciliation. */
export class BoatRuntimeAdapter implements RuntimeAdapter<NativePublication> {
  readonly id = "boat" as const;
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
    },
  ) {}

  /** When `inspect` last read Boat for a VM and answered `running`, by VM id. This process only. */
  readonly #inspected = new Map<string, number>();

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
          return yield* (yield* BoatAllocation).prepare({
            deploymentId,
            workspaceId,
            consumer: nativeArtifactConsumerSchema.parse({ runId, runtimeInstanceId: runId }),
            launchAttemptId: input.launchId ?? runId,
            publication: input.publication,
            scope: scope.data,
            sourceKind: "capture",
            // Read once from the run's stored spec and frozen on the allocation: readiness, the
            // close and every sweep read it from there.
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
    const record = await this.options.runtime.runPromise(
      Effect.flatMap(BoatAllocationRepo, (repo) => repo.get(input.runId)),
    );
    if (record?.input.deploymentId !== this.options.deploymentId || record.sandboxId === null)
      return undefined;
    return { adapter: "boat", resourceId: record.sandboxId, reference: input.runId };
  }

  async closeCapture(input: RuntimeAdapterStopInput, runId: string) {
    const deploymentId = this.options.deploymentId;
    return this.options.runtime.runPromise(
      Effect.gen(function* () {
        const allocation = yield* (yield* BoatAllocationRepo).get(runId);
        if (
          allocation === undefined ||
          allocation.input.deploymentId !== deploymentId ||
          allocation.sandboxId !== input.resourceId
        )
          return yield* Effect.fail(new BoatAdapterError("target-mismatch"));
        const owner = yield* BoatFinalClose;
        return allocation.target !== null
          ? yield* owner.close(allocation.target)
          : yield* owner.closeUnbound(runId, input.resourceId);
      }),
    );
  }

  /**
   * The one deletion of the VM (`BoatRemoval.remove`), for a caller that already holds what
   * authorizes it: nothing here weighs the work on the VM. The VM is found by its id, which a
   * deployment holds one allocation for; `reference` is not read (the allocation's writes rewrite
   * it to `boat:<sandbox>`, which names no run).
   *
   * It fences the run, sends DELETE once, records Boat's operation and waits at most the
   * removal's bound for `completed`. Idempotent on the recorded operation: a repeat polls it and
   * never sends DELETE again. Resolves only once Boat no longer has the VM and everything of it is
   * discharged. A deletion still in progress, and any failure once Boat was asked, throws
   * `close-pending`: an outcome nobody knows yet, never a refusal. Only a failure before Boat was
   * asked anything (`close-held`, `close-unavailable`, or no allocation for the VM) is marked
   * `removalRefused`.
   *
   * It declares no `removalFenceMs`: Boat states no bound on a deletion.
   */
  async stop(input: RuntimeAdapterStopInput) {
    const deploymentId = this.options.deploymentId;
    const result = await this.options.runtime.runPromise(
      Effect.gen(function* () {
        const allocation = yield* (yield* BoatAllocationRepo)
          .getBySandbox({ deploymentId, sandboxId: input.resourceId })
          .pipe(Effect.mapError(() => new BoatRemovalError("unavailable", false)));
        if (allocation === undefined) return "unknown-vm" as const;
        return yield* (yield* BoatRemoval).remove(allocation, { fence: true });
      }).pipe(Effect.result),
    );
    if (Result.isFailure(result))
      throw result.failure.requested
        ? new BoatAdapterError("close-pending")
        : removalRefused(
            new BoatAdapterError(
              result.failure.code === "held" ? "close-held" : "close-unavailable",
            ),
          );
    if (result.success === "unknown-vm")
      throw removalRefused(new BoatAdapterError("target-mismatch"));
    if (result.success !== "removed") throw new BoatAdapterError("close-pending");
    return { adapter: this.id, resourceId: input.resourceId, outcome: "stopped" as const };
  }

  /**
   * What Boat and the VM's agent say of a launched executor, found by its VM id.
   *
   * - `missing`: only from a committed absence: Boat's typed 404 for a VM that was seen past
   *   creation, or a completed deletion operation.
   * - `exited` with `platformEnded: false`: the agent's health names `daemonExit`, or reports
   *   `booted: false`, or the row shows the launch was never pushed and the execution is fenced.
   * - `running`: everything else, including every failed, timed-out or unreadable read of Boat or
   *   the agent.
   *
   * Boat is read at most once per VM per `BOAT_INSPECT_READ_MS` and `running` is answered in
   * between; once a stop is requested for the run every call reads. Only `running` is ever
   * answered without a read, and only after a read that answered `running`: an `exited` or
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
      const allocation = yield* (yield* BoatAllocationRepo).getBySandbox({
        deploymentId,
        sandboxId,
      });
      // No allocation of this deployment names the VM: nothing here can say anything of it.
      if (allocation === undefined) return running;
      const instance = yield* (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(
        allocation.input.consumer.runId,
      );
      const last = inspected.get(sandboxId);
      if (
        instance !== undefined &&
        instance.stopReason === null &&
        last !== undefined &&
        now - last < BOAT_INSPECT_READ_MS
      )
        return running;
      // Marked before the reads, so a failed or slow one is not repeated every poll either.
      if (inspected.size >= BOAT_INSPECT_REMEMBERED)
        for (const [id, at] of inspected)
          if (now - at >= BOAT_INSPECT_READ_MS) inspected.delete(id);
      inspected.set(sandboxId, now);
      const presence = yield* (yield* BoatObserver).observe(allocation);
      if (presence.kind === "absent") return { state: "missing" } as const;
      // A 404 before Boat ever reported the VM past creation, a failed read, another VM's labels.
      if (presence.kind !== "present" || allocation.target === null) return running;
      const platformState = presence.sandbox.state;
      const daemon = yield* (yield* BoatExecution).daemon(allocation.target);
      const exited = { state: "exited", platformEnded: false, platformState } as const;
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
          return {
            ...exited,
            detail: "The Boat VM's agent reports no daemon launched on its current boot.",
          };
        case "never-launched":
          return {
            ...exited,
            detail:
              "No launch was ever pushed to the Boat VM's agent, and its execution is fenced: no daemon ran on it.",
          };
        case "up":
        case "unasked":
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
