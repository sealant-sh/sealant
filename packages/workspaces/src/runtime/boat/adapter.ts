import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BoatAllocationRepo, WorkspaceRuntimeInstanceRepo } from "@sealant/db";
import {
  boatSupport,
  nativeArtifactConsumerSchema,
  nativeImageScopeSchema,
  type NativePublication,
} from "@sealant/validators";
import { Effect, Redacted, type ManagedRuntime } from "effect";
import { z } from "zod";

import { nativeWorkspaceInstallation } from "../../buildkit/buildkit-builder.js";
import { BoatReadiness } from "../../worker/boat-readiness.js";
import { liveControlChannel, type ControlChannel } from "../kubernetes/adapter.js";
import {
  completeReadyLaunch,
  failLaunch,
  type RuntimeAdapterLaunchHooks,
  type RuntimeLaunchIdentity,
} from "../launch-retention.js";
import { bindsEnv } from "../mount-intent.js";
import { nativeBootEnv } from "../native-boot-env.js";
import {
  boatLaunchInputSchema,
  type RuntimeAdapter,
  type RuntimeLaunch,
  type RuntimeAdapterStopInput,
} from "../runtime-adapter.js";
import { BoatAllocation } from "./allocation.js";
import { BoatExecution } from "./execution.js";
import { BoatFinalClose } from "./final-close.js";

/** Public failures never carry guest responses, credentials or sealed launch material. */
export class BoatAdapterError extends Error {
  readonly _tag = "BoatAdapterError";
  constructor(
    readonly code: "admission-refused" | "launch-held" | "close-pending" | "target-mismatch",
  ) {
    super(`Boat runtime: ${code}`);
  }
}

export type BoatAdapterServices =
  | BoatAllocation
  | BoatReadiness
  | BoatExecution
  | BoatFinalClose
  | BoatAllocationRepo
  | WorkspaceRuntimeInstanceRepo;

/** Ordinary capture workspaces use the same durable owners as reconciliation. */
export class BoatRuntimeAdapter implements RuntimeAdapter<NativePublication> {
  readonly id = "boat" as const;
  constructor(
    private readonly options: {
      readonly deploymentId: string;
      readonly ownerIds: readonly string[];
      readonly runtime: ManagedRuntime.ManagedRuntime<BoatAdapterServices, never>;
      readonly control?: ControlChannel;
    },
  ) {}

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
        message:
          "Boat admission currently requires a capture source without inline dotfiles archives.",
      };
    return { supported: true as const };
  }

  async launch(raw: RuntimeLaunch<NativePublication>, hooks?: RuntimeAdapterLaunchHooks) {
    let identity: RuntimeLaunchIdentity | undefined;
    try {
      const input = boatLaunchInputSchema.parse(raw);
      const { runId, workspaceId, principalId } = input;
      if (
        runId === undefined ||
        workspaceId === undefined ||
        principalId === undefined ||
        !this.options.ownerIds.includes(principalId) ||
        !this.supports(input).supported ||
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
          secretEnvFilePath: "/run/sealant-inputs/secret-env",
          stopGraceMs: 60_000,
        }),
      };
      const payload = Redacted.make({
        files: [
          {
            name: "launch",
            bytes: Buffer.from(
              JSON.stringify({ format: "sealant-daemon-launch-v1", boot_env: bootEnv }),
            ),
          },
          { name: "secret-env", bytes: Buffer.from(JSON.stringify(secretEnv)) },
        ],
        pins: input.admissionPins,
      });
      const deploymentId = this.options.deploymentId;
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
          });
        }),
      );
      identity = { adapter: "boat", resourceId: target.sandboxId, reference: runId };
      await hooks?.onStarted?.(identity);
      await this.options.runtime.runPromise(
        Effect.flatMap(BoatReadiness, (ready) => ready.launch(target, payload)),
      );
      const control = Redacted.value(
        await this.options.runtime.runPromise(
          Effect.flatMap(BoatExecution, (execution) => execution.control(target)),
        ),
      );
      if (control.kind !== "websocket") throw new BoatAdapterError("target-mismatch");
      identity = { ...identity, endpoint: control.url };
      const readyIdentity = identity;
      return await completeReadyLaunch({
        blueprint: input.blueprint,
        identity: readyIdentity,
        hooks,
        steps: async () => {
          if (input.credentialFiles !== undefined && input.credentialFiles.length > 0)
            await (this.options.control ?? liveControlChannel).writeCredentialFiles(
              control,
              input.credentialFiles,
            );
          return { ...readyIdentity, status: "ready" as const };
        },
      });
    } catch (error) {
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
        error: error instanceof BoatAdapterError ? error : new BoatAdapterError("launch-held"),
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
          allocation?.phase !== "bound" ||
          allocation.target === null ||
          allocation.target.deploymentId !== deploymentId ||
          allocation.target.sandboxId !== input.resourceId
        )
          return yield* Effect.fail(new BoatAdapterError("target-mismatch"));
        return yield* (yield* BoatFinalClose).close(allocation.target);
      }),
    );
  }

  async stop(input: RuntimeAdapterStopInput) {
    if (input.reference === undefined) throw new BoatAdapterError("target-mismatch");
    if ((await this.closeCapture(input, input.reference)) !== "closed")
      throw new BoatAdapterError("close-pending");
    return { adapter: this.id, resourceId: input.resourceId, outcome: "stopped" as const };
  }
}
