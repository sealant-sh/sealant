import {
  BoatRunRepo,
  BoatRunRepoLive,
  NativePublicationRepo,
  NativePublicationRepoLive,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type SealantDB,
  type WorkspaceRuntimeInstanceStopReason,
} from "@sealant/db";
import type { BoatRun } from "@sealant/validators";
import { Clock, Context, Effect, Exit, Layer } from "effect";

import { BoatResourcesHost } from "../../worker/boat-resources.js";
import type { WorkspaceStopOutcome } from "../../worker/process-workspace-stop.js";
import type { BoatExecution } from "./execution.js";
import type { BoatAllocationProvider } from "./provider.js";
import { BoatRemoval, boatRemovalLayer, type BoatRemovalProvider } from "./removal.js";

/** The sweep's page could not be read, or its bounds are not a page. */
export class BoatConvergenceError extends Error {
  readonly _tag = "BoatConvergenceError";
  constructor(readonly code: "invalid-page" | "unavailable") {
    super(`Boat convergence: ${code}`);
  }
}

/**
 * What one pass did for one run. `stopped`, `draining`, `kept`, `busy`: what the shared stop
 * answered when nudged. `cleaned`: Boat no longer has the VM and everything it held is released.
 * `discharging`: Boat no longer has it and something it held is not released yet. `held`: nothing
 * here can settle it (a create nobody can resolve, a VM this sweep may not touch). `skipped`:
 * nothing to do. `unavailable`: a read or the nudge failed; the next pass tries again.
 */
export type BoatConvergenceOutcome =
  | WorkspaceStopOutcome
  | "cleaned"
  | "discharging"
  | "held"
  | "skipped"
  | "unavailable";

/** One bounded page; the worker carries its cursor independently of the VM sweep and resources. */
export interface BoatConvergenceSweep {
  readonly entries: readonly {
    readonly runId: string;
    readonly outcome: BoatConvergenceOutcome;
  }[];
  readonly next?: string;
}

/**
 * The shared stop (`processWorkspaceStop`), as the worker runs it for every runtime: the nudge
 * calls it and decides nothing itself.
 */
export type BoatSharedStop = (run: {
  readonly runId: string;
  readonly stopReason: WorkspaceRuntimeInstanceStopReason;
}) => Promise<WorkspaceStopOutcome>;

/**
 * What stays Boat's own once its stop is the shared path's, swept every 30 s:
 *
 *  - **No VM.** A run whose create was never issued, or whose VM Boat never made: the shared stop
 *    never calls the adapter for a run that names no VM, so the conclusion that Boat holds none
 *    (`never-created`) and the release of its publication pin stay here. A create nobody can
 *    resolve is held for an operator, and its owner's discard ends the session while the run's
 *    row and its pin stay held.
 *  - **Cleanup.** A VM Boat no longer has, by its own committed word, whose gateway, tunnel slot
 *    or publication pin are not released yet: released here
 *    (`BoatRemoval.cleanup`, which never asks Boat anything and never sends DELETE). And a
 *    deletion Boat accepted whose operation is on record and not complete is polled here, so it
 *    ends whatever a read of the VM answers; that sends no DELETE either.
 *  - **The nudge.** A run that is stopping or failed and still has a VM: the shared stop is
 *    called for it, as the expiry reaper calls it. The nudge decides nothing: whether the VM is
 *    drained, kept, recovered or deleted is the shared path's decision, on its own evidence.
 *
 * One VM is deleted from here, on Core's own record that nothing ran on it: a VM adopted by its
 * labels after its run was already recorded stopped (a create whose reply was lost, found later),
 * which was never bound and which no stop will ever visit again.
 *
 * A VM kept because its FINAL cannot be confirmed is kept without bound, by design: nothing
 * discards it automatically. The sweep says so once an hour per kept run.
 */
export class BoatConvergence extends Context.Service<
  BoatConvergence,
  {
    readonly reconcile: (input: {
      readonly limit: number;
      readonly after?: string;
      readonly stop: BoatSharedStop;
    }) => Effect.Effect<BoatConvergenceSweep, BoatConvergenceError>;
  }
>()("@sealant/workspaces/boat/BoatConvergence") {}

/** How often a kept VM is reported, per run. */
export const BOAT_KEPT_REPORT_MS = 60 * 60_000;
/** Past this many remembered kept runs, the ones last reported more than a period ago are forgotten. */
const BOAT_KEPT_REMEMBERED = 1_024;

type Dependencies =
  | BoatRunRepo
  | NativePublicationRepo
  | WorkspaceRuntimeInstanceRepo
  | WorkspaceCaptureDrainRepo
  | BoatRemoval
  | BoatResourcesHost;

