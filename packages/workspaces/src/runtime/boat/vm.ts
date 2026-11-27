import { createHash } from "node:crypto";

import type { BoatFailureKind } from "@sealant/api-contracts";
import { BoatRunRepo, BoatRunRepoLive, BoatRunStoreError, type SealantDB } from "@sealant/db";
import {
  boatExecutionTargetSchema,
  boatRunInputSchema,
  boatRunVmPhase,
  type BoatExecutionTarget,
  type BoatRun,
  type BoatRunAbsentBasis,
  type BoatRunInput,
} from "@sealant/validators";
import { Cause, Clock, Context, Effect, Exit, Layer, Schedule } from "effect";
import { z } from "zod";

import { safeCommandTail } from "../../images/boat/command-diagnostics.js";
import type { BoatSandbox } from "./api.js";
import {
  BoatOwnership,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  type BoatApiError,
  type BoatResult,
} from "./config.js";
import { BoatExecution, type BoatExecutionService } from "./execution.js";
import {
  boatLaunchDiagnostic,
  boatLaunchSummary,
  type BoatLaunchDiagnostic,
} from "./launch-diagnostics.js";
import { BoatAllocationProvider, boatRunMatches } from "./provider.js";

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
  | BoatRunStoreError
  | Effect.Error<ReturnType<BoatExecutionService["exchange"]>>;

/**
 * One bounded page of the runs whose create is not resolved (`BoatRunRepo.listUnresolved`). The
 * caller retains next and wraps to the beginning only at the end.
 */
export interface BoatVmSweep {
  readonly entries: readonly {
    readonly runId: string;
    readonly outcome: "bound" | "pending" | "held" | "unavailable" | "deleted";
    /** Why a held run is held, where its row says. */
    readonly held?: NonNullable<BoatRun["heldReason"]>;
  }[];
  readonly next?: string;
}

/**
 * The sweep's entries an operator should hear about now. A read that failed (`unavailable`) and a
 * launch Boat holds more than one VM for (`allocation-conflict`) are said on every pass. Any other
 * held run stays as it is with nothing for anyone to do this pass (a create unresolved past Boat's
 * key retention, a run stopped before its create): it is said when first met and then once a
 * period (`due`). A launch still being created (`pending`) is never one of them.
 */
export const boatAllocationObligations = (
  entries: BoatVmSweep["entries"],
  due: (runId: string) => boolean,
): BoatVmSweep["entries"] =>
  entries.filter(
    (entry) =>
      entry.outcome === "unavailable" ||
      (entry.outcome === "held" && (entry.held === "allocation-conflict" || due(entry.runId))),
  );

/** What Boat says about one run's VM right now. Only `absent` is terminal. */
export type BoatPresence =
  | { readonly kind: "present"; readonly sandbox: BoatSandbox }
  | { readonly kind: "absent"; readonly basis: BoatRunAbsentBasis }
  | {
      readonly kind: "unknown";
      /**
       * `unreadable`: Boat did not answer conclusively. `creating`: a 404 before Boat ever reported
       * the VM past creation. `foreign`: Boat returned a VM without this launch's exact labels.
       * `no-sandbox`: the launch has no VM identity to read.
       */
      readonly reason: "unreadable" | "creating" | "foreign" | "no-sandbox";
      /** Boat's own answer, for diagnostics; never response text. */
      readonly error?: BoatApiError;
    };

/**
 * The VM of a run, as Boat has it. It makes the VM for a launch, finds the one Boat already made,
 * and is the only reader of whether Boat still has it.
 *
 * Never two VMs for one run. Create is issued once, by the launch that wins `create_issued_at`.
 * After that a VM is only ever found by the run's labels and adopted, or create is replayed under
 * the same idempotency key while Boat still holds the key. Past that window nothing is replayed:
 * discovery keeps looking and the run is held as `create-unresolved`.
 *
 * Absence comes from Boat alone: a typed 404 for a VM Boat had reported past creation, or sealant's
 * own record that create was never issued or was refused under the run's key. Never elapsed time,
 * a launch error or a lease.
 */
