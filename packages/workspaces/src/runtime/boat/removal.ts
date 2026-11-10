import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  BoatRunRepo,
  BoatRunRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  NativePublicationRepo,
  NativePublicationRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type SealantDB,
} from "@sealant/db";
import { boatRunVmPhase, nativeArtifactConsumerSchema, type BoatRun } from "@sealant/validators";
import { Clock, Context, Effect, Exit, Layer, Ref, Result } from "effect";

import { BoatResourcesHost } from "../../worker/boat-resources.js";
import type { BoatApi, BoatDeletion } from "./api.js";
import { boatDeletionIdSchema, boatSandboxIdSchema, type BoatResult } from "./config.js";
import type { BoatExecution } from "./execution.js";
import type { BoatAllocationProvider } from "./provider.js";
import { BoatVm, boatVmLayer } from "./vm.js";

/**
 * Why a removal did not finish. `held`: the run is not this removal's to remove as it stands (it is
 * not stopping, its records disagree, its caller holds nothing that authorizes deleting a VM a
 * daemon may have run on, Boat answered for another VM or another operation). `unavailable`: Boat
 * or the database did not answer.
 *
 * `requested` says whether a DELETE may have reached Boat: this call sent one, another call's is
 * in flight, or an earlier call's operation is on record. `false` means this call sent Boat nothing
 * and knows of no deletion in progress, which is the only failure a caller may take for a
 * definitive refusal. `recorded` says Boat's deletion operation is on record: Boat accepted the
 * deletion, and what failed is only this call's reading of how far it is.
 */
export class BoatRemovalError extends Error {
  readonly _tag = "BoatRemovalError";
  constructor(
    readonly code: "held" | "unavailable",
    readonly requested: boolean,
    readonly recorded = false,
  ) {
    super(`Boat removal: ${code}`);
  }
}

export interface BoatRemovalOptions {
  /**
   * Whether the caller holds what authorizes deleting a VM a daemon may have run on: the capture
   * ledger's deletion ticket, the owner's discard, or the agent's own answer that there is nothing
   * to save. Asked only for such a VM, and only when a DELETE is about to be sent: a VM Boat no
   * longer has is only cleaned up, a recorded deletion operation is only polled, and a VM no
   * launch was ever pushed to (never bound, or its execution aborted) is the removal's own to
   * delete, by Core's own record that nothing ran on it. Absent: not authorized.
   */
  readonly authorized?: Effect.Effect<boolean>;
}

/**
 * How far Boat's deletion is. `absent`: Boat no longer has the VM, by a committed absence (its own
 * typed 404 for a VM seen past creation, or a deletion it completed earlier), whoever observed it
 * and at whatever point of this removal. `completed`: its deletion operation reads `completed`,
 * recorded on the run's row. `deleting`: Boat still says the deletion is in progress, or another
 * call's DELETE is out and its operation not complete, and no absence is committed. Both `absent`
 * and `completed` are the deletion's end.
 */
type BoatDeletionOutcome = "absent" | "completed" | "deleting";

/**
 * `removed`: Boat no longer has the VM and every obligation of it is discharged. `discharging`:
 * Boat no longer has the VM and an obligation (the gateway on another host, say) could not be
 * discharged on this pass; the next cleanup retries it alone. `deleting`: Boat still says the
 * deletion is in progress, and nothing was released.
 */
export type BoatRemovalOutcome = "removed" | "discharging" | "deleting";

