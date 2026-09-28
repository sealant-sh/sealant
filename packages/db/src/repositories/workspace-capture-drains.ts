import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { nextUnsavedObservations, statusSupersedes } from "../capture-evidence-order.js";
import { SealantDB } from "../client.js";
import {
  workspaceCaptureDrains,
  workspaceRuntimeInstances,
  type NewWorkspaceCaptureDrain,
  type WorkspaceCaptureDrain,
  type WorkspaceCaptureDrainState,
} from "../schema.js";

const workspaceCaptureDrainRepoOperationSchema = Schema.Literals([
  "claimLease",
  "recordProgress",
  "releaseLease",
  "getByRunId",
  "listByRunIds",
  "recordSchedule",
  "recordObservation",
  "recordStatus",
  "requestDiscard",
  "attestCompletion",
  "markRetained",
  "listRetainedDue",
  "recordRecoveryAttempt",
  "claimRecovery",
  "releaseRecovery",
  "requestRecovery",
  "storeCaptureToken",
  "openObservation",
  "closeObservation",
  "authorizeDeletion",
  "confirmDeletion",
  "issueDeletion",
  "reconcileIssuedDeletion",
  "completeDeletion",
  "releaseDeletion",
  "lapseIssuedDeletion",
  "admitRecovery",
]);

type WorkspaceCaptureDrainRepoOperation = typeof workspaceCaptureDrainRepoOperationSchema.Type;

