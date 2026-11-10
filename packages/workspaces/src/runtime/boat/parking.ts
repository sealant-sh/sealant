import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  type SealantDB,
} from "@sealant/db";
import type { BoatExecutionTarget } from "@sealant/validators";
import { boatExecutionTargetSchema } from "@sealant/validators";
import { Context, Effect, Layer, Redacted, Clock } from "effect";
import { z } from "zod";

import { SealantRuntime } from "../../sealantd/runtime.js";
import { boatTargetIsCurrent } from "../../worker/boat-current.js";
import { BoatReadiness } from "../../worker/boat-readiness.js";
import { BoatResourcesHost } from "../../worker/boat-resources.js";
import { DEFAULT_CAPTURE_DRAIN_SETTINGS, finalFlushRequest } from "../../worker/capture-drain.js";
import { BOAT_AGENT_DATA_DIR } from "./agent-contract.js";
import type { BoatParkingApi } from "./api.js";
import {
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  boatDeletionIdSchema,
  type BoatResult,
} from "./config.js";
import { BoatOwnership } from "./config.js";
import { BoatExecution } from "./execution.js";
import { parkingResumeLaunch } from "./parking-launch.js";

/** Failed observations retain their exact source, artifact, operation and tunnel reservation. */
export class BoatParkingError extends Error {
  readonly _tag = "BoatParkingError";
  constructor(readonly code: "held" | "pending" | "unavailable") {
    super(`Boat parking: ${code}`);
  }
}
/** Automatic parking owns no alternative replay store: all effects belong to the capture ledger. */
export class BoatParking extends Context.Service<
  BoatParking,
  {
    readonly park: (
      target: BoatExecutionTarget,
    ) => Effect.Effect<"parked" | "pending", BoatParkingError>;
    readonly retain: (target: BoatExecutionTarget) => Effect.Effect<void, BoatParkingError>;
    readonly resume: (runId: string) => Effect.Effect<BoatExecutionTarget, BoatParkingError>;
    readonly reconcile: () => Effect.Effect<
      readonly {
        readonly runId: string;
        readonly outcome: "parked" | "pending" | "held" | "unavailable";
      }[],
      BoatParkingError
    >;
  }
>()("@sealant/workspaces/boat/BoatParking") {}

/** The root supplies the selected personal account and policy; no credential discovery occurs here. */
export class BoatParkingProvider extends Context.Service<
  BoatParkingProvider,
  {
    readonly api: BoatParkingApi;
    readonly automaticParkingEnabled: boolean;
    readonly retainedParkingDelaySeconds: number;
  }
>()("@sealant/workspaces/boat/BoatParkingProvider") {}

const boundary = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, BoatParkingError> =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof BoatParkingError ? error : new BoatParkingError("unavailable"),
    ),
  );
const held = () => Effect.fail(new BoatParkingError("held"));
const pending = () => Effect.fail(new BoatParkingError("pending"));
const call = <A>(send: () => Promise<BoatResult<A>>) =>
  Effect.tryPromise({ try: send, catch: () => new BoatParkingError("unavailable") }).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail(new BoatParkingError("unavailable")),
    ),
  );
const parse = <A>(read: () => A) =>
  Effect.try({ try: read, catch: () => new BoatParkingError("held") });

type ParkingDependencies =
  | BoatAllocationRepo
  | BoatReadiness
  | SealantRuntime
  | BoatExecutionRepo
  | BoatTunnelRepo
  | WorkspaceCaptureDrainRepo
  | BoatExecution
  | BoatResourcesHost
  | BoatParkingProvider;