export interface BoatVmService {
  /**
   * For a launch: the run's VM, created or adopted, with its current boot bound as the run's
   * target and the bearer exchanged. Only a launch issues create and only a launch binds.
   */
  readonly prepare: (input: BoatRunInput) => Effect.Effect<BoatExecutionTarget, Failure>;
  /**
   * Outside a launch: resolves what a launch left unresolved, and nothing more. A create that was
   * issued and has no VM on record is discovered by label, or replayed under its key inside the
   * window, and the VM found is adopted; a run that stopped before create was issued is held as
   * `run-stopped`. It issues no first create, binds nothing and exchanges nothing: a VM nothing
   * launched on stays unbound, and is removed on sealant's own record that nothing ran on it. So it
   * reads only the runs with no VM on record and no absence committed; a run with a VM, and one
   * Boat no longer has, is never in its page.
   */
  readonly reconcile: (input: {
    readonly limit: number;
    readonly after?: string;
  }) => Effect.Effect<BoatVmSweep, BoatRunStoreError>;
  /**
   * Reads the run's VM from Boat and records what it said: its creation seen, or its absence.
   * A committed absence is returned without asking Boat again.
   */
  readonly observe: (run: BoatRun) => Effect.Effect<BoatPresence, BoatRunStoreError>;
}
/** Does not stage payloads, issue launches, start a daemon, delete a VM or release pins. */
export class BoatVm extends Context.Service<BoatVm, BoatVmService>()(
  "@sealant/workspaces/boat/BoatVm",
) {}

/**
 * How long after issuance create may be replayed under the same idempotency key: inside Boat's
 * 24-hour key retention, with an hour of margin for clock skew between the database and Boat.
 */
export const BOAT_CREATE_REPLAY_WINDOW_MS = 23 * 60 * 60_000;

/**
 * Boat's states while it is still accepting an asynchronous create (202, then `provisioned` and
 * `cloning`). A VM read only in these states may not be readable yet, so a 404 for it is unknown.
 */
const CREATING: ReadonlySet<BoatSandbox["state"]> = new Set([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
]);

/**
 * How long a launch's VM preparation may take, every attempt and the waits between them, unless
 * Boat is still copying the snapshot onto a VM it reports usable and that copy is moving.
 */
const PREPARE_BUDGET_MS = 120_000;
/**
 * The longest VM preparation waits for Boat to finish copying a snapshot onto the VM, while the
 * copy keeps moving (SLNT-1397). A VM from a large or newly built snapshot can take longer than
 * {@link PREPARE_BUDGET_MS}; the workspace's Docker cannot mount its overlays until the copy ends.
 * Under the SDK's ten minutes for a whole start, with room for readiness after it.
 */
const HYDRATION_LIMIT_MS = 6 * 60_000;
/** How long Boat's copy may go without progress before preparation stops waiting for it. */
const HYDRATION_STALL_MS = 90_000;

/** A create whose outcome sealant could not read at all. */
const uncertainCreate: BoatLaunchDiagnostic = {
  step: "create",
  errorClass: "BoatAllocationError",
  code: "allocation-pending",
};

/**
 * Boat's refusals of a launch's first create that prove it made no VM: the key, its permissions,
 * the account, billing and plan limits. The first create under a key is the only one sent with
 * it, so a refusal of it leaves nothing. A rate limit, a missing machine or no answer stay
 * ambiguous: the launch retries them.
 */
const DEFINITE_REFUSALS: ReadonlySet<BoatFailureKind> = new Set([
  "key-refused",
  "key-expired",
  "permission-missing",
  "sandbox-outside-key",
  "organization-mismatch",
  "account-suspended",
  "billing-required",
  "running-limit",
  "member-cap",
  "trial-restricted",
  "snapshot-allowance-full",
]);

/**
 * Boat refused a replay of a create for what the request itself names: its source snapshot is
 * gone. An earlier acceptance under the key would have been answered with its VM, so Boat holds
 * none. Nothing else proves that on a replay: Boat does not document that it looks the key up
 * before it checks limits, billing or the key itself, and a key can expire, or a running limit
 * fill, after Boat accepted the first create. Those stay ambiguous on a replay.
 */
const replayRejected = (error: BoatApiError) =>
  error.status !== null &&
  error.status >= 400 &&
  error.status < 500 &&
  ["snapshot_not_found", "snapshot_data_expired"].includes(error.code);

/** Boat refused a launch's first create outright (`DEFINITE_REFUSALS`, or its source is gone). */
const firstCreateRejected = (error: BoatApiError) =>
  replayRejected(error) ||
  (error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    error.boat !== undefined &&
    DEFINITE_REFUSALS.has(error.boat.kind));

const notFound = (error: BoatApiError) =>
  error.status === 404 && ["not_found", "sandbox_not_found"].includes(error.code);