export class WorkspaceCaptureDrainRepoUnexpectedError extends Schema.TaggedErrorClass<WorkspaceCaptureDrainRepoUnexpectedError>()(
  "WorkspaceCaptureDrainRepoUnexpectedError",
  {
    operation: workspaceCaptureDrainRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type WorkspaceCaptureDrainRepoError = WorkspaceCaptureDrainRepoUnexpectedError;

const withRepoError = <A>(
  operation: WorkspaceCaptureDrainRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, WorkspaceCaptureDrainRepoError> =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof WorkspaceCaptureDrainRepoUnexpectedError
        ? cause
        : new WorkspaceCaptureDrainRepoUnexpectedError({
            operation,
            message: cause instanceof Error ? cause.message : `${operation} failed.`,
            cause,
          }),
    ),
  );

/**
 * The drain's progress and observation, written together on every drain iteration. The statuses
 * it reads are not part of it: every status is recorded as it is received (`recordStatus`), under
 * the observation fence opened before it was asked for.
 */
export interface WorkspaceCaptureDrainProgress {
  readonly state?: WorkspaceCaptureDrainState;
  readonly detail?: string | null;
  readonly lastProgressAt?: Date | null;
  readonly unreachableSince?: Date | null;
  readonly keptLogged?: boolean;
  readonly silentLogged?: boolean;
  readonly observedAt?: Date;
}

export interface WorkspaceCaptureDrainSchedule {
  readonly preservationStartsAt: Date | null;
  readonly uploadBytesPerSecond?: number | null;
  readonly uploadSampleBytes?: number | null;
  readonly uploadSampledAt?: Date | null;
}

export interface WorkspaceCaptureDrainRepoService {
  /**
   * Take (or renew) the run's drain lease for `owner`, for `leaseMs` of database time. Succeeds
   * when nobody holds it, the holder's lease expired (its worker died), or `owner` already holds
   * it; returns the row. Returns `undefined` while another owner's lease is live. Atomic: two
   * workers racing for one run get one row between them.
   */
  readonly claimLease: (input: {
    readonly runId: string;
    readonly owner: string;
    readonly leaseMs: number;
  }) => Effect.Effect<WorkspaceCaptureDrain | undefined, WorkspaceCaptureDrainRepoError>;
  /**
   * Write progress and renew the lease, fenced on `owner`: `undefined` when the lease was lost
   * (it expired and another worker took the run), and nothing is written.
   */
  readonly recordProgress: (input: {
    readonly runId: string;
    readonly owner: string;
    readonly leaseMs: number;
    readonly progress: WorkspaceCaptureDrainProgress;
  }) => Effect.Effect<WorkspaceCaptureDrain | undefined, WorkspaceCaptureDrainRepoError>;
  /** Give the lease up (fenced on `owner`); the observation stays. */
  readonly releaseLease: (input: {
    readonly runId: string;
    readonly owner: string;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  readonly getByRunId: (
    runId: string,
  ) => Effect.Effect<WorkspaceCaptureDrain | undefined, WorkspaceCaptureDrainRepoError>;
  readonly listByRunIds: (
    runIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, WorkspaceCaptureDrain>, WorkspaceCaptureDrainRepoError>;
  /**
   * Record an observation outside a drain (the stop that followed it failed or finished, or a
   * discard ended the runtime); the lease is untouched.
   */
  readonly recordObservation: (input: {
    readonly runId: string;
    readonly state: WorkspaceCaptureDrainState;
    readonly detail: string | null;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  /**
   * Mark an observation of the run's executor in flight, BEFORE the request is sent (review 6
   * #5): `token` names it until it is resolved — by `recordStatus` with its answer, or by
   * `closeObservation` when nothing was received. While any is unresolved, nothing Core holds of
   * the executor counts as current, and no deletion is authorized on it. It lapses `ttlMs` after
   * it was opened (the database's clock); a lapsed fence still counts until an observation opened
   * after it lapsed is recorded. Bumps the evidence version. Answers when it was opened.
   *
   * Refused while the executor's removal is held (`deleting`, decision 21: the deleter decided
   * on the evidence as it stood, and nothing asked after that is admitted before the runtime is
   * gone), once the runtime was asked to make it (`deleting-issued`, whatever its hold: review 8
   * #7) and once it was removed (`deleted`): nothing is opened, nothing may be asked. A removal
   * not yet issued whose hold lapsed (its deleter died) is voided by the observation it admits.
   */
  readonly openObservation: (input: {
    readonly runId: string;
    readonly token: string;
    readonly ttlMs: number;
  }) => Effect.Effect<
    { readonly openedAt: Date } | { readonly refused: "deleting" | "deleted" },
    WorkspaceCaptureDrainRepoError
  >;
  /** Resolve an observation under which nothing was received (the request failed first). */
  readonly closeObservation: (input: {
    readonly runId: string;
    readonly token: string;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  /**
   * Record a capture status Core received from the run's executor — a drain's, the public flush
   * and status routes', a probe's, a sampler's: every status Core receives is evidence about the
   * executor's disk, whoever asked (review 5 #3). `fence`: the observation it answers
   * (`openObservation`), resolved by this write, which also resolves every fence that lapsed
   * before it was opened. Ordered by the executor's own history, never by any process's clock
   * (`statusSupersedes`, review 6 #6): it replaces the stored status when its executor-origin
   * position is later, else when its request was sent after the stored one was recorded, else
   * — nothing orders them — only when that cannot make a complete out of an incomplete. Every
   * unsaved answer no answer recorded since covers is kept besides it (`unsaved_statuses`, review
   * 9 #4): an incomparable later answer never erases one. No `fence`: it is taken as read just now, after everything recorded before. `observedAt` is the
   * reader's clock, kept for display only. Bumps the evidence version whether or not it replaced
   * the stored status; answers whether it did. A removal still held (`deleting`) is voided: what
   * Core received about the executor outranks a decision taken before it. One already issued
   * (`deleting-issued`) cannot be revoked and stays; the bumped version keeps it from being issued
   * again on the old evidence (`reconcileIssuedDeletion`). Atomic under the row lock.
   */
  readonly recordStatus: (input: {
    readonly runId: string;
    readonly status: Readonly<Record<string, unknown>>;
    readonly observedAt: Date;
    readonly fence?: string;
  }) => Effect.Effect<boolean, WorkspaceCaptureDrainRepoError>;
  /**
   * Authorize the removal of the run's executor, decided on evidence version `evidenceVersion`
   * (decision 18), and take it as an owned durable transition in the same transaction (review 7
   * #5, decision 21): under the row lock, the version is still current, no observation is in
   * flight and no other deleter holds a live removal; then the row is `deleting`, held by `token`
   * for `leaseMs` (the database's clock). From then on no observation is admitted
   * (`openObservation`), no recovery starts the executor (`admitRecovery`), and a status
   * recorded anyway voids the removal.
   *
   * `authorized`: held by `token`. `changed`: the evidence moved (or is unresolved); decide again
   * on what is current. `held`: another deleter's removal is live — or was issued and its issuer
   * still holds it. `unresolved`: a removal was issued and its issuer's hold lapsed; nobody knows
   * whether the runtime carried it out until it is inspected (`reconcileIssuedDeletion`).
   * `deleted`: it was removed.
   */
  readonly authorizeDeletion: (input: {
    readonly runId: string;
    readonly evidenceVersion: number;
    readonly token: string;
    readonly leaseMs: number;
  }) => Effect.Effect<
    "authorized" | "changed" | "held" | "unresolved" | "deleted",
    WorkspaceCaptureDrainRepoError
  >;
  /**
   * Renew the hold of the removal `token` holds, for `leaseMs`. Before it was issued: only while
   * nothing voided it and the evidence it was authorized on is still the current version with no
   * observation in flight. Once issued (`deleting-issued`): while `token` still holds it — the
   * request is out, nothing voids it any more. `false`: not held (decide again, or it was taken
   * over).
   */
  readonly confirmDeletion: (input: {
    readonly runId: string;
    readonly token: string;
    readonly leaseMs: number;
  }) => Effect.Effect<boolean, WorkspaceCaptureDrainRepoError>;
  /**
   * RIGHT BEFORE the runtime call that removes the executor (review 8 #7): the removal is still
   * held by `token` and nothing voided it (as `confirmDeletion`), and it becomes
   * `deleting-issued` in the same transaction — from then on it stays exclusionary until its
   * issuer records the outcome or the runtime is inspected (`reconcileIssuedDeletion`), whatever
   * becomes of its hold. A removal taken over as issued already (`reissue`) is issued again while
   * `token` holds it. Renews the hold. `false`: nothing may be called — decide again.
   */
  readonly issueDeletion: (input: {
    readonly runId: string;
    readonly token: string;
    readonly leaseMs: number;
  }) => Effect.Effect<boolean, WorkspaceCaptureDrainRepoError>;
  /**
   * Settle an issued removal whose issuer's hold lapsed, from what the runtime says of the
   * executor now (review 8 #7). `gone`: it was carried out — `deleted`. `present`: not carried
   * out YET — it failed, never reached the runtime, or is still on its way (review 9 #5: presence
   * proves only that it has not finished). While the evidence it was authorized on is still the
   * current version with no observation in flight, that authorization stands: it is taken over by
   * `token` (fresh hold, still `deleting-issued`) and issued again (`reissue`). Otherwise the
   * evidence changed since, and the executor must be kept — but the earlier request may still
   * act, so the removal stays issued and exclusionary (`outstanding`: nothing is observed or
   * recovered) until the runtime's own bound on a removal request (`fenceMs`, the adapter's
   * `removalFenceMs`) has passed since it was last issued; only then is it given up (`released`,
   * the evidence version bumped) and decided again on what is current. No `fenceMs`: the runtime
   * gives no such bound, and it stays `outstanding` until the runtime no longer has the executor
   * or the evidence stands again. `held`: its issuer holds it again (or someone took it over);
   * `none`: nothing issued is left to settle; `deleted` also when it was recorded removed
   * meanwhile.
   */
  readonly reconcileIssuedDeletion: (input: {
    readonly runId: string;
    readonly runtime: "gone" | "present";
    readonly token: string;
    readonly leaseMs: number;
    readonly fenceMs?: number | undefined;
  }) => Effect.Effect<
    "deleted" | "reissue" | "released" | "outstanding" | "held" | "none",
    WorkspaceCaptureDrainRepoError
  >;
  /**
   * The runtime removed the executor: the row is `deleted` for good (nothing is observed or
   * recovered again). Written whether or not `token` still held it — the removal happened —
   * and answers whether it did.
   */
  readonly completeDeletion: (input: {
    readonly runId: string;
    readonly token: string;
  }) => Effect.Effect<boolean, WorkspaceCaptureDrainRepoError>;
  /**
   * Give a held removal up: it was not made, or the runtime definitively refused it (it answered
   * and did not act). Observations resume. Never for a call whose outcome is unknown
   * (`lapseIssuedDeletion`).
   */
  readonly releaseDeletion: (input: {
    readonly runId: string;
    readonly token: string;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  /**
   * The runtime call of the issued removal `token` holds ended with an outcome nobody knows (a
   * transport error after the request may have gone out; review 9 #5): it stays `deleting-issued`
   * and exclusionary, its hold ends now, and whoever finds it settles it from the runtime
   * (`reconcileIssuedDeletion`).
   */
  readonly lapseIssuedDeletion: (input: {
    readonly runId: string;
    readonly token: string;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  /**
   * May recovery start the run's executor? `deleting`: a live removal holds it, or one was issued
   * (`deleting-issued`, whatever its hold: only inspecting the runtime settles it); `deleted`: it
   * was removed. A removal not yet issued whose hold lapsed is voided (and the evidence version
   * bumped, so its deleter decides again) and recovery is `admitted`.
   */
  readonly admitRecovery: (input: {
    readonly runId: string;
  }) => Effect.Effect<"admitted" | "deleting" | "deleted", WorkspaceCaptureDrainRepoError>;
  /**
   * Record the owner's request to discard the run's unsaved captures (the audit): the first
   * request's instant and requester stand. Returns the row.
   */
  readonly requestDiscard: (input: {
    readonly runId: string;
    readonly requestedBy: string;
  }) => Effect.Effect<WorkspaceCaptureDrain, WorkspaceCaptureDrainRepoError>;
  /**
   * Record the control plane's attestation that its store holds a sealed FINAL of the run's
   * executor (the latest stands). Returns the row.
   */
  readonly attestCompletion: (input: {
    readonly runId: string;
    readonly executorId: string;
    readonly epoch: number;
    readonly captureN: number;
    readonly attestedBy: string;
    /** The launch identity the attestation named (already matched to the run's). */
    readonly launchId?: string;
    /** When the attesting store recorded the seal, when the attestation said (display only). */
    readonly sealedAt?: Date;
    /** The seal's executor-origin position, when the attestation carried it. */
    readonly origin?: Readonly<Record<string, unknown>>;
  }) => Effect.Effect<WorkspaceCaptureDrain, WorkspaceCaptureDrainRepoError>;
  /**
   * Record that the run's executor is retained (its disk holds work not confirmed saved): the
   * first instant stands, the reason is the latest, and recovery is due at once if not scheduled.
   * The observation reads `kept` with the reason.
   */
  readonly markRetained: (input: {
    readonly runId: string;
    readonly reason: string;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  /**
   * Retained executors whose next recovery attempt is due and that nobody is recovering now (no
   * live recovery lease): the one whose runtime ends soonest first (its platform deadline, review
   * 9 #8), then the most overdue.
   */
  readonly listRetainedDue: (input: {
    readonly limit: number;
    /** Only these runs (executors just recorded retained); absent = every due retention. */
    readonly runIds?: readonly string[];
  }) => Effect.Effect<readonly WorkspaceCaptureDrain[], WorkspaceCaptureDrainRepoError>;
  /**
   * Take the recovery of the run's retained executor for one attempt (review 9 #8): held by
   * `token` for `leaseMs` of database time, when nobody holds it (or its holder's lease lapsed).
   * `false`: another attempt is under way (or it is not retained).
   */
  readonly claimRecovery: (input: {
    readonly runId: string;
    readonly token: string;
    readonly leaseMs: number;
  }) => Effect.Effect<boolean, WorkspaceCaptureDrainRepoError>;
  /** The attempt `token` held ended: its lease is released (fenced on the token). */
  readonly releaseRecovery: (input: {
    readonly runId: string;
    readonly token: string;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  /** One recovery attempt happened: count it, keep its error (or clear it), schedule the next. */
  readonly recordRecoveryAttempt: (input: {
    readonly runId: string;
    readonly error: string | null;
    readonly nextRecoveryAt: Date;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  /**
   * Make a retained executor's recovery due now (the owner asked). Returns the row, or
   * `undefined` when the run's executor is not retained.
   */
  readonly requestRecovery: (
    runId: string,
  ) => Effect.Effect<WorkspaceCaptureDrain | undefined, WorkspaceCaptureDrainRepoError>;
  /** Keep the sealed capture token of the run's executor, for its recovery. */
  readonly storeCaptureToken: (input: {
    readonly runId: string;
    readonly sealed: string;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  /** Persist the deadline sweep's schedule and throughput sample; the lease is untouched. */
  readonly recordSchedule: (input: {
    readonly runId: string;
    readonly schedule: WorkspaceCaptureDrainSchedule;
  }) => Effect.Effect<WorkspaceCaptureDrain, WorkspaceCaptureDrainRepoError>;
}

export class WorkspaceCaptureDrainRepo extends Context.Service<
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoService
>()("WorkspaceCaptureDrainRepo") {}

const leaseExpiry = (leaseMs: number) =>
  sql`now() + (${Math.max(0, Math.round(leaseMs))} * interval '1 millisecond')`;

/** The columns of no removal: what voiding or releasing one writes. */
const NO_DELETION = {
  deletionState: null,
  deletionToken: null,
  deletionEvidenceVersion: null,
  deletionAuthorizedAt: null,
  deletionExpiresAt: null,
  deletionIssuedAt: null,
} as const;

/** The removal state under the row lock, with whether its hold is still live (database clock). */
const deletionColumns = {
  deletionState: workspaceCaptureDrains.deletionState,
  deletionToken: workspaceCaptureDrains.deletionToken,
  deletionEvidenceVersion: workspaceCaptureDrains.deletionEvidenceVersion,
  deletionLive: sql<boolean>`coalesce(${workspaceCaptureDrains.deletionExpiresAt} > now(), false)`,
};

/** The removal state, the evidence version and the fences (select under the row lock). */
const lockedDeletionColumns = {
  evidenceVersion: workspaceCaptureDrains.evidenceVersion,
  observationFences: workspaceCaptureDrains.observationFences,
  ...deletionColumns,
};

/** The evidence a removal was authorized on is still the current version, none in flight. */
const deletionEvidenceCurrent = (current: {
  readonly evidenceVersion: number;
  readonly deletionEvidenceVersion: number | null;
  readonly observationFences: Readonly<Record<string, unknown>>;
}): boolean =>
  current.deletionEvidenceVersion === current.evidenceVersion &&
  Object.keys(current.observationFences).length === 0;

const progressColumns = (progress: WorkspaceCaptureDrainProgress) => ({
  ...(progress.state === undefined ? {} : { state: progress.state }),
  ...(progress.detail === undefined ? {} : { detail: progress.detail }),
  ...(progress.lastProgressAt === undefined ? {} : { lastProgressAt: progress.lastProgressAt }),
  ...(progress.unreachableSince === undefined
    ? {}
    : { unreachableSince: progress.unreachableSince }),
  ...(progress.keptLogged === undefined ? {} : { keptLogged: progress.keptLogged }),
  ...(progress.silentLogged === undefined ? {} : { silentLogged: progress.silentLogged }),
  ...(progress.observedAt === undefined ? {} : { observedAt: progress.observedAt }),
});

export const WorkspaceCaptureDrainRepoLive: Layer.Layer<
  WorkspaceCaptureDrainRepo,
  never,
  SealantDB
> = Layer.effect(
  WorkspaceCaptureDrainRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      claimLease: (input) =>
        withRepoError(
          "claimLease",
          Effect.gen(function* () {
            const [row] = yield* db
              .insert(workspaceCaptureDrains)
              .values({
                runId: input.runId,
                leaseOwner: input.owner,
                leaseExpiresAt: leaseExpiry(input.leaseMs),
              })
              .onConflictDoUpdate({
                target: workspaceCaptureDrains.runId,
                set: { leaseOwner: input.owner, leaseExpiresAt: leaseExpiry(input.leaseMs) },
                // Free, expired (its worker died), or already ours; a live lease of another
                // owner updates nothing and the insert returns no row.
                setWhere: sql`(${or(
                  isNull(workspaceCaptureDrains.leaseOwner),
                  isNull(workspaceCaptureDrains.leaseExpiresAt),
                  lte(workspaceCaptureDrains.leaseExpiresAt, sql`now()`),
                  eq(workspaceCaptureDrains.leaseOwner, input.owner),
                )})`,
              })
              .returning();
            return row;
          }),
        ),

      recordProgress: (input) =>
        withRepoError(
          "recordProgress",
          Effect.gen(function* () {
            const [row] = yield* db
              .update(workspaceCaptureDrains)
              .set({
                ...progressColumns(input.progress),
                leaseExpiresAt: leaseExpiry(input.leaseMs),
              })
              .where(
                and(
                  eq(workspaceCaptureDrains.runId, input.runId),
                  eq(workspaceCaptureDrains.leaseOwner, input.owner),
                ),
              )
              .returning();
            return row;
          }),
        ),

      releaseLease: (input) =>
        withRepoError(
          "releaseLease",
          db
            .update(workspaceCaptureDrains)
            .set({ leaseOwner: null, leaseExpiresAt: null })
            .where(
              and(
                eq(workspaceCaptureDrains.runId, input.runId),
                eq(workspaceCaptureDrains.leaseOwner, input.owner),
              ),
            )
            .pipe(Effect.asVoid),
        ),

      getByRunId: (runId) =>
        withRepoError(
          "getByRunId",
          Effect.gen(function* () {
            const [row] = yield* db
              .select()
              .from(workspaceCaptureDrains)
              .where(eq(workspaceCaptureDrains.runId, runId))
              .limit(1);
            return row;
          }),
        ),

      listByRunIds: (runIds) =>
        withRepoError(
          "listByRunIds",
          Effect.gen(function* () {
            if (runIds.length === 0) {
              return new Map<string, WorkspaceCaptureDrain>();
            }
            const rows = yield* db
              .select()
              .from(workspaceCaptureDrains)
              .where(inArray(workspaceCaptureDrains.runId, [...runIds]));
            return new Map(rows.map((row: WorkspaceCaptureDrain) => [row.runId, row] as const));
          }),
        ),

      recordObservation: (input) =>
        withRepoError(
          "recordObservation",
          Effect.gen(function* () {
            // The executor was removed (or found gone): nothing is retained any more.
            const endsRetention =
              input.state === "stopped" || input.state === "discarded" || input.state === "gone";
            const set = {
              state: input.state,
              detail: input.detail,
              observedAt: new Date(),
              ...(endsRetention
                ? { retainedAt: null, nextRecoveryAt: null, captureTokenSealed: null }
                : {}),
            };
            yield* db
              .insert(workspaceCaptureDrains)
              .values({ runId: input.runId, ...set } satisfies NewWorkspaceCaptureDrain)
              .onConflictDoUpdate({ target: workspaceCaptureDrains.runId, set });
          }),
        ),

      openObservation: (input) =>
        withRepoError(
          "openObservation",
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(workspaceCaptureDrains)
                .values({ runId: input.runId } satisfies NewWorkspaceCaptureDrain)
                .onConflictDoNothing();
              const [current] = yield* tx
                .select(deletionColumns)
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, input.runId))
                .for("update");
              if (current === undefined) {
                return yield* Effect.fail(
                  new Error(`Opening an observation of run ${input.runId} found no row.`),
                );
              }
              if (current.deletionState === "deleted") {
                return { refused: "deleted" as const };
              }
              // An issued removal is refused whatever its hold: the runtime may still carry it
              // out, and nothing asked now could stop it (review 8 #7).
              if (
                current.deletionState === "deleting-issued" ||
                (current.deletionState === "deleting" && current.deletionLive)
              ) {
                return { refused: "deleting" as const };
              }
              const fence = sql`jsonb_build_object(${input.token}::text, jsonb_build_object('openedAt', now(), 'expiresAt', now() + (${Math.max(
                0,
                Math.round(input.ttlMs),
              )} * interval '1 millisecond')))`;
              const [row] = yield* tx
                .update(workspaceCaptureDrains)
                .set({
                  observationFences: sql`${workspaceCaptureDrains.observationFences} || ${fence}`,
                  evidenceVersion: sql`${workspaceCaptureDrains.evidenceVersion} + 1`,
                  // A removal whose hold lapsed (its deleter died) is voided by what it admits.
                  ...(current.deletionState === "deleting" ? NO_DELETION : {}),
                })
                .where(eq(workspaceCaptureDrains.runId, input.runId))
                .returning({
                  openedAt: sql<string>`${workspaceCaptureDrains.observationFences} -> ${input.token}::text ->> 'openedAt'`,
                });
              if (row === undefined) {
                return yield* Effect.fail(
                  new Error(`Opening an observation of run ${input.runId} wrote no row.`),
                );
              }
              return { openedAt: new Date(row.openedAt) };
            }),
          ),
        ),

      closeObservation: (input) =>
        withRepoError(
          "closeObservation",
          db
            .update(workspaceCaptureDrains)
            .set({
              observationFences: sql`${workspaceCaptureDrains.observationFences} - ${input.token}::text`,
              evidenceVersion: sql`${workspaceCaptureDrains.evidenceVersion} + 1`,
            })
            .where(eq(workspaceCaptureDrains.runId, input.runId))
            .pipe(Effect.asVoid),
        ),

      recordStatus: (input) =>
        withRepoError(
          "recordStatus",
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(workspaceCaptureDrains)
                .values({ runId: input.runId } satisfies NewWorkspaceCaptureDrain)
                .onConflictDoNothing();
              const fences = workspaceCaptureDrains.observationFences;
              // When this answer's request was sent (the database's clock), from its fence; a
              // fence already resolved by a later observation leaves it unknown (null).
              const openedAt =
                input.fence === undefined
                  ? sql`now()`
                  : sql`(${fences} -> ${input.fence}::text ->> 'openedAt')::timestamptz`;
              const [current] = yield* tx
                .select({
                  lastStatus: workspaceCaptureDrains.lastStatus,
                  unsavedStatuses: workspaceCaptureDrains.unsavedStatuses,
                  deletionState: workspaceCaptureDrains.deletionState,
                  causallyAfter: sql<boolean>`coalesce(${workspaceCaptureDrains.lastStatusRecordedAt} IS NULL OR ${openedAt} > ${workspaceCaptureDrains.lastStatusRecordedAt}, false)`,
                  // The same instants in microseconds (the database's clock), for the unsaved
                  // answers on record, which each keep when they were recorded.
                  lastRecordedAtUs: sql<
                    string | null
                  >`(extract(epoch FROM ${workspaceCaptureDrains.lastStatusRecordedAt}) * 1000000)::bigint::text`,
                  askedAtUs: sql<
                    string | null
                  >`(extract(epoch FROM ${openedAt}) * 1000000)::bigint::text`,
                  nowUs: sql<string>`(extract(epoch FROM now()) * 1000000)::bigint::text`,
                })
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, input.runId))
                .for("update");
              if (current === undefined) {
                return yield* Effect.fail(
                  new Error(`Recording a status of run ${input.runId} found no row.`),
                );
              }
              const replaces = statusSupersedes({
                stored: current.lastStatus,
                incoming: input.status,
                causallyAfter: current.causallyAfter,
              });
              // Every unsaved answer no later one covers stays on record, whichever status is
              // the latest (review 9 #4, decision 25).
              const microseconds = (value: string | null): number | null =>
                value === null ? null : Number(value);
              const unsaved = nextUnsavedObservations({
                unsaved: current.unsavedStatuses,
                stored: current.lastStatus,
                storedRecordedAt: microseconds(current.lastRecordedAtUs),
                incoming: input.status,
                askedAt: microseconds(current.askedAtUs),
                recordedAt: Number(current.nowUs),
              });
              // This fence resolves, and so does every fence that lapsed before it was opened:
              // this answer was asked for after their owners could still be waiting on theirs.
              const remaining =
                input.fence === undefined
                  ? sql`${fences}`
                  : sql`(SELECT coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb) FROM jsonb_each(${fences}) AS f(key, value) WHERE f.key <> ${input.fence}::text AND coalesce((f.value ->> 'expiresAt')::timestamptz >= ${openedAt}, true))`;
              yield* tx
                .update(workspaceCaptureDrains)
                .set({
                  observationFences: remaining,
                  unsavedStatuses: unsaved,
                  evidenceVersion: sql`${workspaceCaptureDrains.evidenceVersion} + 1`,
                  // Received evidence outranks a removal decided before it: voided (decision 21).
                  // One already issued cannot be: it stays until its outcome is known, and the
                  // bumped version keeps it from being issued again on the old evidence.
                  ...(current.deletionState === "deleting" ? NO_DELETION : {}),
                  ...(replaces
                    ? {
                        lastStatus: input.status,
                        lastStatusAt: input.observedAt,
                        lastStatusRecordedAt: sql`now()`,
                      }
                    : {}),
                })
                .where(eq(workspaceCaptureDrains.runId, input.runId));
              return replaces;
            }),
          ),
        ),

      authorizeDeletion: (input) =>
        withRepoError(
          "authorizeDeletion",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [current] = yield* tx
                .select({
                  evidenceVersion: workspaceCaptureDrains.evidenceVersion,
                  observationFences: workspaceCaptureDrains.observationFences,
                  ...deletionColumns,
                })
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, input.runId))
                .for("update");
              if (current === undefined) {
                return "changed" as const;
              }
              if (current.deletionState === "deleted") {
                return "deleted" as const;
              }
              if (current.deletionState === "deleting-issued") {
                // Issued: never re-authorized over. Its issuer still holds it, or nobody knows
                // whether the runtime carried it out until it is inspected (review 8 #7).
                return current.deletionLive ? ("held" as const) : ("unresolved" as const);
              }
              if (
                current.deletionState === "deleting" &&
                current.deletionLive &&
                current.deletionToken !== input.token
              ) {
                return "held" as const;
              }
              if (
                current.evidenceVersion !== input.evidenceVersion ||
                Object.keys(current.observationFences).length > 0
              ) {
                return "changed" as const;
              }
              yield* tx
                .update(workspaceCaptureDrains)
                .set({
                  deletionState: "deleting",
                  deletionToken: input.token,
                  deletionEvidenceVersion: input.evidenceVersion,
                  deletionAuthorizedAt: sql`now()`,
                  deletionExpiresAt: leaseExpiry(input.leaseMs),
                })
                .where(eq(workspaceCaptureDrains.runId, input.runId));
              return "authorized" as const;
            }),
          ),
        ),

      confirmDeletion: (input) =>
        withRepoError(
          "confirmDeletion",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [current] = yield* tx
                .select(lockedDeletionColumns)
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, input.runId))
                .for("update");
              if (current === undefined || current.deletionToken !== input.token) {
                return false;
              }
              if (
                current.deletionState !== "deleting-issued" &&
                !(current.deletionState === "deleting" && deletionEvidenceCurrent(current))
              ) {
                return false;
              }
              yield* tx
                .update(workspaceCaptureDrains)
                .set({ deletionExpiresAt: leaseExpiry(input.leaseMs) })
                .where(eq(workspaceCaptureDrains.runId, input.runId));
              return true;
            }),
          ),
        ),

      issueDeletion: (input) =>
        withRepoError(
          "issueDeletion",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [current] = yield* tx
                .select(lockedDeletionColumns)
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, input.runId))
                .for("update");
              if (current === undefined || current.deletionToken !== input.token) {
                return false;
              }
              if (
                current.deletionState !== "deleting-issued" &&
                !(current.deletionState === "deleting" && deletionEvidenceCurrent(current))
              ) {
                return false;
              }
              yield* tx
                .update(workspaceCaptureDrains)
                .set({
                  deletionState: "deleting-issued",
                  deletionExpiresAt: leaseExpiry(input.leaseMs),
                  deletionIssuedAt: sql`now()`,
                })
                .where(eq(workspaceCaptureDrains.runId, input.runId));
              return true;
            }),
          ),
        ),

      reconcileIssuedDeletion: (input) =>
        withRepoError(
          "reconcileIssuedDeletion",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const fenceMs = input.fenceMs;
              const [current] = yield* tx
                .select({
                  ...lockedDeletionColumns,
                  // The runtime's bound on a removal request has passed since it was last
                  // issued: nothing that request sent can still act (review 9 #5).
                  fenced:
                    fenceMs === undefined
                      ? sql<boolean>`false`
                      : sql<boolean>`coalesce(${workspaceCaptureDrains.deletionIssuedAt} + (${Math.max(0, Math.round(fenceMs))} * interval '1 millisecond') <= now(), false)`,
                })
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, input.runId))
                .for("update");
              if (current?.deletionState === "deleted") {
                return "deleted" as const;
              }
              if (current === undefined || current.deletionState !== "deleting-issued") {
                return "none" as const;
              }
              if (current.deletionLive) {
                return "held" as const;
              }
              if (input.runtime === "gone") {
                yield* tx
                  .update(workspaceCaptureDrains)
                  .set({
                    deletionState: "deleted",
                    deletionExpiresAt: null,
                    evidenceVersion: sql`${workspaceCaptureDrains.evidenceVersion} + 1`,
                  })
                  .where(eq(workspaceCaptureDrains.runId, input.runId));
                return "deleted" as const;
              }
              if (deletionEvidenceCurrent(current)) {
                // The evidence it was authorized on still stands: taken over, issued again.
                yield* tx
                  .update(workspaceCaptureDrains)
                  .set({
                    deletionToken: input.token,
                    deletionExpiresAt: leaseExpiry(input.leaseMs),
                  })
                  .where(eq(workspaceCaptureDrains.runId, input.runId));
                return "reissue" as const;
              }
              if (!current.fenced) {
                // The evidence changed, so it may not be issued again; but the request already
                // sent may still act, so it stays issued: nothing observed, nothing recovered.
                return "outstanding" as const;
              }
              yield* tx
                .update(workspaceCaptureDrains)
                .set({
                  ...NO_DELETION,
                  evidenceVersion: sql`${workspaceCaptureDrains.evidenceVersion} + 1`,
                })
                .where(eq(workspaceCaptureDrains.runId, input.runId));
              return "released" as const;
            }),
          ),
        ),

      completeDeletion: (input) =>
        withRepoError(
          "completeDeletion",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [current] = yield* tx
                .select(deletionColumns)
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, input.runId))
                .for("update");
              const held =
                current !== undefined &&
                (current.deletionState === "deleting" ||
                  current.deletionState === "deleting-issued") &&
                current.deletionToken === input.token;
              yield* tx
                .update(workspaceCaptureDrains)
                .set({
                  deletionState: "deleted",
                  deletionToken: input.token,
                  deletionExpiresAt: null,
                  evidenceVersion: sql`${workspaceCaptureDrains.evidenceVersion} + 1`,
                })
                .where(eq(workspaceCaptureDrains.runId, input.runId));
              return held;
            }),
          ),
        ),

      releaseDeletion: (input) =>
        withRepoError(
          "releaseDeletion",
          db
            .update(workspaceCaptureDrains)
            .set(NO_DELETION)
            .where(
              and(
                eq(workspaceCaptureDrains.runId, input.runId),
                inArray(workspaceCaptureDrains.deletionState, ["deleting", "deleting-issued"]),
                eq(workspaceCaptureDrains.deletionToken, input.token),
              ),
            )
            .pipe(Effect.asVoid),
        ),

      lapseIssuedDeletion: (input) =>
        withRepoError(
          "lapseIssuedDeletion",
          db
            .update(workspaceCaptureDrains)
            .set({ deletionExpiresAt: sql`now()` })
            .where(
              and(
                eq(workspaceCaptureDrains.runId, input.runId),
                eq(workspaceCaptureDrains.deletionState, "deleting-issued"),
                eq(workspaceCaptureDrains.deletionToken, input.token),
              ),
            )
            .pipe(Effect.asVoid),
        ),

      admitRecovery: (input) =>
        withRepoError(
          "admitRecovery",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [current] = yield* tx
                .select(deletionColumns)
                .from(workspaceCaptureDrains)
                .where(eq(workspaceCaptureDrains.runId, input.runId))
                .for("update");
              if (current === undefined || current.deletionState === null) {
                return "admitted" as const;
              }
              if (current.deletionState === "deleted") {
                return "deleted" as const;
              }
              if (current.deletionState === "deleting-issued" || current.deletionLive) {
                return "deleting" as const;
              }
              // Its deleter's hold lapsed before it issued anything: voided, and its deleter
              // decides again.
              yield* tx
                .update(workspaceCaptureDrains)
                .set({
                  ...NO_DELETION,
                  evidenceVersion: sql`${workspaceCaptureDrains.evidenceVersion} + 1`,
                })
                .where(eq(workspaceCaptureDrains.runId, input.runId));
              return "admitted" as const;
            }),
          ),
        ),

      attestCompletion: (input) =>
        withRepoError(
          "attestCompletion",
          Effect.gen(function* () {
            const columns = {
              completionExecutorId: input.executorId,
              completionEpoch: input.epoch,
              completionCaptureN: input.captureN,
              completionAttestedAt: new Date(),
              completionAttestedBy: input.attestedBy,
              completionLaunchId: input.launchId ?? null,
              completionSealedAt: input.sealedAt ?? null,
              completionOrigin: input.origin ?? null,
            };
            const [row] = yield* db
              .insert(workspaceCaptureDrains)
              .values({ runId: input.runId, ...columns } satisfies NewWorkspaceCaptureDrain)
              .onConflictDoUpdate({
                target: workspaceCaptureDrains.runId,
                set: {
                  ...columns,
                  evidenceVersion: sql`${workspaceCaptureDrains.evidenceVersion} + 1`,
                },
              })
              .returning();
            if (row === undefined) {
              return yield* Effect.fail(
                new Error(
                  `Recording the completion attestation of run ${input.runId} wrote no row.`,
                ),
              );
            }
            return row;
          }),
        ),

      markRetained: (input) =>
        withRepoError(
          "markRetained",
          Effect.gen(function* () {
            const detail = `not saved · retained · ${input.reason}`;
            yield* db
              .insert(workspaceCaptureDrains)
              .values({
                runId: input.runId,
                retainedAt: new Date(),
                retainedReason: input.reason,
                nextRecoveryAt: new Date(),
                state: "kept",
                detail,
                observedAt: new Date(),
              } satisfies NewWorkspaceCaptureDrain)
              .onConflictDoUpdate({
                target: workspaceCaptureDrains.runId,
                set: {
                  retainedAt: sql`coalesce(${workspaceCaptureDrains.retainedAt}, now())`,
                  retainedReason: input.reason,
                  nextRecoveryAt: sql`coalesce(${workspaceCaptureDrains.nextRecoveryAt}, now())`,
                  state: "kept",
                  detail,
                  observedAt: new Date(),
                },
              });
          }),
        ),

      listRetainedDue: (input) =>
        withRepoError(
          "listRetainedDue",
          db
            .select({ drain: workspaceCaptureDrains })
            .from(workspaceCaptureDrains)
            .leftJoin(
              workspaceRuntimeInstances,
              eq(workspaceRuntimeInstances.runId, workspaceCaptureDrains.runId),
            )
            .where(
              and(
                isNotNull(workspaceCaptureDrains.retainedAt),
                or(
                  isNull(workspaceCaptureDrains.nextRecoveryAt),
                  lte(workspaceCaptureDrains.nextRecoveryAt, sql`now()`),
                ),
                or(
                  isNull(workspaceCaptureDrains.recoveryLeaseUntil),
                  lte(workspaceCaptureDrains.recoveryLeaseUntil, sql`now()`),
                ),
                ...(input.runIds === undefined
                  ? []
                  : [inArray(workspaceCaptureDrains.runId, [...input.runIds])]),
              ),
            )
            // The runtime that ends soonest first, whatever its backoff said (review 9 #8).
            .orderBy(
              sql`${workspaceRuntimeInstances.runtimeDeadlineAt} ASC NULLS LAST`,
              asc(workspaceCaptureDrains.nextRecoveryAt),
            )
            .limit(Math.max(1, Math.round(input.limit)))
            .pipe(
              Effect.map((rows: readonly { readonly drain: WorkspaceCaptureDrain }[]) =>
                rows.map((row) => row.drain),
              ),
            ),
        ),

      claimRecovery: (input) =>
        withRepoError(
          "claimRecovery",
          Effect.gen(function* () {
            const [row] = yield* db
              .update(workspaceCaptureDrains)
              .set({
                recoveryLeaseToken: input.token,
                recoveryLeaseUntil: leaseExpiry(input.leaseMs),
              })
              .where(
                and(
                  eq(workspaceCaptureDrains.runId, input.runId),
                  isNotNull(workspaceCaptureDrains.retainedAt),
                  or(
                    isNull(workspaceCaptureDrains.recoveryLeaseUntil),
                    lte(workspaceCaptureDrains.recoveryLeaseUntil, sql`now()`),
                    eq(workspaceCaptureDrains.recoveryLeaseToken, input.token),
                  ),
                ),
              )
              .returning({ runId: workspaceCaptureDrains.runId });
            return row !== undefined;
          }),
        ),

      releaseRecovery: (input) =>
        withRepoError(
          "releaseRecovery",
          db
            .update(workspaceCaptureDrains)
            .set({ recoveryLeaseToken: null, recoveryLeaseUntil: null })
            .where(
              and(
                eq(workspaceCaptureDrains.runId, input.runId),
                eq(workspaceCaptureDrains.recoveryLeaseToken, input.token),
              ),
            )
            .pipe(Effect.asVoid),
        ),

      recordRecoveryAttempt: (input) =>
        withRepoError(
          "recordRecoveryAttempt",
          db
            .update(workspaceCaptureDrains)
            .set({
              recoveryAttempts: sql`${workspaceCaptureDrains.recoveryAttempts} + 1`,
              lastRecoveryError: input.error,
              nextRecoveryAt: input.nextRecoveryAt,
            })
            .where(
              and(
                eq(workspaceCaptureDrains.runId, input.runId),
                isNotNull(workspaceCaptureDrains.retainedAt),
              ),
            )
            .pipe(Effect.asVoid),
        ),

      storeCaptureToken: (input) =>
        withRepoError(
          "storeCaptureToken",
          db
            .insert(workspaceCaptureDrains)
            .values({
              runId: input.runId,
              captureTokenSealed: input.sealed,
            } satisfies NewWorkspaceCaptureDrain)
            .onConflictDoUpdate({
              target: workspaceCaptureDrains.runId,
              set: { captureTokenSealed: input.sealed },
            })
            .pipe(Effect.asVoid),
        ),

      requestRecovery: (runId) =>
        withRepoError(
          "requestRecovery",
          Effect.gen(function* () {
            const [row] = yield* db
              .update(workspaceCaptureDrains)
              .set({ nextRecoveryAt: sql`now()` })
              .where(
                and(
                  eq(workspaceCaptureDrains.runId, runId),
                  isNotNull(workspaceCaptureDrains.retainedAt),
                ),
              )
              .returning();
            return row;
          }),
        ),

      requestDiscard: (input) =>
        withRepoError(
          "requestDiscard",
          Effect.gen(function* () {
            yield* db
              .insert(workspaceCaptureDrains)
              .values({
                runId: input.runId,
                discardRequestedAt: new Date(),
                discardRequestedBy: input.requestedBy,
              } satisfies NewWorkspaceCaptureDrain)
              .onConflictDoUpdate({
                target: workspaceCaptureDrains.runId,
                // The first request stands: the audit never moves.
                set: {
                  discardRequestedAt: sql`coalesce(${workspaceCaptureDrains.discardRequestedAt}, now())`,
                  discardRequestedBy: sql`coalesce(${workspaceCaptureDrains.discardRequestedBy}, ${input.requestedBy})`,
                },
              });
            const [row] = yield* db
              .select()
              .from(workspaceCaptureDrains)
              .where(eq(workspaceCaptureDrains.runId, input.runId))
              .limit(1);
            if (row === undefined) {
              return yield* Effect.fail(
                new Error(`Recording the discard of run ${input.runId} wrote no row.`),
              );
            }
            return row;
          }),
        ),

      recordSchedule: (input) =>
        withRepoError(
          "recordSchedule",
          Effect.gen(function* () {
            const columns = {
              preservationStartsAt: input.schedule.preservationStartsAt,
              ...(input.schedule.uploadBytesPerSecond === undefined
                ? {}
                : { uploadBytesPerSecond: input.schedule.uploadBytesPerSecond }),
              ...(input.schedule.uploadSampleBytes === undefined
                ? {}
                : { uploadSampleBytes: input.schedule.uploadSampleBytes }),
              ...(input.schedule.uploadSampledAt === undefined
                ? {}
                : { uploadSampledAt: input.schedule.uploadSampledAt }),
            };
            const [row] = yield* db
              .insert(workspaceCaptureDrains)
              .values({ runId: input.runId, ...columns } satisfies NewWorkspaceCaptureDrain)
              .onConflictDoUpdate({ target: workspaceCaptureDrains.runId, set: columns })
              .returning();
            if (row === undefined) {
              return yield* Effect.fail(
                new Error(
                  `Recording the preservation schedule of run ${input.runId} wrote no row.`,
                ),
              );
            }
            return row;
          }),
        ),
    } satisfies WorkspaceCaptureDrainRepoService;
  }),
);
