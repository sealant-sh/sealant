import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatAllocationStoreError,
  type SealantDB,
} from "@sealant/db";
import {
  boatAllocationInputSchema,
  boatExecutionTargetSchema,
  type BoatAllocationInput,
  type BoatAllocationRecord,
  type BoatExecutionTarget,
} from "@sealant/validators";
import { Cause, Context, Effect, Layer, Schedule } from "effect";
import { z } from "zod";

import { safeCommandTail } from "../../images/boat/command-diagnostics.js";
import {
  BoatOwnership,
  boatSandboxIdSchema,
  type BoatApiError,
  type BoatResult,
} from "./config.js";
import { BoatExecution, type BoatExecutionService } from "./execution.js";
import {
  boatLaunchDiagnostic,
  boatLaunchSummary,
  type BoatLaunchDiagnostic,
} from "./launch-diagnostics.js";
import { BoatObserver } from "./observation.js";
import { BoatAllocationProvider, boatAllocationMatches } from "./provider.js";

/** No provider response text crosses this failure boundary. Uncertain allocations remain pinned. */
export class BoatAllocationError extends Error {
  readonly _tag = "BoatAllocationError";
  constructor(
    readonly code:
      | "invalid-input"
      | "provider-unavailable"
      | "allocation-pending"
      | "allocation-held"
      | "source-mismatch"
      | "target-mismatch",
    readonly diagnostic?: BoatLaunchDiagnostic,
  ) {
    super(`Boat allocation: ${code}${boatLaunchSummary(diagnostic)}`);
  }
}
type Failure =
  | BoatAllocationError
  | BoatAllocationStoreError
  | Effect.Error<ReturnType<BoatExecutionService["exchange"]>>;
/** One bounded page. The caller retains next and wraps to the beginning only at the end. */
export interface BoatAllocationSweep {
  readonly entries: readonly {
    readonly runId: string;
    readonly outcome: "bound" | "pending" | "held" | "unavailable" | "deleted";
  }[];
  readonly next?: string;
}
/** Allocates held guests and connects their exact current boot to the sealed exchange owner. */
export interface BoatAllocationService {
  readonly prepare: (input: BoatAllocationInput) => Effect.Effect<BoatExecutionTarget, Failure>;
  readonly reconcile: (input: {
    readonly limit: number;
    readonly after?: string;
  }) => Effect.Effect<BoatAllocationSweep, BoatAllocationStoreError>;
}
/** Does not stage payloads, issue permits, start a daemon, stop disks or release pins. */
export class BoatAllocation extends Context.Service<BoatAllocation, BoatAllocationService>()(
  "@sealant/workspaces/boat/BoatAllocation",
) {}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const attempt = <A>(run: () => A) =>
  Effect.try({ try: run, catch: () => new BoatAllocationError("invalid-input") });
const provider = <A>(step: BoatLaunchDiagnostic["step"], run: () => Promise<BoatResult<A>>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new BoatAllocationError("provider-unavailable", boatLaunchDiagnostic(error, step)),
  }).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.value)
        : Effect.fail(
            new BoatAllocationError(
              "provider-unavailable",
              boatLaunchDiagnostic(result.error, step),
            ),
          ),
    ),
  );