/** The committed absence, whoever wrote it. */
const absence = (run: BoatRun) =>
  ({ kind: "absent", basis: run.absentBasis ?? "not-found" }) as const;

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
/** One Boat call a launch's VM preparation made: its step, how long it took, and whether the
 * preparation's budget ran out while it was still running. */
interface PrepareCall {
  readonly step: BoatLaunchDiagnostic["step"];
  readonly ms: number;
  readonly interrupted: boolean;
}

/** One attempt of a launch's VM preparation: what Boat said of the VM, and the calls it made. */
interface PrepareAttempt {
  /** When the attempt began, in ms since the preparation did. */
  readonly atMs: number;
  sandboxState?: BoatSandbox["state"];
  hydrated?: boolean;
  /** Boat's progress copying the snapshot onto the VM, as this attempt read it. */
  hydration?: { readonly phase: string; readonly percent: number | null };
  readonly calls: PrepareCall[];
}

/** A launch's VM preparation as it goes, attempt by attempt (SLNT-958). Steps, states, flags and
 * durations only: nothing a request or reply carried. */
interface PrepareTrace {
  readonly startedAt: number;
  readonly attempts: PrepareAttempt[];
  /** The last progress Boat reported copying the snapshot in, and when it changed (ms since start). */
  progress?: { readonly key: string; readonly atMs: number };
}

/**
 * When VM preparation stops waiting, in ms since it started: {@link PREPARE_BUDGET_MS}, or, while
 * Boat's copy of the snapshot onto a usable VM keeps moving, {@link HYDRATION_STALL_MS} after it
 * last moved, never past {@link HYDRATION_LIMIT_MS}.
 */
const prepareDeadlineMs = (trace: PrepareTrace) =>
  trace.progress === undefined
    ? PREPARE_BUDGET_MS
    : Math.max(
        PREPARE_BUDGET_MS,
        Math.min(HYDRATION_LIMIT_MS, trace.progress.atMs + HYDRATION_STALL_MS),
      );

const CurrentPrepareTrace = Context.Reference<PrepareTrace | undefined>(
  "@sealant/workspaces/boat/CurrentPrepareTrace",
  { defaultValue: () => undefined },
);

/** Records `effect` as a call of `step` on the current attempt of a launch's preparation, if any. */
const traced = <A, E, R>(step: BoatLaunchDiagnostic["step"], effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const entry = (yield* CurrentPrepareTrace)?.attempts.at(-1);
    if (entry === undefined) return yield* effect;
    const started = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          entry.calls.push({ step, ms: now - started, interrupted: Exit.hasInterrupts(exit) });
        }),
      ),
    );
  });

/** A duration in ms, in seconds to one decimal, for a log line. */
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const describeAttempt = (entry: PrepareAttempt, index: number) =>
  `attempt ${index + 1}: VM ${entry.sandboxState ?? "unread"}, hydrated ${
    entry.hydrated === undefined ? "unknown" : String(entry.hydrated)
  }${
    entry.hydration === undefined
      ? ""
      : ` (${entry.hydration.phase}${entry.hydration.percent === null ? "" : ` ${entry.hydration.percent} %`})`
  }; ${
    entry.calls.length === 0
      ? "no Boat call"
      : entry.calls
          .map((call) => `${call.step} ${call.ms} ms${call.interrupted ? " (still running)" : ""}`)
          .join(", ")
  }`;