/**
 * The one deletion of a Boat VM. It decides nothing about the work on the VM: its caller says
 * whether it holds what authorizes deleting one a daemon may have run on (`authorized`), and the
 * removal sends DELETE to such a VM only then. It is resumable from every point, and absence is
 * only ever Boat's own answer.
 *
 * In order: observe the VM; if Boat no longer has it, discharge and stop. If a deletion operation
 * is already on record, poll it and never send DELETE again. Otherwise check the authorization,
 * fence the run (hold a launch that may have been pushed, abort one that never was, freeze its
 * tunnel), claim the deletion on the run's row by one guarded statement, then send DELETE. The
 * claim serializes the first DELETE: of two calls with nothing on record, one sends it and the
 * other waits for what it records. The operation id is written to the row before any wait; the
 * wait for `completed` is bounded (20 s by default). `completed` is recorded with the VM's absence
 * in one statement, which also erases the sealed launch. Then what the VM held is released: the
 * gateway removed and the tunnel slot released if the run has one, then the publication pin.
 * Until the absence is committed nothing is.
 *
 * It is not the only observer of its own deletion. Boat answers 404 for the VM soon after a
 * DELETE, often while the operation still reads `processing`. The removal reads the VM itself
 * while it waits, and anything else that reads the VM then (the exit reconciler's `inspect`, a
 * second stop) commits that absence too and may discharge on it.
 * So once its DELETE is out, the removal takes a committed absence for the deletion's end wherever
 * it meets one: a row already absent, an operation that can no longer be recorded or polled, a
 * wait that ran out. It then releases what the VM held in the same call. Only the committed absence
 * counts: never a failed read, a timeout, or a 404 for a VM Boat was never seen to report past
 * creation.
 */
export class BoatRemoval extends Context.Service<
  BoatRemoval,
  {
    readonly remove: (
      run: BoatRun,
      options?: BoatRemovalOptions,
    ) => Effect.Effect<BoatRemovalOutcome, BoatRemovalError>;
    /**
     * Releases what a VM Boat no longer has still holds, and nothing else: nothing is read from
     * Boat, nothing is fenced and no DELETE is ever sent. `present`: no absence of the VM is
     * committed, so nothing was released.
     */
    readonly cleanup: (
      run: BoatRun,
    ) => Effect.Effect<"removed" | "discharging" | "present", BoatRemovalError>;
  }
>()("@sealant/workspaces/boat/BoatRemoval") {}

/** The root supplies the allocation account; this service never discovers credentials. */
export class BoatRemovalProvider extends Context.Service<
  BoatRemovalProvider,
  {
    readonly api: Pick<BoatApi, "deleteSandbox" | "getDeletion">;
    /**
     * How long one removal waits for Boat's deletion operation to complete, so the removal is
     * recorded by the call that issued it rather than a later pass. Default 20 s.
     */
    readonly deletionWaitMs?: number;
    /** How long a removal waits for the gateway host lock, and how often it tries. Default `BOAT_REMOVAL_FREEZE`. */
    readonly freeze?: { readonly waitMs: number; readonly pollMs: number };
  }
>()("@sealant/workspaces/boat/BoatRemovalProvider") {}

const DELETION_WAIT_MS = 20_000;
const DELETION_POLL_MS = 1_000;

/**
 * How long a removal waits to freeze its run's tunnel while a configuration of the same run is at
 * the gateway host, and how often it tries. The host lock is tried, never queued for, and it is
 * held across one gateway mutation (a few seconds of Docker calls, by a link job, the sweep or a
 * launch). Without the wait a stop that met one failed at once, before anything was asked of
 * Boat, and the VM waited for the next pass.
 */
export const BOAT_REMOVAL_FREEZE = { waitMs: 15_000, pollMs: 500 } as const;

/**
 * How long a claim on the first DELETE keeps every other call from sending one. A call that
 * claimed and vanished (its worker died before, or while, the DELETE was sent) may have reached
 * Boat: nothing sends another until this has passed, which is twice the longest one Boat request
 * can take, and then only after reading the exact owned VM from Boat again. A call whose DELETE
 * request ended without Boat's answer gives its claim up itself, so the next pass asks at once.
 */
export const BOAT_REMOVAL_CLAIM_MS = 180_000;

/** One Boat request: anything but Boat's own answer is unavailability. */
const call = <A>(request: () => Promise<BoatResult<A>>) =>
  Effect.tryPromise({ try: request, catch: () => "unavailable" as const }).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail("unavailable" as const),
    ),
  );

/** How far a removal got with Boat, for what its failure may be taken for. */
type Progress = "nothing-sent" | "sent" | "recorded";