const manifestOf = (input: BoatAllocationInput) => {
  const publication = input.publication;
  const receipt = z
    .object({
      version: z.literal(3),
      guest: z.object({ manifest: z.string(), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
    })
    .parse(JSON.parse(publication.evidence.receipt));
  if (
    hash(publication.evidence.receipt) !== publication.evidence.receiptHash ||
    publication.snapshot.receiptHash !== publication.evidence.receiptHash ||
    hash(receipt.guest.manifest) !== receipt.guest.manifestDigest
  )
    throw new Error("receipt-mismatch");
  return receipt.guest.manifestDigest;
};
const make: Effect.Effect<
  BoatAllocation["Service"],
  never,
  BoatAllocationRepo | BoatObserver | BoatAllocationProvider | BoatExecution
> = Effect.gen(function* () {
  const repo = yield* BoatAllocationRepo;
  const observer = yield* BoatObserver;
  const { api, deploymentId } = yield* BoatAllocationProvider;
  const execution = yield* BoatExecution;
  const load = (id: string) =>
    repo
      .get(id)
      .pipe(
        Effect.flatMap((record) =>
          record === undefined
            ? Effect.fail(new BoatAllocationError("invalid-input"))
            : Effect.succeed(record),
        ),
      );
  const drive = Effect.fn("BoatAllocation.drive")(function* (saved: BoatAllocationRecord) {
    let record = saved;
    const manifestDigest = yield* attempt(() => manifestOf(record.input));
    if (manifestDigest !== record.manifestDigest)
      return yield* Effect.fail(new BoatAllocationError("invalid-input"));
    const runId = record.input.consumer.runId;
    if (record.input.deploymentId !== deploymentId)
      return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
    if (["held", "deleting", "deleted"].includes(record.phase))
      return yield* Effect.fail(new BoatAllocationError("allocation-held"));
    if (record.phase === "reserved" && !(yield* repo.isActive(runId))) {
      yield* repo.advance(record, { ...record, phase: "held", reason: "run-stopped" });
      return yield* Effect.fail(new BoatAllocationError("allocation-held"));
    }
    const ownership = yield* attempt(() => {
      const parsed = BoatOwnership.parse({
        ...record.input,
        ...record.input.consumer,
        sourceId: record.input.publication.publicationId,
      });
      if (!parsed.ok) throw new Error();
      return parsed.value;
    });
    if (record.phase === "reserved") {
      const expected = record.input.publication.snapshot.identity;
      const snapshot = yield* provider("read-source", () => api.getSnapshot(expected.name));
      if (
        snapshot.status !== "ready" ||
        snapshot.name !== expected.name ||
        snapshot.sourceSandboxId !== expected.sourceSandboxId ||
        snapshot.createdAt !== expected.createdAt ||
        snapshot.snapshotId !== expected.snapshotId
      )
        return yield* Effect.fail(new BoatAllocationError("source-mismatch"));
      // Only the winner of this transition may issue create. Redelivery after it only discovers.
      record = yield* repo.advance(record, { ...record, phase: "issued" });
      const sandbox = yield* provider("create", () =>
        api.create({
          idempotencyKey: record.idempotencyKey,
          ownership,
          lifetime: { kind: "production-session" },
          from: expected.name,
        }),
      );
      if (!boatAllocationMatches(record, sandbox))
        return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
      record = yield* repo.advance(record, {
        ...record,
        phase: "allocated",
        sandboxId: sandbox.id,
      });
    } else if (record.phase === "issued") {
      const discovered = yield* Effect.tryPromise({
        try: () => api.discover(ownership),
        catch: (error) =>
          new BoatAllocationError("provider-unavailable", boatLaunchDiagnostic(error, "discover")),
      });
      if (discovered.kind === "conflict") {
        const conflictingSandboxes = [
          ...new Set(
            discovered.matches
              .filter((sandbox) => boatAllocationMatches(record, sandbox))
              .map((sandbox) => sandbox.id),
          ),
        ];
        if (conflictingSandboxes.length < 2 || conflictingSandboxes.length > 200)
          return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
        yield* repo.advance(record, {
          ...record,
          phase: "held",
          reason: "allocation-conflict",
          conflictingSandboxes,
        });
        return yield* Effect.fail(new BoatAllocationError("allocation-held"));
      }
      if (discovered.kind === "unknown" && discovered.reason === "inventory-unavailable")
        return yield* Effect.fail(new BoatAllocationError("provider-unavailable"));
      let sandbox = discovered.kind === "found" ? discovered.sandbox : undefined;
      if (sandbox === undefined) {
        // No VM carries this launch's labels: its create reply was lost, Boat has not listed it
        // yet, or create was never sent. Replay create under the same idempotency key. Boat answers
        // with the VM it already accepted for that key, or creates it now; either way Core ends
        // with a positive identity, never an inference from an empty list or elapsed time.
        const replay = yield* Effect.tryPromise(() =>
          api.create({
            idempotencyKey: record.idempotencyKey,
            ownership,
            lifetime: { kind: "production-session" },
            from: record.input.publication.snapshot.identity.name,
          }),
        ).pipe(Effect.orElseSucceed(() => undefined));
        if (replay !== undefined && !replay.ok && createRejected(replay.error)) {
          // A definite refusal of this key: an earlier acceptance would have been replayed, so
          // Boat holds no VM for the launch.
          yield* observer
            .neverCreated(record)
            .pipe(Effect.mapError(() => new BoatAllocationStoreError("unavailable")));
          yield* repo.advance(record, {
            ...record,
            phase: "deleted",
            removal: { kind: "never-created", completed: true },
          });
          return yield* Effect.fail(
            new BoatAllocationError(
              "allocation-held",
              boatLaunchDiagnostic(replay.error, "create"),
            ),
          );
        }
        if (replay === undefined || !replay.ok)
          return yield* Effect.fail(
            new BoatAllocationError(
              "allocation-pending",
              replay === undefined ? undefined : boatLaunchDiagnostic(replay.error, "create"),
            ),
          );
        sandbox = replay.value;
      }
      if (!boatAllocationMatches(record, sandbox))
        return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
      record = yield* repo.advance(record, {
        ...record,
        phase: "allocated",
        sandboxId: sandbox.id,
      });
    }
    if (record.sandboxId === null)
      return yield* Effect.fail(new BoatAllocationError("allocation-pending"));
    const sandboxId = boatSandboxIdSchema.parse(record.sandboxId);
    // Read through the observer: it records what Boat said, the one source of presence.
    const presence = yield* observer
      .observe(record)
      .pipe(Effect.mapError(() => new BoatAllocationStoreError("unavailable")));
    if (presence.kind === "absent")
      return yield* Effect.fail(
        new BoatAllocationError("allocation-held", {
          step: "observe-sandbox",
          errorClass: "BoatAllocationError",
          code: "sandbox-absent",
        }),
      );
    if (presence.kind === "unknown")
      return yield* Effect.fail(
        presence.reason === "foreign"
          ? new BoatAllocationError("target-mismatch", {
              step: "observe-sandbox",
              errorClass: "BoatAllocationError",
              code: "target-mismatch",
            })
          : new BoatAllocationError(
              "provider-unavailable",
              boatLaunchDiagnostic(presence.error, "observe-sandbox"),
            ),
      );
    const observed = presence.sandbox;
    const observationDiagnostic: BoatLaunchDiagnostic = {
      step: "observe-sandbox",
      errorClass: "BoatAllocationError",
      sandboxState: observed.state,
      ...(observed.hydrated === undefined ? {} : { hydrated: observed.hydrated }),
    };
    if (
      observed.autoStop.kind !== "disabled" ||
      observed.snapshots !== true ||
      observed.monitoring !== false
    ) {
      if (record.phase === "allocated")
        yield* repo.advance(record, { ...record, phase: "held", reason: "lifetime-unverified" });
      return yield* Effect.fail(
        new BoatAllocationError("allocation-held", {
          ...observationDiagnostic,
          code: "allocation-held",
        }),
      );
    }
    if (!["ready", "idle", "running"].includes(observed.state) || observed.hydrated === false)
      return yield* Effect.fail(
        new BoatAllocationError("allocation-pending", {
          ...observationDiagnostic,
          code: "allocation-pending",
        }),
      );
    if (!(yield* repo.isActive(runId)))
      return yield* Effect.fail(
        new BoatAllocationError("allocation-held", {
          ...observationDiagnostic,
          code: "run-stopped",
        }),
      );
    {
      const reply = yield* provider("read-boot-id", () =>
        api.execute(sandboxId, "/usr/bin/cat /proc/sys/kernel/random/boot_id", {
          timeoutSeconds: 10,
        }),
      );
      const bootId = yield* Effect.try({
        try: () => {
          if (
            reply.exitCode !== 0 ||
            reply.timedOut ||
            reply.stdout.length > 64 ||
            reply.stderr !== ""
          )
            throw new Error();
          return z.uuid().parse(reply.stdout.trim());
        },
        catch: (error) =>
          new BoatAllocationError("invalid-input", {
            ...boatLaunchDiagnostic(error, "read-boot-id"),
            command: {
              exitCode: reply.exitCode,
              timedOut: reply.timedOut,
              stdoutTail: safeCommandTail(reply.stdout),
              stderrTail: safeCommandTail(reply.stderr),
            },
          }),
      });
      if (record.target !== null && record.target.bootId !== bootId)
        return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
      if (record.phase === "allocated") {
        const target = boatExecutionTargetSchema.parse({
          deploymentId,
          workspaceId: record.input.workspaceId,
          ...record.input.consumer,
          launchAttemptId: record.input.launchAttemptId,
          sourceId: record.input.publication.publicationId,
          sandboxId,
          diskLineage: record.diskLineage,
          bootId,
          manifestDigest: record.manifestDigest,
        });
        record = yield* repo.advance(record, { ...record, phase: "bound", target });
      }
    }
    if (record.target === null)
      return yield* Effect.fail(new BoatAllocationError("allocation-pending"));
    yield* execution.exchange(record.target);
    return record.target;
  });
  // Create is an asynchronous acceptance (202). Re-read durable ownership on each observation;
  // retrying drive(savedReserved) would replay issuance from an obsolete pre-create record.
  const prepared = (id: string) =>
    load(id).pipe(
      Effect.flatMap(drive),
      Effect.retry({
        times: 119,
        schedule: Schedule.spaced("1 second"),
        while: (error) =>
          error instanceof BoatAllocationError &&
          error.code === "allocation-pending" &&
          error.diagnostic?.step === "observe-sandbox" &&
          (["init", "provisioning", "provisioned", "cloning"].includes(
            error.diagnostic.sandboxState ?? "",
          ) ||
            error.diagnostic.hydrated === false),
      }),
      Effect.timeout(120_000),
      Effect.mapError((error) =>
        Cause.isTimeoutError(error)
          ? new BoatAllocationError(
              "allocation-pending",
              boatLaunchDiagnostic(error, "observe-sandbox"),
            )
          : error,
      ),
    );
  const prepare = Effect.fn("BoatAllocation.prepare")(function* (raw: BoatAllocationInput) {
    const input = yield* attempt(() => boatAllocationInputSchema.parse(raw));
    if (input.deploymentId !== deploymentId)
      return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
    const manifestDigest = yield* attempt(() => manifestOf(input));
    const existing = yield* repo.get(input.consumer.runtimeInstanceId);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing.input, input) || existing.manifestDigest !== manifestDigest)
        return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
      return yield* prepared(input.consumer.runtimeInstanceId);
    }
    const saved = yield* repo.reserve({
      input,
      manifestDigest,
      idempotencyKey: randomUUID(),
      diskLineage: randomUUID(),
      phase: "reserved",
      sandboxId: null,
      conflictingSandboxes: [],
      target: null,
      reason: null,
    });
    return yield* prepared(saved.input.consumer.runtimeInstanceId);
  });
  const reconcile = Effect.fn("BoatAllocation.reconcile")(function* (
    input: Parameters<BoatAllocationService["reconcile"]>[0],
  ) {
    const ids = yield* repo.list({
      deploymentId,
      limit: input.limit,
      ...(input.after === undefined ? {} : { after: input.after }),
    });
    const entries = yield* Effect.forEach(
      ids,
      (id) =>
        load(id).pipe(
          Effect.flatMap((record) =>
            record.phase === "deleted"
              ? Effect.succeed("deleted" as const)
              : drive(record).pipe(Effect.as("bound" as const)),
          ),
          Effect.timeout(120_000),
          Effect.catch((error) =>
            Effect.succeed(
              error instanceof BoatAllocationError
                ? error.code === "allocation-held"
                  ? ("held" as const)
                  : error.code === "allocation-pending"
                    ? ("pending" as const)
                    : ("unavailable" as const)
                : ("unavailable" as const),
            ),
          ),
          Effect.map((outcome) => ({ runId: id, outcome })),
        ),
      { concurrency: 4 },
    );
    const last = ids.at(-1);
    return { entries, ...(ids.length === input.limit && last !== undefined ? { next: last } : {}) };
  });
  return BoatAllocation.of({ prepare, reconcile });
});
/** Open assembly for the worker's sealed exchange and provider infrastructure. */
/**
 * Boat refused a create outright: what it was asked for cannot be made (source snapshot gone,
 * account or plan limits, no machine). A replay under an accepted key is answered with that VM,
 * never with these, so they prove Boat holds no VM for the key.
 */
const createRejected = (error: BoatApiError) =>
  error.status !== null &&
  error.status >= 400 &&
  error.status < 500 &&
  [
    "snapshot_not_found",
    "snapshot_data_expired",
    "insufficient_balance",
    "machine_class_plan_required",
    "trial_auto_stop_required",
    "trial_saved_snapshots_not_allowed",
    "no_ready_machine",
  ].includes(error.code);
export const boatAllocationLayerNoDeps: Layer.Layer<
  BoatAllocation,
  never,
  BoatAllocationRepo | BoatObserver | BoatAllocationProvider | BoatExecution
> = Layer.effect(BoatAllocation, make);
/** Allocation owns its repository. The worker supplies the already composed exchange owner. */
export const boatAllocationLayer: Layer.Layer<
  BoatAllocation,
  never,
  SealantDB | BoatAllocationProvider | BoatExecution | BoatObserver
> = boatAllocationLayerNoDeps.pipe(Layer.provide(BoatAllocationRepoLive));