const make: Effect.Effect<BoatParking["Service"], never, ParkingDependencies> = Effect.gen(
  function* () {
    const allocations = yield* BoatAllocationRepo;
    const readiness = yield* BoatReadiness;
    const runtime = yield* SealantRuntime;
    const executions = yield* BoatExecutionRepo;
    const tunnels = yield* BoatTunnelRepo;
    const canonical = yield* WorkspaceCaptureDrainRepo;
    const execution = yield* BoatExecution;
    const host = yield* BoatResourcesHost;
    const provider = yield* BoatParkingProvider;
    const policy = {
      automaticParkingEnabled: provider.automaticParkingEnabled,
      retainedParkingDelaySeconds: provider.retainedParkingDelaySeconds,
    };
    const custody = yield* canonical.preservation;
    type Claim = Parameters<typeof custody.release>[0];
    const releaseClaim = (claim: Claim) =>
      custody
        .release(claim)
        .pipe(
          Effect.catch(() =>
            Effect.logWarning("Boat parking claim release failed; its lease still fences custody."),
          ),
        );
    const current = (target: BoatExecutionTarget) =>
      Effect.gen(function* () {
        const invoked = yield* executions.get(target.runtimeInstanceId);
        if (
          target.deploymentId !== host.deploymentId ||
          !(yield* boatTargetIsCurrent(target).pipe(
            Effect.provideService(BoatAllocationRepo, allocations),
            Effect.provideService(WorkspaceCaptureDrainRepo, canonical),
          )) ||
          !isDeepStrictEqual(invoked?.target, target)
        )
          return yield* held();
        return invoked;
      });
    const material = (target: BoatExecutionTarget) =>
      Effect.gen(function* () {
        const sealed = yield* execution.parkingMaterial(target);
        const kept = Redacted.value(sealed);
        const credentials = yield* parse(() =>
          z
            .object({
              endpoint: z.string().url(),
              token: z.string().min(1),
              worktreeId: z.string().min(1),
              launchId: z.string().min(1),
            })
            .parse({
              endpoint: kept.bootEnv["SEALANT_CAPTURE_ENDPOINT"],
              token: kept.secretEnv["SEALANT_CAPTURE_TOKEN"],
              worktreeId: kept.bootEnv["SEALANT_CAPTURE_WORKTREE_ID"],
              launchId: kept.bootEnv["SEALANT_CAPTURE_LAUNCH_ID"],
            }),
        );
        if (kept.bootEnv["SEALANT_WORKSPACE_SOURCE"] !== "capture") return yield* held();
        return { sealed, credentials: Redacted.make(credentials) };
      });
    const retain = (target: BoatExecutionTarget) =>
      Effect.gen(function* () {
        yield* current(target);
        const root = yield* canonical.getByRunId(target.runId);
        const previous = Object.keys(root?.observationFences ?? {});
        if (previous.length > 1) return yield* held();
        const token = previous[0] ?? randomUUID();
        if (previous.length === 0) {
          const opened = yield* canonical.openObservation({
            runId: target.runId,
            token,
            ttlMs: 30_000,
          });
          if ("refused" in opened) return yield* held();
        }
        const control = yield* execution.control(target);
        const report = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* runtime.connect(Redacted.value(control));
            return yield* previous.length === 0
              ? session.captureFlush(finalFlushRequest(DEFAULT_CAPTURE_DRAIN_SETTINGS))
              : session.captureStatus();
          }),
        ).pipe(Effect.timeout(25_000));
        yield* current(target);
        if (
          typeof report.complete !== "boolean" ||
          report.incompleteReason === "in-progress" ||
          report.incompleteReason === "not-final"
        )
          return yield* held();
        yield* canonical.recordStatus({
          runId: target.runId,
          status: { ...report },
          observedAt: new Date(),
          fence: token,
        });
        yield* custody.markRetained({ runId: target.runId, reason: "idle Boat session", policy });
      });
    const resume = (runId: string, claim: Claim) =>
      Effect.gen(function* () {
        const work = yield* custody.prepareRecovery(claim);
        const source = yield* executions.get(work.source.runtimeInstanceId);
        if (source?.admission == null || source.target.sandboxId !== work.source.sandboxId)
          return yield* held();
        const saved = yield* call(() =>
          provider.api.getSnapshot(boatSnapshotNameSchema.parse(work.artifact.name)),
        );
        if (
          saved.status !== "ready" ||
          saved.snapshotId !== work.artifact.snapshotId ||
          saved.sourceSandboxId !== work.artifact.sourceSandboxId ||
          saved.createdAt !== work.artifact.createdAt
        )
          return yield* held();
        const ownershipResult = BoatOwnership.parse({
          ...source.target,
          runtimeInstanceId: work.destinationRuntimeInstanceId,
          launchAttemptId: work.operationId,
        });
        if (!ownershipResult.ok) return yield* held();
        const ownership = ownershipResult.value;
        const permit = yield* custody.issue(claim, work.operationId);
        let child;
        if (permit.kind === "issued") {
          child = yield* call(() =>
            provider.api.create({
              ownership,
              idempotencyKey: work.createKey,
              from: boatSnapshotNameSchema.parse(work.artifact.name),
              lifetime: { kind: "production-session" },
            }),
          );
        } else if (permit.kind === "observe-only") {
          if (work.target !== undefined) {
            const knownId = yield* parse(() => boatSandboxIdSchema.parse(work.target?.sandboxId));
            child = yield* call(() => provider.api.get(knownId));
          } else {
            const observed = yield* Effect.tryPromise({
              try: () => provider.api.discover(ownership),
              catch: () => new BoatParkingError("unavailable"),
            });
            if (observed.kind !== "found") return yield* pending();
            child = observed.sandbox;
          }
        } else return yield* held();
        const id = child.id;
        child = yield* call(() => provider.api.get(id));
        const labels = {
          "sealant-runtime": "boat",
          "sealant-deployment": ownership.deploymentId,
          "sealant-workspace": ownership.workspaceId,
          "sealant-run": ownership.runId,
          "sealant-instance": ownership.runtimeInstanceId,
          "sealant-attempt": ownership.launchAttemptId,
          "sealant-source": ownership.sourceId,
        };
        if (
          child.id !== id ||
          !Object.entries(labels).every(([key, value]) => child.labels?.[key] === value)
        )
          return yield* held();
        if (
          child.hydrated !== true ||
          child.autoStop.kind !== "disabled" ||
          child.dataExpiredAt != null
        )
          return yield* pending();
        const boot = yield* call(() =>
          provider.api.execute(id, "/usr/bin/cat /proc/sys/kernel/random/boot_id", {
            timeoutSeconds: 10,
          }),
        );
        if (boot.exitCode !== 0 || boot.timedOut || boot.stderr !== "") return yield* held();
        const target = yield* parse(() =>
          boatExecutionTargetSchema.parse({
            ...source.target,
            runtimeInstanceId: work.destinationRuntimeInstanceId,
            launchAttemptId: work.operationId,
            sandboxId: id,
            diskLineage: work.createKey,
            bootId: boot.stdout.trim(),
          }),
        );
        if (target.bootId === source.target.bootId) return yield* held();
        yield* custody.recordRecoveryChild(claim, work.operationId, target);
        // The restored disk was parked on its last boot: the agent binds it once more, as this new
        // instance of the same deployment. The binding receipt is the rebind's durable identity.
        const bindingReceipt = yield* execution.exchange(target);
        const admissionId = yield* custody.prepareRecoveryAdmission(
          claim,
          work.operationId,
          work.rebindHash ?? bindingReceipt,
        );
        const admission = yield* custody.issue(claim, admissionId);
        if (admission.kind !== "issued" && admission.kind !== "observe-only") return yield* held();
        // Mend capture-store's lease is 30 seconds. Wait after positive writer closure before the
        // first plan, then require a strictly newer epoch. A changed server policy fails closed.
        const quiescent = work.closedAt.getTime() + 31_000;
        const now = yield* Clock.currentTimeMillis;
        if (now < quiescent) yield* Effect.sleep(quiescent - now);
        const kept = yield* material(source.target);
        const original = Redacted.value(kept.sealed);
        const bootEnv = yield* parkingResumeLaunch(
          Redacted.make(original.bootEnv),
          kept.credentials,
        );
        const ready = yield* readiness.launch(
          target,
          Redacted.make({
            bootEnv: Redacted.value(bootEnv),
            secretEnv: {
              ...original.secretEnv,
              SEALANT_CAPTURE_TOKEN: Redacted.value(kept.credentials).token,
            },
            pins: original.pins,
            docker: original.docker,
          }),
        );
        const control = yield* execution.control(target);
        const status = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* runtime.connect(Redacted.value(control));
            return yield* session.captureStatus();
          }),
        );
        const root = yield* canonical.getByRunId(runId);
        const oldEpoch = root?.lastStatus?.["epoch"];
        if (
          typeof oldEpoch !== "number" ||
          status.epoch <= oldEpoch ||
          status.worktreeId !== Redacted.value(kept.credentials).worktreeId
        )
          return yield* held();
        yield* custody.promoteRecovery(claim, admissionId, {
          runtimeId: ready.runtimeId,
          bootId: ready.bootId,
          isolationReceipt: ready.isolationReceipt,
        });
        return target;
      });
    const drive = Effect.fn("BoatParking.drive")(function* (
      target: BoatExecutionTarget,
      claim: Claim,
    ) {
      const prior = yield* custody.read(target.runId);
      const terminalVm = prior?.vms.find((vm) => vm.incarnationId === prior.currentIncarnationId);
      if (
        terminalVm?.removal === "completed" &&
        terminalVm.id === target.sandboxId &&
        terminalVm.runtimeInstanceId === target.runtimeInstanceId
      ) {
        const reservation = yield* tunnels.get(target.runtimeInstanceId);
        if (
          reservation?.removal?.completed !== true ||
          !isDeepStrictEqual(reservation.binding, { target, gatewayHostId: host.gatewayHostId })
        )
          return yield* held();
        yield* host.tunnel.remove(target);
        yield* tunnels.release(reservation);
        return "parked" as const;
      }
      yield* current(target);
      const reserved = yield* custody.reserveClose(claim, {
        automaticParkingEnabled: provider.automaticParkingEnabled,
        retainedParkingDelaySeconds: provider.retainedParkingDelaySeconds,
      });
      if (
        reserved.kind === "blocked" ||
        reserved.kind === "claim-lost" ||
        reserved.kind === "stale-evidence"
      )
        return yield* held();
      // Each turn advances at most three external stages. All issued packets survive turn loss.
      for (let step = 0; step < 3; step += 1) {
        if (!(yield* custody.renew(claim))) return yield* held();
        const work = yield* custody.parkingWork(claim);
        if (work === undefined) {
          const facts = yield* custody.read(target.runId);
          if (facts?.state === "parked") return "parked" as const;
          yield* custody.prepareParkingSave(claim);
          continue;
        }
        if (
          work.runtimeInstanceId !== target.runtimeInstanceId ||
          work.sandboxId !== target.sandboxId
        )
          return yield* held();
        const id = yield* parse(() => boatSandboxIdSchema.parse(work.sandboxId));
        yield* current(target);
        if (work.kind === "close-writer") {
          const permit = yield* custody.issue(claim, work.operationId);
          if (permit.kind !== "issued" && permit.kind !== "observe-only") return yield* held();
          yield* execution.hold(target);
          const receipt = yield* execution.park(target, work.operationId);
          yield* custody.recordWriterClosed(claim, receipt);
          yield* custody.prepareParkingSave(claim);
          continue;
        }
        if (work.kind === "save-snapshot") {
          const name = yield* parse(() => boatSnapshotNameSchema.parse(work.name));
          if (work.state === "prepared") {
            const inventory = yield* call(() => provider.api.personalSnapshots());
            if (inventory.snapshots.some((snapshot) => snapshot.name === name))
              return yield* held();
            yield* custody.recordParkingScope(claim, work.operationId, {
              ...inventory.allowance,
              name,
              sourceSandboxId: id,
              absent: true,
            });
            // Repeated stop is safe only for this permanently closed source, never a replacement.
            const source = yield* call(() => provider.api.get(id));
            if (source.id !== id) return yield* held();
            if (source.stop?.status !== "completed") {
              yield* call(() => provider.api.stop(id));
              const stopped = yield* call(() => provider.api.get(id));
              if (stopped.id !== id || stopped.stop?.status !== "completed")
                return yield* pending();
            }
            const permit = yield* custody.issue(claim, work.operationId);
            if (permit.kind !== "issued") return yield* held();
            const saved = yield* call(() => provider.api.savePersonalSnapshot(id, name));
            if (saved.name !== name || saved.sourceSandboxId !== id) return yield* held();
          }
          const saved = yield* call(() => provider.api.getSnapshot(name));
          if (saved.name !== name || saved.sourceSandboxId !== id || saved.status === "failed")
            return yield* held();
          if (saved.status !== "ready" || saved.snapshotId === undefined) return yield* pending();
          yield* custody.recordParkingSnapshot(claim, work.operationId, {
            name,
            snapshotId: saved.snapshotId,
            sourceSandboxId: id,
            createdAt: saved.createdAt,
          });
          const personal = yield* call(() => provider.api.personalSnapshots());
          if (
            !personal.snapshots.some(
              (snapshot) =>
                snapshot.name === name &&
                snapshot.sourceSandboxId === id &&
                snapshot.status === "ready" &&
                snapshot.snapshotId === saved.snapshotId &&
                snapshot.createdAt === saved.createdAt,
            )
          )
            return yield* held();
          const snapshotId = saved.snapshotId;
          const file = yield* call(() =>
            provider.api.verifyRecoveryFile({
              snapshotId,
              path: `${BOAT_AGENT_DATA_DIR}/park-${work.capsule.operationId}.json`,
              sha256: work.capsule.archiveHash,
              bytes: work.capsule.storedBytes,
            }),
          );
          yield* custody.verifyParkingSnapshot(claim, work.operationId, file);
          continue;
        }
        if (work.kind === "revoke-resources") {
          const reservation = yield* tunnels.get(target.runtimeInstanceId);
          if (
            reservation === undefined ||
            !isDeepStrictEqual(reservation.binding, { target, gatewayHostId: host.gatewayHostId })
          )
            return yield* held();
          const frozen = yield* tunnels.freeze(
            reservation,
            reservation.closeId ?? work.operationId,
          );
          yield* host.tunnel.remove(target);
          const revocation = createHash("sha256")
            .update(
              JSON.stringify({
                target,
                reservation: frozen.reservationId,
                close: frozen.closeId,
                gateway: "removed",
              }),
            )
            .digest("hex");
          yield* custody.prepareParkingRemoval(claim, revocation);
          continue;
        }
        let operation;
        if (work.state === "prepared") {
          const permit = yield* custody.issue(claim, work.operationId);
          if (permit.kind !== "issued") return yield* held();
          operation = yield* call(() => provider.api.deleteSandbox(id));
        } else {
          if (work.providerOperationId === null) return yield* pending();
          const deletion = yield* parse(() => boatDeletionIdSchema.parse(work.providerOperationId));
          operation = yield* call(() => provider.api.getDeletion(deletion));
        }
        if (operation.targetId !== id || operation.kind !== "sandbox") return yield* held();
        yield* custody.recordParkingDeletion(claim, work.operationId, operation.id);
        const reservation = yield* tunnels.get(target.runtimeInstanceId);
        if (
          reservation === undefined ||
          !isDeepStrictEqual(reservation.binding, { target, gatewayHostId: host.gatewayHostId })
        )
          return yield* held();
        const updated = yield* tunnels.recordRemoval(reservation, {
          id: operation.id,
          targetId: id,
          completed: operation.status === "completed",
        });
        if (operation.status !== "completed") return yield* pending();
        yield* custody.observe({
          runId: target.runId,
          receiptId: randomUUID(),
          operationId: work.operationId,
          sandboxId: id,
          providerOperationId: operation.id,
          kind: "removal-completed",
          observedAt: new Date(),
        });
        yield* host.tunnel.remove(target);
        yield* tunnels.release(updated);
        return "parked" as const;
      }
      return "pending" as const;
    });
    const retire = (claim: Claim) =>
      Effect.gen(function* () {
        for (const work of (yield* custody.prepareRetirements(claim)).slice(0, 3)) {
          if (!(yield* custody.renew(claim))) return yield* held();
          if (work.state !== "prepared") return yield* pending();
          const name = yield* parse(() => boatSnapshotNameSchema.parse(work.name));
          const saved = yield* call(() => provider.api.getSnapshot(name));
          if (
            saved.name !== name ||
            saved.snapshotId !== work.snapshotId ||
            saved.sourceSandboxId !== work.sourceSandboxId
          )
            return yield* held();
          const permit = yield* custody.issue(claim, work.operationId);
          if (permit.kind !== "issued") return yield* pending();
          yield* call(() => provider.api.deleteSnapshot(name));
          yield* custody.completeRetirement(claim, work.operationId);
        }
        yield* custody.finishLineage(claim);
      });
    const runClaim = (target: BoatExecutionTarget, claim: Claim) =>
      boundary(
        Effect.gen(function* () {
          const result = yield* drive(target, claim);
          if (result === "parked") yield* retire(claim);
          return result;
        }).pipe(Effect.timeout(110_000), Effect.ensuring(releaseClaim(claim))),
      );
    const resumeClaim = (runId: string, claim: Claim) =>
      boundary(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              while (yield* custody.renew(claim)) yield* Effect.sleep("30 seconds");
            }).pipe(Effect.forkScoped);
            return yield* resume(runId, claim).pipe(Effect.timeout(300_000));
          }),
        ).pipe(Effect.ensuring(releaseClaim(claim))),
      );
    let enrollmentAfter: string | undefined;
    return BoatParking.of({
      retain: (target) => boundary(retain(target)),
      resume: (runId) =>
        boundary(
          Effect.gen(function* () {
            const facts = yield* custody.read(runId);
            if (facts?.state === "active" && facts.desired === "preserve") {
              const target = yield* custody.resolveExecution(runId);
              if (target === undefined) return yield* held();
              return target;
            }
            const claim = yield* custody.claim(runId);
            if (claim === undefined) return yield* pending();
            return yield* resumeClaim(runId, claim);
          }),
        ),
      park: (target) =>
        boundary(
          Effect.gen(function* () {
            const claim = yield* custody.claim(target.runId);
            if (claim === undefined) return yield* pending();
            return yield* runClaim(target, claim);
          }),
        ),
      reconcile: () =>
        boundary(
          Effect.gen(function* () {
            // Enrollment rotates independently of the due queue so one broken source cannot starve it.
            const ids = yield* allocations.list({
              deploymentId: host.deploymentId,
              limit: 100,
              ...(enrollmentAfter === undefined ? {} : { after: enrollmentAfter }),
            });
            enrollmentAfter = ids.length === 100 ? ids.at(-1) : undefined;
            yield* Effect.forEach(ids, (runId) =>
              Effect.gen(function* () {
                const root = yield* canonical.getByRunId(runId);
                const allocation = yield* allocations.get(runId);
                if (
                  root?.custodyContract === 3 ||
                  root?.retainedAt == null ||
                  allocation?.target == null
                )
                  return;
                const target = allocation.target;
                const record = yield* executions.get(target.runtimeInstanceId);
                if (record?.admission == null) return;
                const kept = yield* material(target);
                yield* custody.enrollSource(
                  {
                    runId,
                    deploymentId: target.deploymentId,
                    accountScope: `personal:${host.deploymentId}`,
                    sandboxId: target.sandboxId,
                    diskBindingId: target.diskLineage,
                    allocationOperationId: target.launchAttemptId,
                    publicationId: target.sourceId,
                    captureLaunchId: Redacted.value(kept.credentials).launchId,
                    guestEpoch: record.admission.operationId,
                    guestManifestHash: target.manifestDigest,
                  },
                  policy,
                );
              }).pipe(Effect.catch(() => Effect.void)),
            );
            const claims = yield* custody.claimDue(10);
            return yield* Effect.forEach(claims, (claim) =>
              Effect.gen(function* () {
                const facts = yield* custody.read(claim.runId);
                if (
                  facts?.desired === "recover" &&
                  facts.vms.find((vm) => vm.incarnationId === facts.currentIncarnationId)
                    ?.removal === "completed"
                ) {
                  const outcome = yield* resumeClaim(claim.runId, claim).pipe(
                    Effect.as("pending" as const),
                    Effect.catch((error) =>
                      Effect.succeed(
                        error instanceof BoatParkingError ? error.code : ("unavailable" as const),
                      ),
                    ),
                  );
                  return { runId: claim.runId, outcome };
                }
                const work = yield* custody.parkingWork(claim);
                const vm = facts?.vms.find(
                  (value) => value.incarnationId === facts.currentIncarnationId,
                );
                const sourceId = work?.runtimeInstanceId ?? vm?.runtimeInstanceId;
                const target =
                  sourceId === undefined ? undefined : (yield* executions.get(sourceId))?.target;
                if (target === undefined || vm?.id !== target.sandboxId) {
                  yield* custody.release(claim);
                  return { runId: claim.runId, outcome: "held" as const };
                }
                const root = yield* canonical.getByRunId(claim.runId);
                if (
                  root?.retainedReason !== null &&
                  root?.lastStatus == null &&
                  vm?.removal !== "completed"
                ) {
                  yield* custody.release(claim);
                  const outcome = yield* boundary(retain(target)).pipe(
                    Effect.as("pending" as const),
                    Effect.catch((error) => Effect.succeed(error.code)),
                  );
                  return { runId: claim.runId, outcome };
                }
                const outcome = yield* runClaim(target, claim).pipe(
                  Effect.catch((error) => Effect.succeed(error.code)),
                );
                return { runId: claim.runId, outcome };
              }),
            );
          }),
        ),
    });
  },
);

/** Open assembly for PostgreSQL plus faithful HTTP/kernel boundary proofs. */
export const boatParkingLayerNoDeps: Layer.Layer<BoatParking, never, ParkingDependencies> =
  Layer.effect(BoatParking, make);
/** Shares existing execution, tunnel and canonical capture ownership. */
export const boatParkingLayer: Layer.Layer<
  BoatParking,
  never,
  | SealantDB
  | BoatExecution
  | BoatReadiness
  | BoatResourcesHost
  | BoatParkingProvider
  | SealantRuntime
> = boatParkingLayerNoDeps.pipe(
  Layer.provide(
    Layer.mergeAll(
      BoatAllocationRepoLive,
      BoatExecutionRepoLive,
      boatTunnelRepoLayer,
      WorkspaceCaptureDrainRepoLive,
    ),
  ),
);