type Dependencies =
  | BoatRunRepo
  | BoatTunnelRepo
  | WorkspaceRuntimeInstanceRepo
  | NativePublicationRepo
  | BoatResourcesHost
  | BoatRemovalProvider
  | BoatVm;

const make: Effect.Effect<BoatRemoval["Service"], never, Dependencies> = Effect.gen(function* () {
  const runs = yield* BoatRunRepo;
  const tunnels = yield* BoatTunnelRepo;
  const runtimes = yield* WorkspaceRuntimeInstanceRepo;
  const catalog = yield* NativePublicationRepo;
  const host = yield* BoatResourcesHost;
  const provider = yield* BoatRemovalProvider;
  const vm = yield* BoatVm;
  const waitMs = provider.deletionWaitMs ?? DELETION_WAIT_MS;
  const freezing = provider.freeze ?? BOAT_REMOVAL_FREEZE;

  /** The run as stored now: the caller's copy may predate a write of this removal's own. */
  const stored = (given: BoatRun) =>
    Effect.gen(function* () {
      const saved = yield* runs.get(given.runId);
      if (
        saved === undefined ||
        saved.deploymentId !== host.deploymentId ||
        saved.sandboxId !== given.sandboxId ||
        !isDeepStrictEqual(saved.target, given.target)
      )
        return yield* Effect.fail("held" as const);
      return saved;
    });
  /**
   * Whether Boat's absence of this exact VM is committed, by this removal or by any other observer
   * of it. The committed row only: a read of it that fails says nothing.
   */
  const absenceCommitted = (run: BoatRun) =>
    runs
      .get(run.runId)
      .pipe(
        Effect.map(
          (now) =>
            run.sandboxId !== null &&
            now !== undefined &&
            now.absentAt !== null &&
            now.sandboxId === run.sandboxId &&
            now.deploymentId === run.deploymentId,
        ),
      );
  /**
   * A step taken once DELETE is out (or its operation is on record) that failed: if Boat's absence
   * of the VM is committed meanwhile, that is the deletion's end and the failure does not matter.
   * Otherwise the failure stands.
   */
  const orAbsent =
    (run: BoatRun) =>
    <A, E>(step: Effect.Effect<A, E>): Effect.Effect<A | "absent", E> =>
      step.pipe(
        Effect.catch((error) =>
          absenceCommitted(run).pipe(
            Effect.orElseSucceed(() => false),
            Effect.flatMap((absent) =>
              absent ? Effect.succeed("absent" as const) : Effect.fail(error),
            ),
          ),
        ),
      );
  /**
   * Polls Boat's own deletion operation until it completes, the VM's absence is committed by
   * anyone, or the wait is spent. The wait bounds the whole loop, including a read still in
   * flight, so a slow provider cannot stretch a removal.
   */
  const awaitDeletion = (run: BoatRun, operation: BoatDeletion) =>
    Effect.gen(function* () {
      const latest = yield* Ref.make<BoatDeletion | "absent">(operation);
      const poll = Effect.gen(function* () {
        for (;;) {
          const last = yield* Ref.get(latest);
          if (last === "absent" || last.status === "completed") return;
          // Boat answers 404 for the VM before its operation reads `completed`, at times by more
          // than this whole wait. The removal reads the VM itself on every poll rather than wait
          // for another observer to: the exit reconciler reads a stopping run only now and then.
          // Absence is still only Boat's typed 404 for a VM seen past creation, and one already
          // committed is read from the row, with no call to Boat.
          if ((yield* vm.observe(run)).kind === "absent") return yield* Ref.set(latest, "absent");
          yield* Effect.sleep(DELETION_POLL_MS);
          const next = yield* call(() => provider.api.getDeletion(operation.id));
          if (
            next.id !== operation.id ||
            next.kind !== "sandbox" ||
            next.targetId !== operation.targetId
          )
            return yield* Effect.fail("held" as const);
          yield* Ref.set(latest, next);
        }
      });
      yield* poll.pipe(Effect.timeoutOption(waitMs));
      return yield* Ref.get(latest);
    });
  /**
   * Records Boat's deletion operation on the run's row, where it survives a worker restart,
   * before any wait. One operation per VM: another id is not this removal's. `completed` is
   * recorded with the VM's absence in the same statement, and never reverts. A row another pass
   * already recorded absent, on Boat's own 404, is returned as it is.
   */
  const record = (run: BoatRun, operation: BoatDeletion) =>
    Effect.gen(function* () {
      if (
        run.sandboxId === null ||
        operation.kind !== "sandbox" ||
        operation.targetId !== run.sandboxId
      )
        return yield* Effect.fail("held" as const);
      return yield* runs
        .recordDeletion(run.runId, {
          id: operation.id,
          sandboxId: run.sandboxId,
          completed: operation.status === "completed",
        })
        .pipe(
          Effect.catch((error) =>
            Effect.fail(error.code === "target-conflict" ? ("held" as const) : error),
          ),
        );
    });
  /**
   * Records the operation Boat answered with, before any wait, then waits its bound for
   * `completed` and records that. Says how far the deletion is.
   */
  const follow = (run: BoatRun, operation: BoatDeletion, progress: Ref.Ref<Progress>) =>
    Effect.gen(function* () {
      let saved = yield* record(run, operation);
      // Boat accepted the deletion and its operation is on record: from here on a failure is only
      // this call's reading of how far it is.
      yield* Ref.set(progress, "recorded");
      // Absent already, by another observer's word: nothing is left to wait for.
      if (saved.absentAt === null && operation.status !== "completed") {
        const settled = yield* awaitDeletion(saved, operation);
        if (settled !== "absent") saved = yield* record(saved, settled);
      }
      if (saved.deletionCompletedAt !== null) return "completed" as const;
      // Boat no longer has the VM by its own 404, committed while this removal recorded or polled.
      return saved.absentAt !== null || (yield* absenceCommitted(saved))
        ? ("absent" as const)
        : ("deleting" as const);
    });
  /**
   * The run is Boat's own row for this VM and is stopping (or its launch failed): the only run a
   * removal fences or deletes. The claim on the first DELETE requires the same.
   */
  const stopping = (run: BoatRun) =>
    Effect.gen(function* () {
      const instance = yield* runtimes.getRuntimeInstanceByRunId(run.runId);
      if (
        instance?.adapter !== "boat" ||
        instance.resourceId !== run.sandboxId ||
        instance.publicationId !== run.publicationId ||
        (instance.stopReason === null && instance.status !== "failed")
      )
        return yield* Effect.fail("held" as const);
    });
  /**
   * The run's tunnel reservation, if it has one this worker can settle. A run launched without
   * resources was never given one, and a deployment with no resource gateway, or another gateway
   * host, cannot settle one: the run is held.
   */
  const ownTunnel = (run: BoatRun) =>
    Effect.gen(function* () {
      const reservation = yield* tunnels.get(run.runId);
      if (reservation === undefined) return undefined;
      // Said on every pass that meets it: `held` alone does not name the missing setting.
      if (run.resources !== "none" && host.gateway === undefined)
        yield* Effect.logWarning(
          `Boat removal · run ${run.runId}: the run has a tunnel and this worker has no resource gateway, so nothing here can settle its tunnel; its VM is held until a worker with the gateway stops it.`,
        );
      if (
        run.target === null ||
        run.resources === "none" ||
        host.gateway === undefined ||
        !isDeepStrictEqual(reservation.binding, {
          target: run.target,
          gatewayHostId: host.gateway.hostId,
        })
      )
        return yield* Effect.fail("held" as const);
      return reservation;
    });
  /** Whether a launch may have been pushed to the VM: a daemon may have run on it. */
  const launched = (run: BoatRun) =>
    runs.get(run.runId).pipe(Effect.map((now) => now !== undefined && now.launchIssuedAt !== null));
  /**
   * Makes sure nothing can start on the VM again, by one statement on the run's row that competes
   * with the launch push: a launch that was pushed is held, its daemon left as it is, and one that
   * never was is never pushed, its bearer erased. The run's tunnel is frozen if it has one, waiting
   * out a configuration that holds the gateway host for its bound. A VM never bound owns no
   * exchange and no tunnel, and the claim that follows fences it against a concurrent binder.
   */
  const fence = (run: BoatRun) =>
    Effect.gen(function* () {
      if (run.target === null) {
        if ((yield* tunnels.get(run.runId)) !== undefined)
          return yield* Effect.fail("held" as const);
        return;
      }
      yield* ownTunnel(run);
      yield* runs.fence(run.runId);
      const closeId = randomUUID();
      const freezeBy = (yield* Clock.currentTimeMillis) + freezing.waitMs;
      for (;;) {
        // Read again each try: the mutation that held the lock settled its update on it.
        const reservation = yield* ownTunnel(run);
        if (reservation === undefined || reservation.closeId !== undefined) return;
        const frozen = yield* Effect.result(tunnels.freeze(reservation, closeId));
        if (Result.isSuccess(frozen)) return;
        // `operation-held` is the host lock, taken by a configuration at its gateway mutation.
        // Only this removal waits, and it lets nothing through meanwhile: the run is fenced and
        // the stop recorded, and a configuration reads both before it dispatches, again under
        // the lock. Every other failure, and the lock still held at the bound, fails.
        if (
          frozen.failure.code !== "operation-held" ||
          (yield* Clock.currentTimeMillis) >= freezeBy
        )
          return yield* Effect.fail(frozen.failure);
        yield* Effect.sleep(freezing.pollMs);
      }
    });
  /**
   * Whether the run is fenced, verified before anything is sent to Boat: it is stopping, and
   * nothing can start on the VM again. Everything the claim on the first DELETE will require is
   * checked here first, so a DELETE is never sent whose operation could not be recorded.
   */
  const fenced = (run: BoatRun) =>
    Effect.gen(function* () {
      yield* stopping(run);
      const now = yield* stored(run);
      const phase = boatRunVmPhase(now);
      if (now.target === null) {
        if (
          !["allocated", "held", "deleting"].includes(phase) ||
          (yield* tunnels.get(run.runId)) !== undefined
        )
          return yield* Effect.fail("held" as const);
        return;
      }
      if (!(phase === "bound" || phase === "deleting") || now.fencedAt === null)
        return yield* Effect.fail("held" as const);
      const reservation = yield* ownTunnel(now);
      // A launched run that may be linked has a tunnel: without its row nothing here can say its
      // gateway is fenced. A run launched without resources, or never launched, may have none.
      if (
        reservation === undefined
          ? now.launchIssuedAt !== null && now.resources !== "none"
          : reservation.closeId === undefined
      )
        return yield* Effect.fail("held" as const);
    });
  /**
   * Another call holds the claim on the first DELETE: this one sends nothing and waits, for the
   * same bound, for what that call brings about. Boat's absence of the VM committed, or its
   * deletion operation recorded complete, is the deletion's end; otherwise it is still deleting.
   */
  const awaitClaimant = (run: BoatRun) =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<BoatDeletionOutcome>("deleting");
      const poll = Effect.gen(function* () {
        for (;;) {
          const saved = yield* stored(run);
          if (saved.deletionCompletedAt !== null) return yield* Ref.set(seen, "completed");
          if (saved.absentAt !== null) return yield* Ref.set(seen, "absent");
          yield* Effect.sleep(DELETION_POLL_MS);
        }
      });
      yield* poll.pipe(Effect.timeoutOption(waitMs));
      return yield* Ref.get(seen);
    });

  /**
   * Runs one removal step. A failure before anything was asked of Boat says so (`requested`
   * false); from the DELETE on, or once an operation is on record, every failure is an outcome
   * nobody knows yet, and with the operation on record it is only how far Boat's deletion is.
   */
  const reporting = <A>(
    step: (
      progress: Ref.Ref<Progress>,
    ) => Effect.Effect<A, "held" | "unavailable" | { readonly _tag: string }>,
  ): Effect.Effect<A, BoatRemovalError> =>
    Effect.gen(function* () {
      const progress = yield* Ref.make<Progress>("nothing-sent");
      return yield* step(progress).pipe(
        Effect.catch((error) =>
          Ref.get(progress).pipe(
            Effect.flatMap((reached) =>
              Effect.fail(
                new BoatRemovalError(
                  error === "held" ? "held" : "unavailable",
                  reached !== "nothing-sent",
                  reached === "recorded",
                ),
              ),
            ),
          ),
        ),
      );
    });

  const deletion = (given: BoatRun, options: BoatRemovalOptions) =>
    reporting((progress) =>
      Effect.gen(function* () {
        const saved = yield* stored(given);
        // 1. Observe. A VM Boat no longer has needs no fence and no DELETE to end.
        const presence = yield* vm.observe(saved);
        if (presence.kind === "absent") return "absent" as const;
        // 2. DELETE was accepted earlier, by this worker or one before it: its operation is
        // polled. It decides before presence does, since a VM never seen past creation reads 404
        // as `creating` and presence alone could hold it forever.
        if (saved.deletionOperationId !== null) {
          const recorded = saved.deletionOperationId;
          yield* Ref.set(progress, "recorded");
          return yield* Effect.gen(function* () {
            const id = boatDeletionIdSchema.safeParse(recorded);
            if (!id.success) return yield* Effect.fail("held" as const);
            const operation = yield* call(() => provider.api.getDeletion(id.data));
            if (operation.id !== recorded) return yield* Effect.fail("held" as const);
            return yield* follow(saved, operation, progress);
          }).pipe(orAbsent(saved));
        }
        // 3. Nothing was sent, or its reply was lost. Absence and a timeout are never completion:
        // DELETE goes only to the exact owned VM Boat just returned. Foreign labels are never
        // touched; anything else is unknown.
        if (presence.kind !== "present")
          return yield* Effect.fail(
            presence.reason === "foreign" ? ("held" as const) : ("unavailable" as const),
          );
        const sandbox = boatSandboxIdSchema.safeParse(presence.sandbox.id);
        if (!sandbox.success || sandbox.data !== saved.sandboxId)
          return yield* Effect.fail("held" as const);
        // 4. Authorize, before any fence is written: a run that is not stopping is never touched,
        // and a VM a daemon may have run on is deleted only for a caller that holds what
        // authorizes it. A VM no launch was ever pushed to is this removal's own to delete.
        yield* stopping(saved);
        const authorized = options.authorized ?? Effect.succeed(false);
        let permitted = false;
        if (yield* launched(saved)) {
          permitted = yield* authorized;
          if (!permitted) return yield* Effect.fail("held" as const);
        }
        // 5. Fence, then verify it. A launch issued between the check above and the fence was
        // held by it: it is deleted only on the same authorization.
        yield* fence(saved);
        yield* fenced(saved);
        if (!permitted && (yield* launched(saved)) && !(yield* authorized))
          return yield* Effect.fail("held" as const);
        // 6. Claim the first DELETE. Of two calls with nothing on record, one sends it.
        const claimed = yield* runs.claimDeletion(saved.runId, BOAT_REMOVAL_CLAIM_MS);
        yield* Ref.set(progress, "sent");
        if (claimed === undefined) return yield* awaitClaimant(saved);
        // 7. DELETE. The operation id is recorded before waiting, so a crash mid-wait polls it.
        // From here on another observer may commit Boat's 404 at any point.
        return yield* call(() => provider.api.deleteSandbox(sandbox.data)).pipe(
          // The request ended without Boat's answer: the next call may ask again at once, after
          // reading the exact owned VM from Boat. A claim that could not be given up lapses.
          Effect.tapError(() => runs.lapseDeletionClaim(claimed).pipe(Effect.ignore)),
          Effect.flatMap((operation) => follow(claimed, operation, progress)),
          orAbsent(claimed),
        );
      }),
    );

  /**
   * Releases what a VM Boat no longer has still holds, against the committed absence alone;
   * without one, nothing is. Each obligation is idempotent and retried on its own. The gateway is
   * removed and its tunnel slot released first; the publication pin goes last, and only once
   * that is done.
   */
  const discharge = (given: BoatRun) =>
    reporting(() =>
      Effect.gen(function* () {
        const run = yield* stored(given);
        if (run.absentAt === null) return "present" as const;
        const settle = <A, E>(obligation: "tunnel" | "publication", effect: Effect.Effect<A, E>) =>
          Effect.exit(effect).pipe(
            Effect.tap((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : Effect.logWarning(
                    `Boat discharge · run ${run.runId}: ${obligation} is not settled yet; retried on the next pass.`,
                    exit.cause,
                  ),
            ),
            Effect.map(Exit.isSuccess),
          );
        const tunnelSettled = yield* settle(
          "tunnel",
          Effect.gen(function* () {
            const reservation = yield* tunnels.get(run.runId);
            if (reservation === undefined || reservation.released === true) return;
            // A slot recorded by another gateway host is that host's to clean; it is never
            // guessed. A deployment with no resource gateway has no host of its own to clean
            // one from.
            const gateway = host.gateway;
            if (gateway === undefined || reservation.binding.gatewayHostId !== gateway.hostId)
              return yield* Effect.fail("foreign-host" as const);
            const frozen =
              reservation.closeId === undefined
                ? yield* tunnels.freeze(reservation, randomUUID())
                : reservation;
            yield* gateway.tunnel.remove(frozen.binding.target);
            yield* tunnels.releaseAbsent(frozen);
          }),
        );
        if (!tunnelSettled) return "discharging" as const;
        const pinReleased = yield* settle(
          "publication",
          catalog.release(
            nativeArtifactConsumerSchema.parse({ runId: run.runId, runtimeInstanceId: run.runId }),
            run.publicationId,
          ),
        );
        return pinReleased ? ("removed" as const) : ("discharging" as const);
      }),
    );

  const remove = Effect.fn("BoatRemoval.remove")(function* (
    run: BoatRun,
    options: BoatRemovalOptions = {},
  ) {
    const outcome = yield* deletion(run, options);
    if (outcome === "deleting") return "deleting" as const;
    // Boat no longer has the VM: the removal is done whatever becomes of the cleanup, which the
    // next pass retries alone. A failure from here on is never a failure to remove it, and it is
    // what a caller that met another pass discharging the same run sees: said, never warned. A
    // cleanup that stays undone is the convergence sweep's to report, every tick.
    return yield* discharge(run).pipe(
      Effect.map((discharged) =>
        discharged === "removed" ? discharged : ("discharging" as const),
      ),
      Effect.catch((error) =>
        Effect.logInfo(
          `Boat removal · run ${run.runId}: Boat no longer has the VM, and what it held could not be discharged on this pass (${error.code}); the next pass retries it.`,
        ).pipe(Effect.as("discharging" as const)),
      ),
    );
  });

  const cleanup = Effect.fn("BoatRemoval.cleanup")(function* (run: BoatRun) {
    return yield* discharge(run);
  });

  return BoatRemoval.of({ remove, cleanup });
});

/** Open assembly for tests that bring their own repositories, VM owner and provider. */
export const boatRemovalLayerNoDeps: Layer.Layer<BoatRemoval, never, Dependencies> = Layer.effect(
  BoatRemoval,
  make,
);

/** Shares the sealed execution owner; owns its repositories and the VM owner. */
export const boatRemovalLayer: Layer.Layer<
  BoatRemoval,
  never,
  SealantDB | BoatExecution | BoatResourcesHost | BoatRemovalProvider | BoatAllocationProvider
> = boatRemovalLayerNoDeps.pipe(
  Layer.provide(
    Layer.mergeAll(
      boatVmLayer,
      BoatRunRepoLive,
      boatTunnelRepoLayer,
      NativePublicationRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
    ),
  ),
);