/** The agent manifest digest the installation receipt recorded: what every bind request names. */
const manifestOf = (input: BoatRunInput) => {
  const publication = input.publication;
  const receipt = z
    .object({
      version: z.literal(4),
      agent: z.object({ manifestDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
    })
    .parse(JSON.parse(publication.evidence.receipt));
  if (
    hash(publication.evidence.receipt) !== publication.evidence.receiptHash ||
    publication.snapshot.receiptHash !== publication.evidence.receiptHash
  )
    throw new Error("receipt-mismatch");
  return receipt.agent.manifestDigest;
};

const make: Effect.Effect<
  BoatVmService,
  never,
  BoatRunRepo | BoatAllocationProvider | BoatExecution
> = Effect.gen(function* () {
  const runs = yield* BoatRunRepo;
  const { api, deploymentId, accountId } = yield* BoatAllocationProvider;
  /** The run is this account's: created under it, so every call for it uses this key. */
  const ours = (run: { readonly deploymentId: string; readonly accountId: string | null }) =>
    run.deploymentId === deploymentId && run.accountId === (accountId ?? null);
  const execution = yield* BoatExecution;
  const load = (runId: string) =>
    runs
      .get(runId)
      .pipe(
        Effect.flatMap((run) =>
          run === undefined
            ? Effect.fail(new BoatAllocationError("invalid-input"))
            : Effect.succeed(run),
        ),
      );

  const observe = Effect.fn("sealant.boat.observe_vm")(function* (given: BoatRun) {
    const run = (yield* runs.get(given.runId)) ?? given;
    if (run.absentAt !== null) return absence(run);
    if (run.sandboxId === null) return { kind: "unknown", reason: "no-sandbox" } as const;
    const id = boatSandboxIdSchema.safeParse(run.sandboxId);
    if (!id.success) return { kind: "unknown", reason: "foreign" } as const;
    const read = yield* traced(
      "observe-sandbox",
      Effect.tryPromise(() => api.get(id.data)),
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (read === undefined) return { kind: "unknown", reason: "unreadable" } as const;
    if (read.ok) {
      if (read.value.id !== id.data || !boatRunMatches(run, read.value))
        return { kind: "unknown", reason: "foreign" } as const;
      const seen = yield* runs.seen(run.runId, id.data, !CREATING.has(read.value.state));
      // Another observer may have committed absence while this read was in flight; it stands.
      return seen.absentAt !== null
        ? absence(seen)
        : ({ kind: "present", sandbox: read.value } as const);
    }
    if (!notFound(read.error))
      return { kind: "unknown", reason: "unreadable", error: read.error } as const;
    // A 404 before Boat ever reported the VM past creation may be Boat not yet able to read it.
    const recorded = yield* runs.recordNotFound(run.runId, id.data);
    return recorded.absentAt !== null
      ? absence(recorded)
      : ({ kind: "unknown", reason: "creating", error: read.error } as const);
  });

  /**
   * Resolves the run's create to a VM on record, and returns the run. `launch`: the launch that
   * may issue create; without it create is never issued for the first time.
   */
  const resolve = Effect.fn("sealant.boat.resolve_create")(function* (
    runId: string,
    launch: BoatRunInput | undefined,
  ) {
    const run = yield* load(runId);
    if (!ours(run)) return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
    const phase = boatRunVmPhase(run);
    const unresolved = run.heldReason === "create-unresolved";
    if (["held", "deleting", "deleted"].includes(phase) && !unresolved)
      return yield* Effect.fail(new BoatAllocationError("allocation-held"));
    if (phase === "reserved" && !(yield* runs.isActive(runId))) {
      yield* runs.hold(runId, "run-stopped");
      return yield* Effect.fail(new BoatAllocationError("allocation-held"));
    }
    if (phase !== "reserved" && phase !== "issued" && !unresolved) return run;
    const ownership = yield* attempt(() => {
      const parsed = BoatOwnership.parse({
        deploymentId: run.deploymentId,
        workspaceId: run.workspaceId,
        runId: run.runId,
        runtimeInstanceId: run.runId,
        launchAttemptId: run.launchAttemptId,
        sourceId: run.publicationId,
      });
      if (!parsed.ok) throw new Error();
      return parsed.value;
    });
    // The same request every time: the key, the labels and the snapshot frozen on the row.
    const from = yield* attempt(() => boatSnapshotNameSchema.parse(run.snapshotName));
    const create = () =>
      api.create({
        idempotencyKey: run.idempotencyKey,
        ownership,
        lifetime: { kind: "production-session" },
        from,
      });
    if (phase === "reserved") {
      // Only its launch issues a run's create: a sweep has no launch to make a VM for.
      if (launch === undefined)
        return yield* Effect.fail(new BoatAllocationError("allocation-pending"));
      const expected = launch.publication.snapshot.identity;
      const snapshot = yield* traced(
        "read-source",
        provider("read-source", () => api.getSnapshot(expected.name)),
      );
      if (
        snapshot.status !== "ready" ||
        snapshot.name !== expected.name ||
        snapshot.sourceSandboxId !== expected.sourceSandboxId ||
        snapshot.createdAt !== expected.createdAt ||
        snapshot.snapshotId !== expected.snapshotId
      )
        return yield* Effect.fail(new BoatAllocationError("source-mismatch"));
      // Only the winner of this statement may issue create. Redelivery after it only discovers.
      yield* runs.issueCreate(runId);
      const reply = yield* traced("create", Effect.tryPromise(create)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (reply === undefined || !reply.ok) {
        const diagnostic =
          reply === undefined ? uncertainCreate : boatLaunchDiagnostic(reply.error, "create");
        // A definite refusal of the only create sent under this key: Boat holds no VM for it.
        // Recorded now, because a replay's refusal could not prove it. Unless a sweep marked a
        // replay first (the run was stopped, or this launch's lease lapsed, while create was out):
        // that replay may make the VM once Boat releases the key, and the run stays tracked.
        if (reply !== undefined && firstCreateRejected(reply.error)) {
          yield* runs.recordFirstCreateRefused(runId);
          return yield* Effect.fail(new BoatAllocationError("provider-unavailable", diagnostic));
        }
        // Boat may have accepted it (a lost reply, a 5xx). The launch keeps its row: its next
        // attempt finds the VM by label, or replays under the same key, and continues.
        return yield* Effect.fail(new BoatAllocationError("allocation-pending", diagnostic));
      }
      if (!boatRunMatches(run, reply.value))
        return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
      return yield* runs.adopt(runId, reply.value.id);
    }
    const discovered = yield* traced(
      "discover",
      Effect.tryPromise({
        try: () => api.discover(ownership),
        catch: (error) =>
          new BoatAllocationError("provider-unavailable", boatLaunchDiagnostic(error, "discover")),
      }),
    );
    if (discovered.kind === "conflict") {
      const conflictingSandboxes = [
        ...new Set(
          discovered.matches
            .filter((sandbox) => boatRunMatches(run, sandbox))
            .map((sandbox) => sandbox.id),
        ),
      ];
      if (conflictingSandboxes.length < 2 || conflictingSandboxes.length > 200)
        return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
      if (phase === "issued") yield* runs.hold(runId, "allocation-conflict", conflictingSandboxes);
      return yield* Effect.fail(new BoatAllocationError("allocation-held"));
    }
    if (discovered.kind === "unknown" && discovered.reason === "inventory-unavailable")
      return yield* Effect.fail(
        new BoatAllocationError(
          "provider-unavailable",
          boatLaunchDiagnostic(discovered.error, "discover"),
        ),
      );
    let sandbox = discovered.kind === "found" ? discovered.sandbox : undefined;
    if (sandbox === undefined) {
      // Boat keeps an idempotency key for 24 hours. Past that, a replay could create a second VM
      // beside one it accepted earlier, and a refusal proves nothing about that one. Only label
      // discovery is safe then; with nothing found the outcome stays unknown, surfaced as held
      // for an operator, whose exit is the owner's discard. The age is the database's: issued by
      // its `now()`, read against its `now()`, so a worker's clock cannot stretch the window, and
      // an issue time in the future (which the table refuses) never allows a replay.
      const age = yield* runs.createAgeMs(runId);
      if (age === undefined || age < 0 || age >= BOAT_CREATE_REPLAY_WINDOW_MS) {
        if (phase === "issued") yield* runs.hold(runId, "create-unresolved");
        return yield* Effect.fail(
          new BoatAllocationError("allocation-held", {
            step: "discover",
            errorClass: "BoatAllocationError",
            code: "allocation-held",
          }),
        );
      }
      // No VM carries this launch's labels: its create reply was lost, Boat has not listed it
      // yet, or create was never sent. Replay create under the same idempotency key. Boat answers
      // with the VM it already accepted for that key, or creates it now; either way sealant ends
      // with a positive identity, never an inference from an empty list or elapsed time.
      // The replay is marked on the row before it is sent, and only on a row not yet absent: a
      // refusal of the first create recorded meanwhile stops it, and once marked that refusal no
      // longer records absence. Whichever commits first wins, so the run is never recorded absent
      // while a replay may make its VM.
      const marked = yield* runs.markReplay(runId);
      if (marked.absentAt !== null)
        return yield* Effect.fail(
          new BoatAllocationError("allocation-held", {
            step: "create",
            errorClass: "BoatAllocationError",
            code: "allocation-held",
          }),
        );
      const replay = yield* traced("create", Effect.tryPromise(create)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (
        phase === "issued" &&
        replay !== undefined &&
        !replay.ok &&
        replayRejected(replay.error)
      ) {
        // A definite refusal of this key: an earlier acceptance would have been replayed, so
        // Boat holds no VM for the launch.
        yield* runs.recordNeverCreated(runId);
        return yield* Effect.fail(
          new BoatAllocationError("allocation-held", boatLaunchDiagnostic(replay.error, "create")),
        );
      }
      if (replay === undefined || !replay.ok)
        return yield* Effect.fail(
          new BoatAllocationError(
            "allocation-pending",
            replay === undefined ? uncertainCreate : boatLaunchDiagnostic(replay.error, "create"),
          ),
        );
      sandbox = replay.value;
    }
    if (!boatRunMatches(run, sandbox))
      return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
    return yield* runs.adopt(runId, sandbox.id);
  });

  /** A launch's drive: the VM on record, read from Boat, bound to its current boot, exchanged. */
  const drive = Effect.fn("sealant.boat.acquire_vm")(function* (input: BoatRunInput) {
    let run = yield* resolve(input.consumer.runId, input);
    if (run.sandboxId === null)
      return yield* Effect.fail(new BoatAllocationError("allocation-pending"));
    const sandboxId = boatSandboxIdSchema.parse(run.sandboxId);
    // Read through `observe`: it records what Boat said, the one source of presence.
    const presence = yield* observe(run).pipe(
      Effect.mapError(() => new BoatRunStoreError("unavailable")),
    );
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
    const trace = yield* CurrentPrepareTrace;
    const current = trace?.attempts.at(-1);
    if (trace !== undefined && current !== undefined) {
      current.sandboxState = observed.state;
      if (observed.hydrated !== undefined) current.hydrated = observed.hydrated;
      const hydration = observed.hydration ?? undefined;
      if (hydration !== undefined && observed.hydrated === false && !CREATING.has(observed.state)) {
        current.hydration = { phase: hydration.phase, percent: hydration.percent };
        // Progress is any change in what Boat reports of the copy: its step, its count, its share.
        const key = `${hydration.phase}|${hydration.entriesDone}|${hydration.percent ?? ""}`;
        if (trace.progress?.key !== key) trace.progress = { key, atMs: current.atMs };
      }
    }
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
      if (run.target === null) yield* runs.hold(run.runId, "lifetime-unverified");
      return yield* Effect.fail(
        new BoatAllocationError("allocation-held", {
          ...observationDiagnostic,
          code: "allocation-held",
        }),
      );
    }
    // Boat reports a VM usable before every file of its snapshot is on its disk (`hydrated`). The
    // workspace's own Docker cannot mount overlays on its data root until then (SLNT-1397: the
    // readiness probe's `docker run` fails with `invalid argument`), so the launch waits for it.
    if (!["ready", "idle", "running"].includes(observed.state) || observed.hydrated === false)
      return yield* Effect.fail(
        new BoatAllocationError("allocation-pending", {
          ...observationDiagnostic,
          code: "allocation-pending",
        }),
      );
    if (!(yield* runs.isActive(run.runId)))
      return yield* Effect.fail(
        new BoatAllocationError("allocation-held", {
          ...observationDiagnostic,
          code: "run-stopped",
        }),
      );
    const reply = yield* traced(
      "read-boot-id",
      provider("read-boot-id", () =>
        api.execute(sandboxId, "/usr/bin/cat /proc/sys/kernel/random/boot_id", {
          timeoutSeconds: 10,
        }),
      ),
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
    if (run.target !== null && run.target.bootId !== bootId)
      return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
    if (run.target === null)
      run = yield* runs.bind(
        run.runId,
        boatExecutionTargetSchema.parse({
          deploymentId,
          workspaceId: run.workspaceId,
          runId: run.runId,
          runtimeInstanceId: run.runId,
          launchAttemptId: run.launchAttemptId,
          sourceId: run.publicationId,
          sandboxId,
          diskLineage: run.diskLineage,
          bootId,
          manifestDigest: run.manifestDigest,
        }),
      );
    if (run.target === null)
      return yield* Effect.fail(new BoatAllocationError("allocation-pending"));
    yield* traced("bind-exchange", execution.exchange(run.target));
    return run.target;
  });
  // Create is an asynchronous acceptance (202). The row is read again on each attempt, so a retry
  // never replays issuance from what an earlier attempt read. Each attempt is traced: what Boat
  // said of the VM and how long each call took, logged as it ends, and the step the budget ran
  // out in names the timeout (SLNT-958).
  const prepared = (input: BoatRunInput) =>
    Effect.gen(function* () {
      const runId = input.consumer.runId;
      const trace: PrepareTrace = { startedAt: yield* Clock.currentTimeMillis, attempts: [] };
      const once = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        trace.attempts.push({ atMs: now - trace.startedAt, calls: [] });
        const index = trace.attempts.length - 1;
        return yield* drive(input).pipe(
          Effect.onExit((exit) => {
            const entry = trace.attempts[index];
            return entry === undefined || Exit.hasInterrupts(exit)
              ? Effect.void
              : Effect.logDebug(
                  `Boat launch · run ${runId}: VM preparation ${describeAttempt(entry, index)}; ${
                    Exit.isSuccess(exit) ? "prepared" : "not yet"
                  }.`,
                );
          }),
        );
      });
      // Stops the preparation at its deadline, which moves while Boat's copy of the snapshot onto
      // a usable VM keeps moving: it sleeps to the deadline it reads, and reads it again on waking.
      const deadline = Effect.gen(function* () {
        for (;;) {
          const elapsed = (yield* Clock.currentTimeMillis) - trace.startedAt;
          const at = prepareDeadlineMs(trace);
          if (elapsed >= at) return yield* Effect.fail(new Cause.TimeoutError());
          yield* Effect.sleep(at - elapsed);
        }
      });
      return yield* once.pipe(
        Effect.retry({
          schedule: Schedule.spaced("1 second"),
          // The deadline bounds the attempts; these are the answers worth another one.
          while: (error) =>
            error instanceof BoatAllocationError &&
            error.code === "allocation-pending" &&
            // A create whose outcome is unknown: the next attempt discovers or replays it.
            (error.diagnostic?.step === "create" ||
              (error.diagnostic?.step === "observe-sandbox" &&
                ((error.diagnostic.sandboxState !== undefined &&
                  CREATING.has(error.diagnostic.sandboxState)) ||
                  error.diagnostic.hydrated === false))),
        }),
        // How long Boat took to give a usable VM and to finish copying its snapshot in (SLNT-1397):
        // one line per launch, so a slow start shows without debug logging.
        Effect.tap(() =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const usable = trace.attempts.find(
              (entry) => entry.sandboxState !== undefined && !CREATING.has(entry.sandboxState),
            );
            const copying = trace.attempts.some((entry) => entry.hydrated === false);
            const copied = trace.attempts.find((entry) => entry.hydrated === true);
            yield* Effect.logInfo(
              `Boat launch · run ${runId}: VM prepared in ${seconds(now - trace.startedAt)} over ${trace.attempts.length} attempt${trace.attempts.length === 1 ? "" : "s"}${
                usable === undefined
                  ? ""
                  : `; Boat first reported it ${usable.sandboxState} at ${seconds(usable.atMs)}`
              }${
                copied === undefined
                  ? ""
                  : copying
                    ? `, its snapshot copied in at ${seconds(copied.atMs)}`
                    : ", its snapshot already copied in"
              }.`,
            );
          }),
        ),
        Effect.provideService(CurrentPrepareTrace, trace),
        Effect.raceFirst(deadline),
        Effect.catchIf(Cause.isTimeoutError, (error) =>
          Effect.gen(function* () {
            const elapsed = (yield* Clock.currentTimeMillis) - trace.startedAt;
            // The step the budget ran out in: a call still running, or else the last one made
            // (the attempts were waiting a second between them).
            const last = trace.attempts.at(-1);
            const call = last?.calls.at(-1);
            const step = call?.step ?? "observe-sandbox";
            const where =
              call === undefined
                ? "before any Boat call"
                : call.interrupted
                  ? `while ${step} was still running after ${call.ms} ms`
                  : `between attempts, the last ending at ${step}`;
            const slowest = trace.attempts
              .flatMap((entry) => entry.calls)
              .reduce<PrepareCall | undefined>(
                (worst, next) => (worst === undefined || next.ms > worst.ms ? next : worst),
                undefined,
              );
            // What Boat last said of the VM, so the launch's failure can say it in words.
            const seen = trace.attempts.findLast((entry) => entry.sandboxState !== undefined);
            const budget = prepareDeadlineMs(trace);
            const copy =
              trace.progress === undefined
                ? ""
                : budget >= HYDRATION_LIMIT_MS
                  ? ` (Boat was still copying the snapshot in; ${HYDRATION_LIMIT_MS / 1000} s is the most it waits for that)`
                  : ` (Boat's copy of the snapshot in made no progress for ${HYDRATION_STALL_MS / 1000} s)`;
            yield* Effect.logWarning(
              `Boat launch · run ${runId}: VM preparation ran out of its ${Math.round(budget / 1000)} s at ${step}, ${where}${copy}; ${trace.attempts.length} attempt${trace.attempts.length === 1 ? "" : "s"}${
                slowest === undefined ? "" : `, slowest call ${slowest.step} ${slowest.ms} ms`
              }. Last attempts: ${trace.attempts
                .slice(-3)
                .map((entry, offset) =>
                  describeAttempt(entry, Math.max(trace.attempts.length - 3, 0) + offset),
                )
                .join(" | ")}.`,
            );
            return yield* Effect.fail(
              new BoatAllocationError("allocation-pending", {
                ...boatLaunchDiagnostic(error, step),
                ...(seen?.sandboxState === undefined ? {} : { sandboxState: seen.sandboxState }),
                ...(seen?.hydrated === undefined ? {} : { hydrated: seen.hydrated }),
                ...(seen?.hydration === undefined
                  ? {}
                  : {
                      hydration: {
                        phase: seen.hydration.phase,
                        ...(seen.hydration.percent === null
                          ? {}
                          : { percent: seen.hydration.percent }),
                      },
                    }),
                waitedSeconds: Math.round(elapsed / 1000),
              }),
            );
          }),
        ),
      );
    });
  const prepare = Effect.fn("sealant.boat.prepare_vm")(function* (raw: BoatRunInput) {
    const input = yield* attempt(() => boatRunInputSchema.parse(raw));
    if (!ours({ deploymentId: input.deploymentId, accountId: input.accountId ?? null }))
      return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
    const manifestDigest = yield* attempt(() => manifestOf(input));
    const existing = yield* runs.get(input.consumer.runId);
    if (existing === undefined) {
      yield* runs.reserve(input, manifestDigest);
      return yield* prepared(input);
    }
    // Retries may not substitute another source, scope, workspace or launch.
    if (!(yield* runs.sameLaunch(input, manifestDigest)))
      return yield* Effect.fail(new BoatAllocationError("target-mismatch"));
    return yield* prepared(input);
  });
  const reconcile = Effect.fn("sealant.boat.reconcile_creates")(function* (
    input: Parameters<BoatVmService["reconcile"]>[0],
  ) {
    const ids = yield* runs.listUnresolved({
      deploymentId,
      limit: input.limit,
      ...(input.after === undefined ? {} : { after: input.after }),
    });
    const entries = yield* Effect.forEach(
      ids,
      (id) =>
        Effect.gen(function* () {
          const run = yield* load(id);
          if (run.absentAt !== null) return "deleted" as const;
          // A live launch owns its run until it finishes or its lease lapses.
          if (yield* runs.launchInFlight(id)) return "pending" as const;
          const resolved = yield* resolve(id, undefined);
          if (resolved.target !== null) return "bound" as const;
          // A VM on record that nothing bound: its launch binds it, or, once its run is over, its
          // stop removes it. Nothing is asked of it here.
          return (yield* runs.isActive(id)) ? ("pending" as const) : ("held" as const);
        }).pipe(
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
          Effect.flatMap((outcome) =>
            // Why it is held, as its row says now: a conflict is an operator's to look at.
            (outcome === "held" ? runs.get(id) : Effect.succeed(undefined)).pipe(
              Effect.orElseSucceed(() => undefined),
              Effect.map((held) => ({
                runId: id,
                outcome,
                ...(held?.heldReason == null ? {} : { held: held.heldReason }),
              })),
            ),
          ),
        ),
      { concurrency: 4 },
    );
    const last = ids.at(-1);
    return { entries, ...(ids.length === input.limit && last !== undefined ? { next: last } : {}) };
  });
  return BoatVm.of({ prepare, reconcile, observe });
});

/** Open assembly for the worker's sealed exchange and provider infrastructure. */
export const boatVmLayerNoDeps: Layer.Layer<
  BoatVm,
  never,
  BoatRunRepo | BoatAllocationProvider | BoatExecution
> = Layer.effect(BoatVm, make);
/** Owns its repository. The worker supplies the already composed exchange owner. */
export const boatVmLayer: Layer.Layer<
  BoatVm,
  never,
  SealantDB | BoatAllocationProvider | BoatExecution
> = boatVmLayerNoDeps.pipe(Layer.provide(BoatRunRepoLive));