const make: Effect.Effect<BoatConvergence["Service"], never, Dependencies> = Effect.gen(
  function* () {
    const runs = yield* BoatRunRepo;
    const catalog = yield* NativePublicationRepo;
    const runtimes = yield* WorkspaceRuntimeInstanceRepo;
    const canonical = yield* WorkspaceCaptureDrainRepo;
    const removal = yield* BoatRemoval;
    const host = yield* BoatResourcesHost;
    /** When each kept run was last reported. This process only. */
    const reported = new Map<string, number>();

    /** Says once an hour that a run's VM is kept, and why, for as long as it is. */
    const reportKept = (run: BoatRun) =>
      Effect.gen(function* () {
        const { runId } = run;
        const now = yield* Clock.currentTimeMillis;
        const last = reported.get(runId);
        if (last !== undefined && now - last < BOAT_KEPT_REPORT_MS) return;
        if (reported.size >= BOAT_KEPT_REMEMBERED)
          for (const [id, at] of reported) if (now - at >= BOAT_KEPT_REPORT_MS) reported.delete(id);
        reported.set(runId, now);
        const record = yield* canonical
          .getByRunId(runId)
          .pipe(Effect.orElseSucceed(() => undefined));
        const since = record?.retainedAt ?? record?.observedAt;
        yield* Effect.logWarning(
          `Boat convergence · run ${runId}: its VM ${run.sandboxId ?? "unknown"} is kept${
            since == null ? "" : ` (as last recorded ${since.toISOString()})`
          }: ${record?.detail ?? "its work is not confirmed saved"}. Nothing removes it until its final capture is confirmed saved or its owner discards it; it is paid for meanwhile.`,
        );
      });

    /**
     * The capture record of a launch Boat never made a VM for: the shared stop never reaches the
     * adapter for it, so its end is recorded here. Nothing ran, so nothing is saved or lost beyond
     * what the record already says; the kept capture token is cleared with it.
     */
    const endCaptureWithoutVm = (runId: string) =>
      Effect.gen(function* () {
        const record = yield* canonical.getByRunId(runId);
        if (record === undefined) return;
        const state = record.discardRequestedAt === null ? "gone" : "discarded";
        if (
          record.state === state &&
          record.retainedAt === null &&
          record.captureTokenSealed === null
        )
          return;
        yield* canonical.recordObservation({
          runId,
          state,
          detail:
            state === "discarded"
              ? "Boat made no VM for this launch; its owner discarded it."
              : "Boat made no VM for this launch: nothing ran, and there was nothing to save.",
        });
      });

    /**
     * Releases the publication pins no VM will ever discharge: runs that never got a Boat row (a
     * failed or abandoned native build, a stop first) and are over. Idempotent.
     */
    const releaseEndedPins = Effect.gen(function* () {
      const ended = yield* catalog
        .endedUnallocatedConsumers({ deploymentId: host.deploymentId, limit: 20 })
        .pipe(Effect.orElseSucceed(() => []));
      for (const { consumer, publicationId } of ended) {
        // The guarded release keeps the catalog's lock order and refuses anything still pinned.
        const result = yield* Effect.exit(catalog.release(consumer, publicationId));
        if (!Exit.isSuccess(result))
          yield* Effect.logWarning(
            `Boat discharge · run ${consumer.runId}: its ended, unallocated publication pin was not released; retried on the next pass.`,
            result.cause,
          );
      }
    });

    const step = Effect.fn("BoatConvergence.step")(function* (id: string, stop: BoatSharedStop) {
      const found = yield* runs.get(id);
      if (found === undefined || found.deploymentId !== host.deploymentId)
        return "skipped" as const;
      // Boat accepted a deletion of this VM and its operation is on record: it is polled here,
      // whatever Boat's GET says of the VM. One never seen past creation reads 404 as still being
      // created, so presence alone would hold it for good. The removal then only polls: it sends
      // no DELETE, and releases what the VM held once Boat says the operation completed.
      if (
        found.deletionOperationId !== null &&
        found.absentAt === null &&
        (yield* removal.remove(found)) === "deleting"
      )
        return "draining" as const;
      const run = (yield* runs.get(id)) ?? found;
      const { runId } = run;
      const instance = yield* runtimes.getRuntimeInstanceByRunId(runId);
      const stopping =
        instance?.adapter === "boat" &&
        (instance.stopReason !== null || instance.status === "failed");
      /** The shared stop, for a run it has not ended yet. */
      const nudge = (reason: WorkspaceRuntimeInstanceStopReason) =>
        Effect.tryPromise(() => stop({ runId, stopReason: reason })).pipe(
          Effect.tap((outcome) => (outcome === "kept" ? reportKept(run) : Effect.void)),
        );

      if (run.sandboxId === null) {
        if (run.heldReason === "create-unresolved") {
          // Nobody can say whether Boat holds a VM for this launch; discovery keeps looking and
          // adopts one if it appears. The owner's discard is the person's exit: the session ends
          // with its work reported discarded, while the run's row and its pin stay held.
          const record = yield* canonical.getByRunId(runId);
          if (record?.discardRequestedAt != null) {
            yield* runtimes.markStopped({ runId, stopReason: "user" });
            if (record.state !== "discarded")
              yield* canonical.recordObservation({
                runId,
                state: "discarded",
                detail:
                  "The owner discarded this launch while Boat could not say whether its create made a VM.",
              });
          }
          yield* Effect.logWarning(
            `Boat convergence · run ${runId}: create was issued more than Boat's key retention ago and no VM carries its labels; it is held for an operator until a VM is found or the owner discards it.`,
          );
          return "held" as const;
        }
        let ended = run;
        if (run.absentAt === null) {
          // Stopped before create was ever issued: Boat was never asked for a VM, which is Core's
          // own record. Anything else without a VM is a launch still resolving its create, which
          // the VM sweep owns.
          if (run.heldReason !== "run-stopped") return "skipped" as const;
          ended = yield* runs.recordNeverCreated(runId);
        }
        // Boat holds no VM for the launch, by its own word or because it was never asked.
        const cleaned = yield* removal.cleanup(ended);
        yield* endCaptureWithoutVm(runId);
        // The run names no VM, so the shared stop only records it stopped.
        if (
          instance !== undefined &&
          stopping &&
          instance.status !== "stopped" &&
          !(yield* runs.launchInFlight(id))
        )
          yield* nudge(instance.stopReason ?? "failed");
        return cleaned === "removed" ? ("cleaned" as const) : ("discharging" as const);
      }

      // Boat no longer has the VM (its own committed 404, or its deletion operation recorded
      // complete): what the VM held is released. Nothing is asked of Boat and nothing is deleted.
      // A run still recorded live is left to the exit reconciler, which records what became of
      // it first (and calls the adapter, which cleans up the same way).
      const gone = run.absentAt !== null;
      const live = instance?.adapter === "boat" && !stopping && instance.status !== "stopped";
      const cleaned = gone && !live ? yield* removal.cleanup(run) : undefined;

      if (instance?.adapter !== "boat")
        return cleaned === "removed" ? ("cleaned" as const) : ("skipped" as const);
      // A live launch owns its run and VM until it finishes or its lease lapses. An explicit
      // stop reaches it through the stop worker, and a launch its worker lost is adopted by the
      // shared stranded-launch sweep.
      if (yield* runs.launchInFlight(id)) return "skipped" as const;

      if (stopping && instance.status !== "stopped") {
        // Stopping, or failed and so never to be ready: its desired state is stopped. The shared
        // stop drains it, keeps it, recovers it or deletes it; this only asks.
        return yield* nudge(instance.stopReason ?? "failed");
      }
      if (cleaned !== undefined)
        return cleaned === "removed"
          ? ("cleaned" as const)
          : cleaned === "discharging"
            ? ("discharging" as const)
            : ("skipped" as const);
      if (instance.status !== "stopped" || gone) return "skipped" as const;

      // The run is recorded stopped and Boat still has a VM for it, which no stop will visit
      // again. A retained one is its recovery's.
      const record = yield* canonical.getByRunId(runId);
      if (record?.retainedAt != null) return "skipped" as const;
      if (run.target === null) {
        // Adopted by its labels after the run ended (a create whose reply was lost): never bound,
        // so no launch was pushed and nothing ran on it. The removal deletes it on that record
        // alone, and refuses anything a daemon may have run on.
        const removed = yield* removal.remove(run);
        return removed === "removed"
          ? ("cleaned" as const)
          : removed === "discharging"
            ? ("discharging" as const)
            : ("draining" as const);
      }
      yield* reportKept(run);
      return "held" as const;
    });

    const reconcile = Effect.fn("BoatConvergence.reconcile")(function* (
      input: Parameters<BoatConvergence["Service"]["reconcile"]>[0],
    ) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)
        return yield* Effect.fail(new BoatConvergenceError("invalid-page"));
      // Pins with no Boat row are no VM's to discharge; release the ones whose run is over.
      yield* releaseEndedPins;
      const ids = yield* runs
        .list({
          deploymentId: host.deploymentId,
          limit: input.limit,
          ...(input.after === undefined ? {} : { after: input.after }),
        })
        .pipe(Effect.mapError(() => new BoatConvergenceError("unavailable")));
      const entries = yield* Effect.forEach(
        ids,
        (id) =>
          step(id, input.stop).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Boat convergence · run ${id}: this pass could not settle it; the next one tries again.`,
                error,
              ).pipe(Effect.as("unavailable" as const)),
            ),
            Effect.map((outcome) => ({ runId: id, outcome })),
          ),
        { concurrency: 4 },
      );
      const last = ids.at(-1);
      return {
        entries,
        ...(ids.length === input.limit && last !== undefined ? { next: last } : {}),
      };
    });
    return BoatConvergence.of({ reconcile });
  },
);

/** Open assembly for tests that bring their own repositories and removal. */
export const boatConvergenceLayerNoDeps: Layer.Layer<BoatConvergence, never, Dependencies> =
  Layer.effect(BoatConvergence, make);

/** Shares the sealed execution owner; owns its repositories and the removal. */
export const boatConvergenceLayer: Layer.Layer<
  BoatConvergence,
  never,
  SealantDB | BoatExecution | BoatResourcesHost | BoatRemovalProvider | BoatAllocationProvider
> = boatConvergenceLayerNoDeps.pipe(
  Layer.provide(
    Layer.mergeAll(
      boatRemovalLayer,
      BoatRunRepoLive,
      NativePublicationRepoLive,
      WorkspaceCaptureDrainRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
    ),
  ),
);
